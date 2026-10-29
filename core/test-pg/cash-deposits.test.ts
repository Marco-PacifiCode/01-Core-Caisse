import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { depositActions, listDeposits, readDepositBody, MAX_BODY_BYTES } from "../lib/cash-deposits.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base de recette uniquement)");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });
async function tx<T>(tenantId: string, fn: (client: any) => Promise<T>) {
  return prisma.$transaction(async client => {
    await client.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(client);
  });
}
const action = (actionId: string, payload: any = { sample: 1 }) => ({ actionId, deviceId: "pg-test", kind: "TEST", payload });

test("idempotence, conflit, applied, pagination sans payload et isolation RLS", async () => {
  const tenant = randomUUID(), other = randomUUID(), actionId = randomUUID();
  try {
    const [{ bypass }] = await prisma.$queryRaw<{ bypass: boolean }[]>`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
    assert.equal(bypass, false, "le test exige le rôle applicatif RLS");
    await Promise.all([tx(tenant, client => depositActions(client, { tenantId: tenant, actions: [action(actionId)] })),
      tx(tenant, client => depositActions(client, { tenantId: tenant, actions: [action(actionId)] }))]);
    assert.equal(await tx(tenant, client => client.cashDeposit.count({ where: { tenantId: tenant, actionId } })), 1);
    const before = await tx(tenant, client => client.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId: tenant, actionId } } }));
    assert.ok(before);
    await new Promise(resolve => setTimeout(resolve, 10));
    const seen = await tx(tenant, client => depositActions(client, { tenantId: tenant, actions: [action(actionId)] }));
    assert.equal(seen.results[0].result, "seen");
    const afterSeen = await tx(tenant, client => client.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId: tenant, actionId } } }));
    assert.ok(afterSeen.lastSeenAt > before.lastSeenAt);
    await tx(tenant, client => depositActions(client, { tenantId: tenant, actions: [action(actionId, { sample: 2 })] }));
    const conflicted = await tx(tenant, client => client.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId: tenant, actionId } } }));
    assert.deepEqual(conflicted.payload, { sample: 1 }); assert.equal(conflicted.conflictCount, 1);
    const secondId = randomUUID();
    await tx(tenant, client => depositActions(client, { tenantId: tenant, actions: [action(secondId)], applied: [actionId] }));
    const applied = await tx(tenant, client => client.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId: tenant, actionId } } }));
    assert.equal(applied.status, "APPLIED"); assert.ok(applied.appliedAt);
    const page = await tx(tenant, client => listDeposits(client, { tenantId: tenant, limit: 1 }));
    assert.equal(page.items.length, 1); assert.equal("payload" in page.items[0], false); assert.ok(page.nextCursor);
    const page2 = await tx(tenant, client => listDeposits(client, { tenantId: tenant, limit: 1, cursor: page.nextCursor }));
    assert.equal(page2.items.length, 1); assert.notEqual(page2.items[0].id, page.items[0].id);
    assert.equal("payload" in page2.items[0], false); assert.equal(page2.nextCursor, null);
    const full = await tx(tenant, client => listDeposits(client, { tenantId: tenant, limit: 10, withPayload: "1" }));
    assert.equal("payload" in full.items[0], true);
    const appliedOnly = await tx(tenant, client => listDeposits(client, { tenantId: tenant, status: "APPLIED", limit: 10 }));
    assert.equal(appliedOnly.items.length, 1); assert.equal(appliedOnly.items[0].status, "APPLIED");
    const pendingOnly = await tx(tenant, client => listDeposits(client, { tenantId: tenant, status: "PENDING", limit: 10 }));
    assert.equal(pendingOnly.items.length, 1); assert.equal(pendingOnly.items[0].actionId, secondId);
    assert.equal(await tx(other, client => client.cashDeposit.count({ where: { actionId } })), 0);
    await assert.rejects(() => tx(tenant, client => client.cashDeposit.create({ data: { tenantId: other, ...action(randomUUID()), payloadHash: "x" } })));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); controller.close(); } });
    await assert.rejects(() => readDepositBody(stream), (e: any) => e.status === 413);
  } finally { await tx(tenant, client => client.cashDeposit.deleteMany({ where: { tenantId: tenant } })); }
});
