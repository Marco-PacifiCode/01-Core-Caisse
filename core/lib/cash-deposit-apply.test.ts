import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimDeposits, depositActions, depositStatuses, listDeposits, recordDepositResult, releaseLease, validateDepositInput, validateStatusInput } from "./cash-deposits.ts";

// Persistance simulée en mémoire (style de cash-deposits.test.ts) : un seul commerce par fixture.
function fixture() {
  const rows = new Map<string, any>(); let lease: any = null;
  // Filtres Prisma simulés : égalité, in, gt, not, notIn (sémantique SQL : NULL exclu de notIn), OR.
  const cond = (x: any, v: any): boolean => !(v && typeof v === "object" && !(v instanceof Date)) ? (x ?? null) === v
    : Object.entries(v).every(([op, o]: any) => op === "in" ? o.includes(x) : op === "gt" ? x > o : op === "not" ? (x ?? null) !== o
      : op === "notIn" ? x != null && !o.includes(x) : false);
  const match = (row: any, w: any): boolean => Object.entries(w).every(([k, v]: any) => k === "OR" ? v.some((o: any) => match(row, o)) : cond(row[k], v));
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
const v1 = () => ({ actionId: randomUUID(), deviceId: "t", kind: "SALE", payload: { legacy: randomUUID() } });
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
  assert.deepEqual(c.items[0].dependencies[first.actionId], { status: "PENDING", resultJson: null, lastResultCode: null, formatVersion: 2 });
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
// R1 (04/11) : ce test portait l'ancien comportement sur des lignes de format 2 ; il ne vaut plus que pour le format 1.
// K2 (relecture 2) : le resultJson d'un accusé de la tablette n'est plus jamais stocké, même en format 1.
test("applied format 1 : UUID seul et objet → APPLIED sans resultJson stocké, ligne APPLIED jamais réécrite, objet malformé refusé", async () => {
  const f = fixture(), a = v1(), b = v1(), c = v2(3);
  await depositActions(f.tx, { tenantId, actions: [a, b, c] });
  await depositActions(f.tx, { tenantId, deviceId: "t", actions: [], applied: [a.actionId, { actionId: b.actionId.toUpperCase(), resultJson: { cashDayId: "d1" } }] });
  assert.equal(f.rows.get(a.actionId).status, "APPLIED"); assert.equal(f.rows.get(a.actionId).resultJson, null);
  const rb = f.rows.get(b.actionId);
  assert.equal(rb.status, "APPLIED"); assert.equal(rb.resultJson, null); assert.equal(rb.lastResultCode, null); assert.ok(rb.appliedAt);
  await new Promise(r => setTimeout(r, 5));
  await depositActions(f.tx, { tenantId, deviceId: "t", actions: [], applied: [{ actionId: b.actionId, resultJson: { cashDayId: "autre" } }] });
  assert.equal(f.rows.get(b.actionId).resultJson, null); assert.equal(f.rows.get(b.actionId).appliedAt, rb.appliedAt);
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
  // K1 : l'accusé de la tablette ne change jamais une ligne de format 2, même renoncée.
  f.rows.set(c.actionId, { ...f.rows.get(c.actionId), lastResultCode: "NON_APPLICABLE_ERROR" });
  await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [c.actionId] });
  const r = await depositActions(f.tx, { tenantId, actions: [b, c, { ...a, payload: { autre: true } }] });
  assert.deepEqual(JSON.parse(JSON.stringify(r.results)), [
    { actionId: b.actionId, result: "seen", status: "APPLIED", resultJson: { saleId: "s1" } },
    { actionId: c.actionId, result: "seen", status: "PENDING" },
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
  const applied = fullRow({ status: "APPLIED", lastResultCode: "APPLIED", resultJson: { saleId: "s1", n: [1, 2] } }), pending = fullRow({}),
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
  assert.deepEqual({ ...calls[0].select }, { actionId: true, status: true, resultJson: true, formatVersion: true, lastResultCode: true });
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

// ---- Relecture 1 : R1 (qui peut dire APPLIED), R2 (filtre du claim, remise à zéro), R4 (conflictCount) ----
const mark = (f: any, id: string, code: string | null) => f.rows.set(id, { ...f.rows.get(id), lastResultCode: code });
test("R1 : applied inventé sur format 2 jamais tenté ou EN_ATTENTE → reste PENDING, resultJson null", async () => {
  for (const code of [null, "EN_ATTENTE"]) {
    const f = fixture(), a = v2(1), b = v2(2);
    await depositActions(f.tx, { tenantId, actions: [a, b] }); mark(f, a.actionId, code); mark(f, b.actionId, code);
    const r = await depositActions(f.tx, { tenantId, actions: [a], applied: [{ actionId: a.actionId, resultJson: { saleId: "faux" } }, b.actionId] });
    for (const id of [a.actionId, b.actionId]) { const row = f.rows.get(id);
      assert.equal(row.status, "PENDING", String(code)); assert.equal(row.resultJson, null); assert.equal(row.lastResultCode, code); }
    assert.deepEqual({ ...r.results[0] }, { actionId: a.actionId, result: "seen", status: "PENDING" });
  }
});
// K1 (relecture 2) : encodait APPLIED_PAR_TABLETTE ; désormais la ligne de format 2 ne change jamais.
test("K1 : même appareil sur une ligne REJEU_TABLETTE → ligne inchangée, aucun signalement ; /status sans resultJson de la tablette", async () => {
  const f = fixture(), a = v2(1);
  await depositActions(f.tx, { tenantId, actions: [a] }); mark(f, a.actionId, "REJEU_TABLETTE");
  const before = { ...f.rows.get(a.actionId) };
  const r = await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [{ actionId: a.actionId, resultJson: { cashDayId: "invente" } }] });
  assert.deepEqual(r.appliedIgnores, []); assert.deepEqual([...r.applied], [a.actionId]);
  assert.deepEqual({ ...f.rows.get(a.actionId) }, before);
  const st = await depositStatuses(f.tx, { tenantId, actionIds: [a.actionId] });
  assert.deepEqual(JSON.parse(JSON.stringify(st.items)), [{ actionId: a.actionId, status: "PENDING" }]);
});
test("K2 : format 1 accusé avec un resultJson → APPLIED, resultJson null en base, /status sans resultJson", async () => {
  const f = fixture(), a = v1(), b = v1();
  await depositActions(f.tx, { tenantId, actions: [a, b] });
  await depositActions(f.tx, { tenantId, deviceId: "t", actions: [], applied: [a.actionId, { actionId: b.actionId, resultJson: { saleId: "s" } }] });
  assert.equal(f.rows.get(a.actionId).status, "APPLIED"); assert.equal(f.rows.get(a.actionId).resultJson, null);
  assert.equal(f.rows.get(b.actionId).status, "APPLIED"); assert.equal(f.rows.get(b.actionId).resultJson, null);
  const st = await depositStatuses(f.tx, { tenantId, actionIds: [b.actionId] });
  assert.deepEqual(JSON.parse(JSON.stringify(st.items)), [{ actionId: b.actionId, status: "APPLIED" }]);
});
test("R2 : 100 dépôts REJEU_TABLETTE puis 1 neuf → claim limit 100 renvoie le neuf ; dépendances lues quelle que soit la marque", async () => {
  const f = fixture(), old = Array.from({ length: 100 }, (_, i) => v2(i + 1));
  for (let i = 0; i < 100; i += 50) await depositActions(f.tx, { tenantId, actions: old.slice(i, i + 50) });
  for (const o of old) mark(f, o.actionId, "REJEU_TABLETTE");
  const fresh = v2(500, { dependsOn: [old[0].actionId] });
  await depositActions(f.tx, { tenantId, actions: [fresh] });
  const c = await claimDeposits(f.tx, { tenantId, holder: "s", limit: 100 });
  assert.deepEqual(c.items.map((i: any) => i.actionId), [fresh.actionId]);
  assert.deepEqual(c.items[0].dependencies[old[0].actionId], { status: "PENDING", resultJson: null, lastResultCode: "REJEU_TABLETTE", formatVersion: 2 });
});
test("R2 : redépôt seen avec clientState error → pending efface NON_APPLICABLE_ERROR et rend re-claimable ; APPLIED jamais remis à zéro", async () => {
  const f = fixture(), a = v2(1, { clientState: "error" }), b = v2(2, { clientState: "error" });
  await depositActions(f.tx, { tenantId, actions: [a, b] });
  f.rows.set(a.actionId, { ...f.rows.get(a.actionId), lastResultCode: "NON_APPLICABLE_ERROR", lastResultReason: "erreur tablette" });
  assert.equal((await claimDeposits(f.tx, { tenantId, holder: "s", limit: 10 })).items.some((i: any) => i.actionId === a.actionId), false);
  assert.equal((await depositActions(f.tx, { tenantId, actions: [{ ...a, clientState: "pending" }] })).results[0].result, "seen");
  assert.equal(f.rows.get(a.actionId).lastResultCode, null); assert.equal(f.rows.get(a.actionId).lastResultReason, null);
  assert.ok((await claimDeposits(f.tx, { tenantId, holder: "s", limit: 10 })).items.some((i: any) => i.actionId === a.actionId));
  f.rows.set(b.actionId, { ...f.rows.get(b.actionId), status: "APPLIED", lastResultCode: "APPLIED", lastResultReason: "x", resultJson: { saleId: "s" } });
  await depositActions(f.tx, { tenantId, actions: [{ ...b, clientState: "pending" }] });
  assert.equal(f.rows.get(b.actionId).lastResultCode, "APPLIED"); assert.equal(f.rows.get(b.actionId).lastResultReason, "x");
});
test("R4 : conflictCount dans les items du claim, 1 après un redépôt au payload différent", async () => {
  const f = fixture(), a = v2(1), b = v2(2);
  await depositActions(f.tx, { tenantId, actions: [a, b] });
  assert.equal((await depositActions(f.tx, { tenantId, actions: [{ ...a, payload: { annule: true } }] })).results[0].result, "conflict");
  const c = await claimDeposits(f.tx, { tenantId, holder: "s", limit: 10 }), byId = new Map(c.items.map((i: any) => [i.actionId, i]));
  assert.equal(byId.get(a.actionId).conflictCount, 1); assert.equal(byId.get(b.actionId).conflictCount, 0);
});

// ---- Garde de l'appareil (R1, ajout Archi) ----
// K1 (relecture 2) : encodait APPLIED_PAR_TABLETTE pour le même appareil ; la ligne reste désormais inchangée.
test("appareil : B accuse la ligne REJEU_TABLETTE de A → inchangée, AUTRE_APPAREIL ; même appareil → inchangée, silence", async () => {
  const f = fixture(), a = v2(1);
  await depositActions(f.tx, { tenantId, actions: [a] }); mark(f, a.actionId, "REJEU_TABLETTE");
  const before = { ...f.rows.get(a.actionId) };
  const r = await depositActions(f.tx, { tenantId, deviceId: "tab-b", actions: [], applied: [a.actionId] });
  assert.deepEqual(r.appliedIgnores.map(i => ({ ...i })), [{ actionId: a.actionId, code: "AUTRE_APPAREIL" }]);
  assert.deepEqual({ ...f.rows.get(a.actionId) }, before, "ligne inchangée, pas de conflictCount");
  const ok = await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [a.actionId] });
  assert.deepEqual(ok.appliedIgnores, []); assert.deepEqual({ ...f.rows.get(a.actionId) }, before);
});
test("appareil : déduit des actions du lot (toutes de A) ; lot mixte ou vide sans deviceId → APPAREIL_INCONNU", async () => {
  const f = fixture(), a = v2(1), x = v2(2), y = v2(3);
  await depositActions(f.tx, { tenantId, actions: [a, x, y] }); for (const r of [a, x, y]) mark(f, r.actionId, "REJEU_TABLETTE");
  const other = v2(9, { deviceId: "tab-b" });
  const mixed = await depositActions(f.tx, { tenantId, actions: [x, other], applied: [a.actionId] });
  assert.deepEqual(mixed.appliedIgnores.map(i => ({ ...i })), [{ actionId: a.actionId, code: "APPAREIL_INCONNU" }]);
  const none = await depositActions(f.tx, { tenantId, actions: [], applied: [a.actionId] });
  assert.deepEqual(none.appliedIgnores.map(i => ({ ...i })), [{ actionId: a.actionId, code: "APPAREIL_INCONNU" }]);
  assert.equal(f.rows.get(a.actionId).status, "PENDING");
  const inferred = await depositActions(f.tx, { tenantId, actions: [x, y], applied: [a.actionId] });
  assert.deepEqual(inferred.appliedIgnores, []); assert.equal(f.rows.get(a.actionId).lastResultCode, "REJEU_TABLETTE"); assert.equal(f.rows.get(a.actionId).status, "PENDING");
});
test("appareil avant C1 : B sur une ligne de A jamais tentée / EN_ATTENTE / REJEU_TABLETTE → AUTRE_APPAREIL, inchangée", async () => {
  for (const code of [null, "EN_ATTENTE", "REJEU_TABLETTE"]) {
    const f = fixture(), a = v2(1);
    await depositActions(f.tx, { tenantId, actions: [a] }); mark(f, a.actionId, code);
    const before = { ...f.rows.get(a.actionId) };
    const r = await depositActions(f.tx, { tenantId, deviceId: "tab-b", actions: [], applied: [{ actionId: a.actionId, resultJson: { saleId: "faux" } }] });
    assert.deepEqual(r.appliedIgnores.map(i => ({ ...i })), [{ actionId: a.actionId, code: "AUTRE_APPAREIL" }], String(code));
    assert.deepEqual({ ...f.rows.get(a.actionId) }, before, String(code));
  }
});
test("appareil avant C1 : A sur sa ligne jamais tentée → ignorée sans signalement ; inconnu sur ligne jamais tentée → APPAREIL_INCONNU", async () => {
  const f = fixture(), a = v2(1);
  await depositActions(f.tx, { tenantId, actions: [a] });
  const own = await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [a.actionId] });
  assert.deepEqual(own.appliedIgnores, []); assert.equal(f.rows.get(a.actionId).status, "PENDING"); assert.equal(f.rows.get(a.actionId).lastResultCode, null);
  const none = await depositActions(f.tx, { tenantId, actions: [], applied: [a.actionId] });
  assert.deepEqual(none.appliedIgnores.map(i => ({ ...i })), [{ actionId: a.actionId, code: "APPAREIL_INCONNU" }]);
  assert.equal(f.rows.get(a.actionId).status, "PENDING"); assert.equal(f.rows.get(a.actionId).lastResultCode, null);
});
// K5 : la garde de l'appareil vaut aussi pour le format 1 (ce test encodait « format 1 sans contrôle »).
test("K5 format 1 : B sur la ligne de A → AUTRE_APPAREIL inchangée ; A → APPLIED sans resultJson ; deviceId invalide → 400", async () => {
  const f = fixture(), a = v2(1), legacy = v1();
  await depositActions(f.tx, { tenantId, actions: [a, legacy] });
  const before = { ...f.rows.get(legacy.actionId) };
  const r = await depositActions(f.tx, { tenantId, deviceId: "tab-b", actions: [], applied: [{ actionId: legacy.actionId, resultJson: { saleId: "faux" } }] });
  assert.deepEqual(r.appliedIgnores.map(i => ({ ...i })), [{ actionId: legacy.actionId, code: "AUTRE_APPAREIL" }]);
  assert.deepEqual({ ...f.rows.get(legacy.actionId) }, before);
  const own = await depositActions(f.tx, { tenantId, deviceId: "t", actions: [], applied: [{ actionId: legacy.actionId, resultJson: { saleId: "s" } }] });
  assert.deepEqual(own.appliedIgnores, []);
  assert.equal(f.rows.get(legacy.actionId).status, "APPLIED"); assert.equal(f.rows.get(legacy.actionId).resultJson, null);
  for (const bad of ["", "a b", "x".repeat(81), 5, "é"])
    assert.throws(() => validateDepositInput({ tenantId, deviceId: bad, actions: [], applied: [a.actionId] }), (e: any) => e.message === "INVALID_DEVICE_ID" && e.status === 400);
});

