import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { claimDeposits, recordDepositResult, validateClaimInput, validateResultInput } from "../lib/cash-deposits.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base PostgreSQL jetable)");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });
async function tx<T>(tenantId: string, fn: (client: any) => Promise<T>): Promise<T> {
  return prisma.$transaction(async client => {
    await client.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(client);
  }, { maxWait: 10000, timeout: 20000 });
}
async function rawDeposit(tenantId: string, actionId: string, deviceId: string, formatVersion: number | null, sequence: number, dependsOn: unknown[] = []) {
  return tx(tenantId, c => c.$executeRaw`INSERT INTO "CashDeposit" ("tenantId","actionId","deviceId","kind","payload","dependsOn","payloadHash","formatVersion","sequence") VALUES (${tenantId}::uuid,${actionId}::uuid,${deviceId},'SALE','{}'::jsonb,${JSON.stringify(dependsOn)}::jsonb,'hash',${formatVersion},${sequence})`);
}

test("le rôle de recette est sans BYPASSRLS", async () => {
  const roles = await prisma.$queryRaw<any[]>`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname=current_user`;
  assert.equal(roles[0]?.bypass, false, "les vérifications RLS exigent un rôle non privilégié");
});

test("claims concurrentes sont exclusifs; résultat avec ancien token = LEASE_LOST sans écriture", async () => {
  const tenantId = randomUUID(), actionId = randomUUID();
  try {
    await rawDeposit(tenantId, actionId, "tablet", 2, 0);
    const claims = await Promise.all([
      tx(tenantId, c => claimDeposits(c, validateClaimInput({ tenantId, holder: "worker-a", leaseSeconds: 30, limit: 10 }))),
      tx(tenantId, c => claimDeposits(c, validateClaimInput({ tenantId, holder: "worker-b", leaseSeconds: 30, limit: 10 }))),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.filter(x => x === null).length, 1, "null est traduit en LEASE_HELD par la route");
    const first = claims.find(Boolean)!;
    const renewed = await tx(tenantId, c => claimDeposits(c, validateClaimInput({ tenantId, holder: claims[0] ? "worker-a" : "worker-b", leaseSeconds: 30, limit: 10 })));
    assert.ok(renewed);
    assert.notEqual(renewed.token, first.token);
    const input = validateResultInput({ tenantId, token: first.token, actionId, outcome: "REFUSED", code: "OLD", reason: "stale" });
    const outcome = await tx(tenantId, c => recordDepositResult(c, input));
    assert.deepEqual(outcome, { error: "LEASE_LOST" });
    const deposit = await tx(tenantId, c => c.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } }));
    const snapshot = { ...deposit };
    assert.deepEqual(await tx(tenantId, c => recordDepositResult(c, input)), { error: "LEASE_LOST" });
    assert.deepEqual(await tx(tenantId, c => c.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } })), snapshot);
    assert.equal(deposit.attempts, 0); assert.equal(deposit.lastResultCode, null);
    const currentToken = renewed!.token;
    for (const resultOutcome of ["REFUSED", "WAITING"] as const) {
      await tx(tenantId, c => recordDepositResult(c, validateResultInput({ tenantId, token: currentToken, actionId, outcome: resultOutcome, code: "RETRY", reason: "replay" })));
    }
    const retried = await tx(tenantId, c => c.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } }));
    assert.equal(retried.attempts, 2); assert.equal(retried.lastResultCode, "RETRY"); assert.equal(retried.status, "PENDING");
    const appliedInput = validateResultInput({ tenantId, token: currentToken, actionId, outcome: "APPLIED", code: "OK", reason: "", result: { receipt: "synthetic" } });
    const applied = await tx(tenantId, c => recordDepositResult(c, appliedInput));
    assert.equal(applied.status, "APPLIED"); assert.deepEqual(applied.resultJson, { receipt: "synthetic" });
    const idempotent = await tx(tenantId, c => recordDepositResult(c, appliedInput));
    assert.deepEqual(idempotent, applied);
    const persisted = await tx(tenantId, c => c.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } }));
    await tx(tenantId, c => recordDepositResult(c, { ...appliedInput, result: { receipt: "different" } }));
    assert.deepEqual(await tx(tenantId, c => c.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } })), persisted);
  } finally {
    await tx(tenantId, c => c.$executeRaw`DELETE FROM "CashDepositLease" WHERE "tenantId"=${tenantId}::uuid`);
    await tx(tenantId, c => c.$executeRaw`DELETE FROM "CashDeposit" WHERE "tenantId"=${tenantId}::uuid`);
  }
});

