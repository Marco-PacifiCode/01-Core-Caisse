import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimDeposits, depositActions, depositStatuses, recordDepositResult, releaseLease, validateDepositInput, validateStatusInput } from "./cash-deposits.ts";

// Persistance simulée en mémoire (style de cash-deposits.test.ts) : un seul commerce par fixture.
function fixture() {
  const rows = new Map<string, any>(); let lease: any = null;
  const match = (row: any, w: any) => Object.entries(w).every(([k, v]: any) =>
    v && typeof v === "object" && "in" in v ? v.in.includes(row[k]) : v && typeof v === "object" && "gt" in v ? row[k] > v.gt : (row[k] ?? null) === v);
  const cmp = (a: any, b: any) => (a ?? Infinity) < (b ?? Infinity) ? -1 : (a ?? Infinity) > (b ?? Infinity) ? 1 : 0;
  const tx: any = {
    $queryRaw: async () => [],
    cashDeposit: {
      findUnique: async ({ where }: any) => rows.get(where.tenantId_actionId.actionId) ?? null,
      create: async ({ data }: any) => { rows.set(data.actionId, { formatVersion: 1, attempts: 0, lastResultCode: null, resultJson: null,
        actorId: null, actorName: null, receivedById: null, sequence: null, ...data, status: "PENDING", conflictCount: 0 }); },
      update: async ({ where, data }: any) => {
        const row = rows.get(where.tenantId_actionId.actionId), next = { ...row };
        for (const [k, v] of Object.entries<any>(data)) next[k] = v && typeof v === "object" && "increment" in v ? (row[k] ?? 0) + v.increment : v;
        rows.set(row.actionId, next);
      },
      updateMany: async ({ where, data }: any) => { let count = 0;
        for (const [id, row] of rows) if (match(row, where)) { rows.set(id, { ...row, ...data }); count++; } return { count }; },
      findMany: async ({ where, take }: any) => [...rows.values()].filter(r => match(r, where))
        .sort((a, b) => cmp(a.deviceId, b.deviceId) || cmp(a.sequence, b.sequence) || cmp(a.clientCreatedAt, b.clientCreatedAt) || cmp(a.actionId, b.actionId))
        .slice(0, take ?? 1000),
    },
    cashDepositLease: {
      findUnique: async () => lease,
      upsert: async ({ create, update }: any) => { lease = lease ? { ...lease, ...update } : { ...create }; return lease; },
      updateMany: async ({ where, data }: any) => { if (lease && lease.token === where.token && lease.until > where.until.gt) { lease = { ...lease, ...data }; return { count: 1 }; } return { count: 0 }; },
    },
  };
  return { tx, rows, getLease: () => lease, setLease: (l: any) => { lease = l; } };
}
const tenantId = randomUUID();
const v2 = (sequence: number, extra: any = {}) => ({ actionId: randomUUID(), deviceId: "tab-a", kind: "SALE", payload: { n: sequence },
  formatVersion: 2, sequence, actorId: "u1", actorName: "Alice", receivedById: "r1", ...extra });

