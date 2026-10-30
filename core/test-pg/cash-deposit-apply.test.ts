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
  const roles = await prisma.$queryRaw<any[]>`SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  assert.equal(roles[0]?.rolbypassrls, false, "les vérifications RLS exigent un rôle non privilégié");
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
    const first = claims.find(Boolean)!;
    const renewed = await tx(tenantId, c => claimDeposits(c, validateClaimInput({ tenantId, holder: claims[0] ? "worker-a" : "worker-b", leaseSeconds: 30, limit: 10 })));
    assert.ok(renewed);
    const input = validateResultInput({ tenantId, token: first.token, actionId, outcome: "REFUSED", code: "OLD", reason: "stale" });
    const outcome = await tx(tenantId, c => recordDepositResult(c, input));
    assert.deepEqual(outcome, { error: "LEASE_LOST" });
    const deposit = await tx(tenantId, c => c.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } }));
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
    await rawDeposit(tenantA, first, "tablet-b", 2, 1, [dep, "not-a-uuid"]);
    await rawDeposit(tenantA, v1, "tablet-z", 1, 0);
    await rawDeposit(tenantB, hidden, "tablet-0", 2, 0);
    const items = await tx(tenantA, async c => {
      const result = await claimDeposits(c, validateClaimInput({ tenantId: tenantA, holder: "apply", leaseSeconds: 20, limit: 20 }));
      assert.ok(result);
      return result.items;
    });
    assert.deepEqual(items.map(x => x.deviceId), ["tablet-a", "tablet-a", "tablet-b"]);
    assert.equal(items.some(x => x.actionId === v1 || x.actionId === hidden), false);
    assert.deepEqual(items[2].dependances.map((x: any) => x.actionId), [dep, "not-a-uuid"]);
    assert.equal(items[2].dependances[0].status, "PENDING");
    assert.equal(items[2].dependances[1].status, "MISSING");
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
