import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { canonical } from "./cash-day-projection.ts";
import { depositActions, validateDepositInput, readDepositBody, MAX_BODY_BYTES } from "./cash-deposits.ts";

const tenantId = randomUUID();
const makeAction = (actionId = randomUUID(), payload: any = { a: 1, b: 2 }) => ({ actionId, deviceId: "tablet", kind: "SALE", payload });
test("valide les UUID, l'objet payload et les limites du lot", () => {
  assert.throws(() => validateDepositInput({ tenantId: "bad", actions: [makeAction()] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: Array.from({ length: 201 }, () => makeAction()) }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), actionId: "bad" }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), payload: [] }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), payload: null }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), payload: 5 }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), kind: "k".repeat(41) }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), entityKey: "e".repeat(301) }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), deviceId: "d".repeat(201) }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), dependsOn: [1] }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [makeAction()], applied: ["bad"] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [makeAction()], applied: Array.from({ length: 1001 }, randomUUID) }));
});
test("empreinte canonique indépendante de l'ordre des clés", () => {
  const first = { b: 2, a: 1 }, second = { a: 1, b: 2 };
  const [one] = validateDepositInput({ tenantId, actions: [makeAction(randomUUID(), first)] }).actions;
  const [two] = validateDepositInput({ tenantId, actions: [makeAction(randomUUID(), second)] }).actions;
  const expected = createHash("sha256").update(canonical(first)).digest("hex");
  assert.equal(one.payloadHash, expected); assert.equal(two.payloadHash, expected);
  assert.deepEqual(first, { b: 2, a: 1 }); assert.deepEqual(second, { a: 1, b: 2 });
});
test("décide stored, seen, conflict et applied", async () => {
  const rows = new Map<string, any>(); let now = Date.now();
  const tx: any = { $queryRaw: async () => [], cashDeposit: {
    findUnique: async ({ where }: any) => rows.get(where.tenantId_actionId.actionId) ?? null,
    create: async ({ data }: any) => { rows.set(data.actionId, { ...data, lastSeenAt: new Date(now), status: "PENDING" }); },
    update: async ({ where, data }: any) => { const row = rows.get(where.tenantId_actionId.actionId); rows.set(row.actionId, { ...row, ...data, conflictCount: data.conflictCount?.increment ? (row.conflictCount ?? 0) + data.conflictCount.increment : row.conflictCount ?? 0 }); },
    updateMany: async ({ where, data }: any) => { for (const id of where.actionId.in) { const row = rows.get(id); if (row?.tenantId === where.tenantId && (!where.status || row.status === where.status)) rows.set(id, { ...row, ...data }); } },
  } };
  const a = { ...makeAction(), clientState: "queued", clientErrorCode: "OFFLINE" };
  assert.equal((await depositActions(tx, { tenantId, actions: [a] })).results[0].result, "stored");
  const received = rows.get(a.actionId).lastSeenAt;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await depositActions(tx, { tenantId, actions: [a] })).results[0].result, "seen");
  assert.ok(rows.get(a.actionId).lastSeenAt > received);
  assert.equal(rows.get(a.actionId).clientState, "queued"); assert.equal(rows.get(a.actionId).clientErrorCode, "OFFLINE");
  assert.equal((await depositActions(tx, { tenantId, actions: [makeAction(a.actionId, { a: 3 })] })).results[0].result, "conflict");
  assert.deepEqual(rows.get(a.actionId).payload, a.payload); assert.equal(rows.get(a.actionId).conflictCount, 1);
  await depositActions(tx, { tenantId, actions: [a], applied: [a.actionId] });
  assert.equal(rows.get(a.actionId).status, "APPLIED");
  const appliedAt = rows.get(a.actionId).appliedAt;
  await depositActions(tx, { tenantId, actions: [a], applied: [a.actionId] });
  assert.equal(rows.get(a.actionId).appliedAt, appliedAt);
});
test("rejette un corps supérieur à 2 Mio avec 413", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); controller.close(); } });
  await assert.rejects(() => readDepositBody(stream), (e: any) => e.status === 413);
});