test("format 1 inchangé : aucun champ d'enveloppe lu", () => {
  const [env] = validateDepositInput({ tenantId, actions: [{ actionId: randomUUID(), deviceId: "t", kind: "SALE", payload: {}, actorId: "x" }] }).envelopes;
  assert.equal(env, null);
  assert.throws(() => validateDepositInput({ tenantId, actions: [v2(1, { formatVersion: 3 })] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [v2(-1)] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [v2(1, { actorName: "a".repeat(201) })] }));
});
test("format 2 hors payloadHash : même payload, autre auteur → seen, auteur conservé, null complété", async () => {
  const f = fixture(), a = v2(1, { receivedById: null });
  assert.equal((await depositActions(f.tx, { tenantId, actions: [a] })).results[0].result, "stored");
  const hash = f.rows.get(a.actionId).payloadHash;
  const r = await depositActions(f.tx, { tenantId, actions: [{ ...a, actorId: "u2", actorName: "Bob", receivedById: "r9" }] });
  assert.equal(r.results[0].result, "seen");
  const row = f.rows.get(a.actionId);
  assert.equal(row.payloadHash, hash); assert.equal(row.actorId, "u1"); assert.equal(row.actorName, "Alice"); assert.equal(row.receivedById, "r9");
  assert.equal(row.sequence, 1n); assert.equal(row.formatVersion, 2);
});
test("claim : bail exclusif, expiré repris, ordre, REJEU_TABLETTE sans changer status, dépendances", async () => {
  const f = fixture(), first = v2(2), second = v2(1, { dependsOn: [first.actionId, randomUUID()] }), legacy = { actionId: randomUUID(), deviceId: "t", kind: "SALE", payload: {} };
  await depositActions(f.tx, { tenantId, actions: [first, second, legacy] });
  const c = await claimDeposits(f.tx, { tenantId, holder: "surface-1", limit: 10 });
  assert.deepEqual(c.items.map((i: any) => i.actionId), [second.actionId, first.actionId]);
  assert.deepEqual(c.items[0].dependencies[first.actionId], { status: "PENDING", resultJson: null });
  assert.equal(Object.values(c.items[0].dependencies)[1], null);
  assert.equal(f.rows.get(legacy.actionId).lastResultCode, "REJEU_TABLETTE"); assert.equal(f.rows.get(legacy.actionId).status, "PENDING");
  await assert.rejects(claimDeposits(f.tx, { tenantId, holder: "surface-2", limit: 10 }), (e: any) => e.message === "LEASE_HELD" && e.status === 409);
  assert.equal((await claimDeposits(f.tx, { tenantId, holder: "surface-1", limit: 10 })).token, c.token, "renouvelé par le même holder");
  f.setLease({ ...f.getLease(), until: new Date(Date.now() - 1) });
  const taken = await claimDeposits(f.tx, { tenantId, holder: "surface-2", limit: 1 });
  assert.notEqual(taken.token, c.token); assert.equal(taken.items.length, 1);
  await assert.rejects(claimDeposits(f.tx, { tenantId, holder: "x", limit: 101 }));
});
test("result : LEASE_LOST, APPLIED immuable et idempotent, REFUSED reste PENDING", async () => {
  const f = fixture(), a = v2(1), b = v2(2);
  await depositActions(f.tx, { tenantId, actions: [a, b] });
  const { token } = await claimDeposits(f.tx, { tenantId, holder: "s", limit: 10 });
  await assert.rejects(recordDepositResult(f.tx, { tenantId, token: randomUUID(), actionId: a.actionId, outcome: "APPLIED", resultJson: {} }), (e: any) => e.message === "LEASE_LOST");
  await assert.rejects(recordDepositResult(f.tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED" }), (e: any) => e.message === "INVALID_RESULT_JSON");
  await assert.rejects(recordDepositResult(f.tx, { tenantId, token, actionId: b.actionId, outcome: "REFUSED" }), (e: any) => e.message === "INVALID_CODE");
  await recordDepositResult(f.tx, { tenantId, token, actionId: b.actionId, outcome: "WAITING", code: "DEPENDANCE", reason: "attend a" });
  assert.equal(f.rows.get(b.actionId).status, "PENDING"); assert.equal(f.rows.get(b.actionId).attempts, 1); assert.equal(f.rows.get(b.actionId).lastResultCode, "DEPENDANCE");
  const ok = await recordDepositResult(f.tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s1" } });
  assert.equal(ok.idempotent, false); assert.equal(f.rows.get(a.actionId).status, "APPLIED"); assert.equal(f.rows.get(a.actionId).lastResultCode, "APPLIED");
  assert.equal((await recordDepositResult(f.tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s1" } })).idempotent, true);
  await assert.rejects(recordDepositResult(f.tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s2" } }), (e: any) => e.message === "ALREADY_APPLIED");
  await assert.rejects(recordDepositResult(f.tx, { tenantId, token, actionId: a.actionId, outcome: "REFUSED", code: "X" }), (e: any) => e.message === "ALREADY_APPLIED");
  assert.equal(f.rows.get(a.actionId).attempts, 1);
  assert.deepEqual(await releaseLease(f.tx, { tenantId, token: randomUUID() }), { released: false });
  assert.deepEqual(await releaseLease(f.tx, { tenantId, token }), { released: true });
  await assert.rejects(recordDepositResult(f.tx, { tenantId, token, actionId: b.actionId, outcome: "REFUSED", code: "X" }), (e: any) => e.message === "LEASE_LOST");
});
test("result refuse une ligne de format 1", async () => {
  const f = fixture(), legacy = { actionId: randomUUID(), deviceId: "t", kind: "SALE", payload: {} };
  await depositActions(f.tx, { tenantId, actions: [legacy] });
  const { token } = await claimDeposits(f.tx, { tenantId, holder: "s", limit: 1 });
  await assert.rejects(recordDepositResult(f.tx, { tenantId, token, actionId: legacy.actionId, outcome: "APPLIED", resultJson: {} }), (e: any) => e.message === "FORMAT_NOT_APPLICABLE");
});
test("applied : UUID seul inchangé, objet avec resultJson, ligne APPLIED jamais réécrite, objet malformé refusé", async () => {
  const f = fixture(), a = v2(1), b = v2(2), c = v2(3);
  await depositActions(f.tx, { tenantId, actions: [a, b, c] });
  await depositActions(f.tx, { tenantId, actions: [], applied: [a.actionId, { actionId: b.actionId.toUpperCase(), resultJson: { cashDayId: "d1" } }] });
  assert.equal(f.rows.get(a.actionId).status, "APPLIED"); assert.equal(f.rows.get(a.actionId).resultJson, null);
  const rb = f.rows.get(b.actionId);
  assert.equal(rb.status, "APPLIED"); assert.deepEqual(rb.resultJson, { cashDayId: "d1" }); assert.equal(rb.lastResultCode, "APPLIED"); assert.ok(rb.lastAttemptAt && rb.appliedAt);
  await new Promise(r => setTimeout(r, 5));
  await depositActions(f.tx, { tenantId, actions: [], applied: [{ actionId: b.actionId, resultJson: { cashDayId: "autre" } }] });
  assert.deepEqual(f.rows.get(b.actionId).resultJson, { cashDayId: "d1" }); assert.equal(f.rows.get(b.actionId).appliedAt, rb.appliedAt);
  for (const bad of [{ actionId: c.actionId }, { actionId: c.actionId, resultJson: [] }, { actionId: "x", resultJson: {} }, { actionId: c.actionId, resultJson: {}, autre: 1 }, 5, null])
    assert.throws(() => validateDepositInput({ tenantId, actions: [], applied: [bad] }), (e: any) => e.message === "INVALID_APPLIED" && e.status === 400);
  assert.equal(f.rows.get(c.actionId).status, "PENDING");
});
test("réponse du dépôt : status et resultJson de la ligne après l'opération", async () => {
  const f = fixture(), a = v2(1), b = v2(2), c = v2(3);
  const first = await depositActions(f.tx, { tenantId, actions: [a] });
  assert.deepEqual({ ...first.results[0] }, { actionId: a.actionId, result: "stored", status: "PENDING" });
  assert.ok(!("resultJson" in first.results[0]));
  await depositActions(f.tx, { tenantId, actions: [b, c] });
  const { token } = await claimDeposits(f.tx, { tenantId, holder: "s", limit: 10 });
  await recordDepositResult(f.tx, { tenantId, token, actionId: b.actionId, outcome: "APPLIED", resultJson: { saleId: "s1" } });
  await depositActions(f.tx, { tenantId, actions: [], applied: [c.actionId] });
  const r = await depositActions(f.tx, { tenantId, actions: [b, c, { ...a, payload: { autre: true } }] });
  assert.deepEqual(JSON.parse(JSON.stringify(r.results)), [
    { actionId: b.actionId, result: "seen", status: "APPLIED", resultJson: { saleId: "s1" } },
    { actionId: c.actionId, result: "seen", status: "APPLIED" },
    { actionId: a.actionId, result: "conflict", status: "PENDING" },
  ]);
});

// ---- État des dépôts : POST /api/cash-deposits/status ----
// Faux tx qui enregistre chaque findMany et applique le `select` (projection réelle), toute écriture est interdite.
function statusTx(rows: any[]) {
  const calls: any[] = [], no = async () => { throw new Error("ÉCRITURE_INTERDITE"); };
  const tx: any = { cashDeposit: {
    findMany: async (args: any) => { calls.push(args);
      return rows.filter(r => r.tenantId === args.where.tenantId && args.where.actionId.in.includes(r.actionId))
        .map(r => Object.fromEntries(Object.keys(args.select).filter(k => args.select[k]).map(k => [k, r[k] ?? null]))); },
    create: no, update: no, updateMany: no, upsert: no, delete: no, deleteMany: no } };
  return { tx, calls };
}
const fullRow = (extra: any) => ({ tenantId, actionId: randomUUID(), payload: { secret: 1 }, payloadHash: "h", actorId: "u1", actorName: "Alice",
  sequence: 1n, formatVersion: 2, resultJson: null, status: "PENDING", ...extra });
test("status : APPLIED+resultJson, PENDING, APPLIED sans resultJson, inconnu et autre commerce absents", async () => {
  const applied = fullRow({ status: "APPLIED", resultJson: { saleId: "s1", n: [1, 2] } }), pending = fullRow({}),
    bare = fullRow({ status: "APPLIED" }), other = fullRow({ tenantId: randomUUID(), status: "APPLIED", resultJson: { x: 1 } }), unknown = randomUUID();
  const { tx, calls } = statusTx([applied, pending, bare, other]);
  const r = await depositStatuses(tx, { tenantId, actionIds: [applied.actionId, pending.actionId.toUpperCase(), bare.actionId, other.actionId, unknown, applied.actionId] });
  const byId = new Map(r.items.map((i: any) => [i.actionId, i]));
  assert.deepEqual({ ...byId.get(applied.actionId) }, { actionId: applied.actionId, status: "APPLIED", resultJson: { saleId: "s1", n: [1, 2] } });
  assert.deepEqual({ ...byId.get(pending.actionId) }, { actionId: pending.actionId, status: "PENDING" });
  assert.deepEqual({ ...byId.get(bare.actionId) }, { actionId: bare.actionId, status: "APPLIED" });
  assert.ok(!byId.has(other.actionId) && !byId.has(unknown)); assert.equal(r.items.length, 3);
  for (const i of r.items) assert.ok(Object.keys(i).every(k => ["actionId", "status", "resultJson"].includes(k)), JSON.stringify(i));
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0].select }, { actionId: true, status: true, resultJson: true });
  assert.ok(!("payload" in calls[0].select) && !("payloadHash" in calls[0].select));
  assert.equal(calls[0].where.tenantId, tenantId); assert.equal(calls[0].where.actionId.in.length, 5); // doublon retiré, casse normalisée
});
test("status : une seule requête pour 1000 ids", async () => {
  const { tx, calls } = statusTx([]), ids = Array.from({ length: 1000 }, () => randomUUID());
  assert.deepEqual({ ...(await depositStatuses(tx, { tenantId, actionIds: ids })) }, { items: [] });
  assert.equal(calls.length, 1); assert.equal(calls[0].where.actionId.in.length, 1000);
});
test("status : 0 ou 1001 ids, id non uuid, tenant invalide → 400", async () => {
  const ok = randomUUID();
  for (const bad of [{ tenantId, actionIds: [] }, { tenantId, actionIds: Array.from({ length: 1001 }, () => randomUUID()) }, { tenantId, actionIds: [ok, "x"] },
    { tenantId, actionIds: [5] }, { tenantId, actionIds: ok }, { tenantId }, { tenantId: "x", actionIds: [ok] }, null, []]) {
    assert.throws(() => validateStatusInput(bad), (e: any) => e.status === 400);
    await assert.rejects(depositStatuses(statusTx([]).tx, bad), (e: any) => e.status === 400);
  }
  assert.throws(() => validateStatusInput({ tenantId, actionIds: [] }), (e: any) => e.message === "INVALID_ACTION_IDS");
});
test("status : route sous la garde cashHttp (X-Core-Key), withTenant, aucune écriture", () => {
  const route = readFileSync(new URL("../app/api/cash-deposits/status/route.ts", import.meta.url), "utf8");
  assert.match(route, /return cashHttp\(req,/); assert.match(route, /withTenant\(tenantId, tx => depositStatuses\(tx, raw\)\)/);
  assert.match(readFileSync(new URL("./cash-shared-http.ts", import.meta.url), "utf8"), /if \(!hasServiceKey\(req\)\) return response\(\{ ok: false, error: "Unauthorized" \}, 401\)/);
  const src = readFileSync(new URL("./cash-deposits.ts", import.meta.url), "utf8"), fn = src.slice(src.indexOf("export async function depositStatuses"));
  assert.doesNotMatch(fn, /\.(create|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw/);
});