test("claim réel applique RLS, marque v1 et renvoie v2 dans l'ordre avec états de dépendance", async () => {
  const tenantA = randomUUID(), tenantB = randomUUID();
  const first = randomUUID(), second = randomUUID(), v1 = randomUUID(), dep = randomUUID(), hidden = randomUUID();
  try {
    await rawDeposit(tenantA, dep, "tablet-a", 2, 0);
    await rawDeposit(tenantA, second, "tablet-a", 2, 2);
    await rawDeposit(tenantA, first, "tablet-b", 2, 1, [dep, "not-a-uuid", hidden]);
    await rawDeposit(tenantA, v1, "tablet-z", 1, 0);
    await rawDeposit(tenantB, hidden, "tablet-0", 2, 0);
    const items = await tx(tenantA, async c => {
      const result = await claimDeposits(c, validateClaimInput({ tenantId: tenantA, holder: "apply", leaseSeconds: 20, limit: 20 }));
      assert.ok(result);
      return result.items;
    });
    assert.deepEqual(items.map(x => x.deviceId), ["tablet-a", "tablet-a", "tablet-b"]);
    assert.equal(items.some(x => x.actionId === v1 || x.actionId === hidden), false);
    assert.deepEqual(items[2].dependances.map((x: any) => x.actionId), [dep, "not-a-uuid", hidden]);
    assert.equal(items[2].dependances[0].status, "PENDING");
    assert.equal(items[2].dependances[1].status, "MISSING");
    assert.deepEqual(items[2].dependances[2], { actionId: hidden, status: "MISSING", resultJson: null });
    const legacy = await tx(tenantA, c => c.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId: tenantA, actionId: v1 } } }));
    assert.equal(legacy.lastResultCode, "REJEU_TABLETTE");
    const invisible = await tx(tenantA, c => c.cashDeposit.findMany({ where: { tenantId: tenantB } }));
    assert.deepEqual(invisible, []);
  } finally {
    await tx(tenantA, c => c.$executeRaw`DELETE FROM "CashDepositLease" WHERE "tenantId"=${tenantA}::uuid`);
    await tx(tenantA, c => c.$executeRaw`DELETE FROM "CashDeposit" WHERE "tenantId"=${tenantA}::uuid`);
    await tx(tenantB, c => c.$executeRaw`DELETE FROM "CashDeposit" WHERE "tenantId"=${tenantB}::uuid`);
  }
});

// Preuve rouge reproductible dans le CI local :
// CASH_DEPOSIT_PG_SABOTAGE=cursor npm run test:pg
// Ce sabotage, lu seulement ici, omet le curseur et reproduit la famine.
test("P2B pagination reelle A limit+5, B et C, refus persistants sans doublon", async () => {
  const tenantId = randomUUID(), limit = 3;
  const expected: { deviceId: string; sequence: number; actionId: string }[] = [];
  try {
    for (const [d, deviceId] of ["A", "B", "C"].entries()) {
      for (let i = 0; i < (d === 0 ? limit + 5 : 3); i++) {
        // Séquences égales et dates inversées : actionId seul départage.
        const actionId = randomUUID(), sequence = Math.floor(i / 2);
        await rawDeposit(tenantId, actionId, deviceId, 2, sequence);
        await tx(tenantId, c => c.$executeRaw`UPDATE "CashDeposit" SET "clientCreatedAt"=${new Date(1000 - i)} WHERE "tenantId"=${tenantId}::uuid AND "actionId"=${actionId}::uuid`);
        expected.push({ deviceId, sequence, actionId });
      }
    }
    expected.sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.sequence - b.sequence || a.actionId.localeCompare(b.actionId));
    let after: ReturnType<typeof validateClaimInput>["after"] = null, previousToken: string | undefined;
    const seen: string[] = [];
    let calls = 0;
    do {
      assert.ok(++calls <= Math.ceil(expected.length / limit), "pagination doit terminer");
      const page = await tx(tenantId, c => claimDeposits(c, validateClaimInput({ tenantId, holder: "pager", leaseSeconds: 60, limit,
        after: process.env.CASH_DEPOSIT_PG_SABOTAGE === "cursor" ? null : after })));
      assert.ok(page); assert.notEqual(page.token, previousToken); previousToken = page.token;
      assert.ok(page.items.length > 0 && page.items.length <= limit);
      for (const row of page.items) {
        assert.equal(seen.includes(row.actionId), false, "aucun dépôt ne revient pendant ce parcours");
        seen.push(row.actionId);
        await tx(tenantId, c => recordDepositResult(c, validateResultInput({ tenantId, token: page.token, actionId: row.actionId, outcome: "REFUSED", code: "RETRY", reason: "synthetic" })));
      }
      after = page.nextAfter;
      if (after) {
        const last = page.items.at(-1)!;
        assert.deepEqual(after, { deviceId: last.deviceId, sequence: Number(last.sequence), actionId: last.actionId });
      }
    } while (after);
    assert.deepEqual(seen, expected.map(x => x.actionId));
    assert.equal(calls, Math.ceil(expected.length / limit));
    const persisted = await tx(tenantId, c => c.cashDeposit.findMany({ where: { tenantId } }));
    assert.equal(persisted.length, expected.length);
    assert.ok(persisted.every((r: any) => r.status === "PENDING" && r.attempts === 1 && r.lastResultCode === "RETRY"));
  } finally {
    await tx(tenantId, c => c.$executeRaw`DELETE FROM "CashDepositLease" WHERE "tenantId"=${tenantId}::uuid`);
    await tx(tenantId, c => c.$executeRaw`DELETE FROM "CashDeposit" WHERE "tenantId"=${tenantId}::uuid`);
  }
});