// ---- Relecture 2 : K2 (resultJson servi seulement si posé par /result), K4 (filtres de la liste) ----
test("K2 : ligne de format 2 APPLIED par /result → /status rend son resultJson", async () => {
  const f = fixture(), a = v2(1);
  await depositActions(f.tx, { tenantId, actions: [a] });
  const { token } = await claimDeposits(f.tx, { tenantId, holder: "s", limit: 10 });
  await recordDepositResult(f.tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s1" } });
  const st = await depositStatuses(f.tx, { tenantId, actionIds: [a.actionId] });
  assert.deepEqual(JSON.parse(JSON.stringify(st.items)), [{ actionId: a.actionId, status: "APPLIED", resultJson: { saleId: "s1" } }]);
});
test("K4 : listDeposits filtre deviceId et receivedFrom dans la requête ; invalides → 400 ; sans eux inchangé", async () => {
  const calls: any[] = [];
  const tx: any = { cashDeposit: { findMany: async (args: any) => { calls.push(args); return []; } } };
  await listDeposits(tx, { tenantId, status: "PENDING", deviceId: "tab-a", receivedFrom: "2026-11-04T10:00:00.000Z" });
  assert.equal(calls[0].where.deviceId, "tab-a");
  assert.equal(calls[0].where.receivedAt.gte.toISOString(), "2026-11-04T10:00:00.000Z");
  await listDeposits(tx, { tenantId, status: "PENDING" });
  assert.deepEqual(Object.keys(calls[1].where).sort(), ["status", "tenantId"]);
  for (const bad of ["", "a b", "x".repeat(81), "é"])
    await assert.rejects(listDeposits(tx, { tenantId, deviceId: bad }), (e: any) => e.message === "INVALID_DEVICE_ID" && e.status === 400);
  await listDeposits(tx, { tenantId, receivedFrom: "2026-11-04" });
  assert.equal(calls.at(-1).where.receivedAt.gte.toISOString(), "2026-11-04T00:00:00.000Z", "date seule = UTC");
  await listDeposits(tx, { tenantId, receivedFrom: "2026-11-04T10:00:00+11:00" });
  assert.equal(calls.at(-1).where.receivedAt.gte.toISOString(), "2026-11-03T23:00:00.000Z");
  for (const bad of ["hier", "2026-13-45", "2026-11-04T25:00:00Z", "12345", "2026-11-04T10:00:00", "2026-11-04T10:00"])
    await assert.rejects(listDeposits(tx, { tenantId, receivedFrom: bad }), (e: any) => e.message === "INVALID_RECEIVED_FROM" && e.status === 400);
});
test("K6 format 1 sans appareil (vieille tablette, lot sans actions) → APPLIED, resultJson null, sans signalement", async () => {
  const f = fixture(), legacy = v1();
  await depositActions(f.tx, { tenantId, actions: [legacy] });
  const r = await depositActions(f.tx, { tenantId, actions: [], applied: [{ actionId: legacy.actionId, resultJson: { saleId: "s" } }] });
  assert.deepEqual(r.appliedIgnores, []);
  assert.equal(f.rows.get(legacy.actionId).status, "APPLIED"); assert.equal(f.rows.get(legacy.actionId).resultJson, null);
});
// Garde du filtre de service de depositState : un resultJson en base n'est servi que pour format 2 + lastResultCode 'APPLIED'.
test("depositState : resultJson d'avant (format 1, ou format 2 sans lastResultCode 'APPLIED') jamais servi ; format 2 'APPLIED' servi", async () => {
  const f = fixture(), old = v1(), legacyV2 = v2(1), byTablet = v2(2), server = v2(3);
  await depositActions(f.tx, { tenantId, actions: [old, legacyV2, byTablet, server] });
  const seed = (id: string, extra: any) => f.rows.set(id, { ...f.rows.get(id), status: "APPLIED", appliedAt: new Date(), ...extra });
  seed(old.actionId, { resultJson: { saleId: "ancien-f1" }, lastResultCode: "APPLIED" });
  seed(legacyV2.actionId, { resultJson: { saleId: "ancien-f2" }, lastResultCode: null });
  seed(byTablet.actionId, { resultJson: { saleId: "tablette" }, lastResultCode: "APPLIED_PAR_TABLETTE" });
  seed(server.actionId, { resultJson: { saleId: "serveur" }, lastResultCode: "APPLIED" });
  const ids = [old.actionId, legacyV2.actionId, byTablet.actionId, server.actionId];
  const expected = [old, legacyV2, byTablet].map(x => ({ actionId: x.actionId, status: "APPLIED" }))
    .concat([{ actionId: server.actionId, status: "APPLIED", resultJson: { saleId: "serveur" } } as any]);
  const st = await depositStatuses(f.tx, { tenantId, actionIds: ids });
  const byId = new Map(st.items.map((i: any) => [i.actionId, JSON.parse(JSON.stringify(i))]));
  assert.deepEqual(ids.map(id => byId.get(id)), expected, "/status");
  const r = await depositActions(f.tx, { tenantId, actions: [old, legacyV2, byTablet, server] });
  assert.deepEqual(JSON.parse(JSON.stringify(r.results)).map(({ result, ...x }: any) => x), expected, "réponse du dépôt");
});
