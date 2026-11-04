import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { Prisma, PrismaClient } from "@prisma/client";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base de recette uniquement)");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });
type Tx = Prisma.TransactionClient;
const require = createRequire(import.meta.url), lib = fileURLToPath(new URL("../lib/", import.meta.url));
const now = new Date();
class Clock extends Date {
  constructor(value?: string | number | Date) { super(value === undefined ? now.getTime() : value instanceof Date ? value.getTime() : value); }
  static now() { return now.getTime(); }
}
let currentTx: Tx | null = null;
function realTransaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  }, { maxWait: 10000, timeout: 20000 });
}
function transaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return currentTx ? fn(currentTx) : realTransaction(tenantId, fn);
}
const native: Record<string, any> = {}, cache = new Map<string, any>();
function load(file: string): any {
  const path = resolve(lib, file.replace(/\.ts$/, "") + ".ts");
  if (path === resolve(lib, "tenant.ts")) return { withTenant: transaction };
  if (path === resolve(lib, "caisse.ts")) return native;
  if (cache.has(path)) return cache.get(path);
  const module = { exports: {} as any }; cache.set(path, module.exports);
  const source = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const run = vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { Date: Clock, Error, Promise, Map, Set, WeakMap,
    BigInt, JSON, Number, String, Object, Array, Buffer, URL, URLSearchParams, console: { warn() {}, log() {}, error() {} } });
  run((name: string) => name.startsWith(".") ? load(resolve(dirname(path), name)) : require(name), module, module.exports);
  return module.exports;
}
const globals: Record<string, any> = { Date: Clock, Error, BigInt, Prisma, randomUUID, createHash, withTenant: transaction };
for (const file of ["cash-day-projection", "caisse-sync", "cash-day-guard", "cash-day-ledger", "sale-lock", "money", "cash-movement", "gift-card", "z-report", "credit", "sync", "partial-refund", "partial-refund-db"]) Object.assign(globals, load(file));
globals.comptaClient = () => ({ creditNote: async () => ({}), receiptUrl: () => null });
globals.syncLoadedSale = async () => ({ synced: true, failure: null, stopped: null, invoiceId: null, invoiceNumber: null, stockDecremented: 0, neutralized: false, settledOnVoidingSale: false, stockOnVoidingSale: false });
globals.log = { warn() {}, error() {} }; globals.assertTenantId = (value: string) => value;
const context = vm.createContext(globals), caisseSource = readFileSync(resolve(lib, "caisse.ts"), "utf8");
for (const name of ["openSessionTx", "closeSessionTx", "currentSession", "openSaleSession", "recordCashMovement", "getSale", "checkoutSale", "rembourserPartiellement"]) {
  const start = caisseSource.indexOf(`export async function ${name}(`), end = caisseSource.indexOf("\nexport ", start + 10);
  assert.ok(start >= 0, name);
  const js = ts.transpileModule(caisseSource.slice(start, end < 0 ? undefined : end).replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  native[name] = globals[name] = vm.runInContext(`${js}\n${name}`, context);
}
const days = load("cash-days"), ledger = load("cash-day-ledger"), projection = load("cash-day-projection");
function input(tenantId: string, occurredAt: Date, extra: Record<string, unknown> = {}) {
  return { tenantId, actionId: randomUUID(), entityKey: "day", deviceId: "synthetic-rectification", deviceName: "Test",
    occurredAt: occurredAt.toISOString(), businessDay: projection.businessDay(occurredAt), actorId: tenantId,
    actorName: "Administrateur recette", receivedById: tenantId, sourceKey: randomUUID(), localSessionKey: randomUUID(),
    openingFloatXpf: "25000", ...extra };
}
const deposits = load("cash-deposits");
// Tout se joue dans une transaction annulée à la fin (aucune trace en base), sauf le test de concurrence.
async function rolledBack(tenantId: string, fn: (tx: Tx) => Promise<void>) {
  const rollback = new Error("ROLLBACK_DEPOSIT_APPLY_TEST");
  await assert.rejects(realTransaction(tenantId, async tx => {
    currentTx = tx;
    try { await fn(tx); throw rollback; } finally { currentTx = null; }
  }), error => error === rollback);
}
const asTenant = (tx: Tx, tenantId: string) => tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
const v2 = (deviceId: string, sequence: number, extra: Record<string, unknown> = {}) => ({ actionId: randomUUID(), deviceId, kind: "SALE",
  payload: { sequence }, formatVersion: 2, sequence, actorId: "actor-1", actorName: "Alice", receivedById: "recv-1", ...extra });
const legacy = () => ({ actionId: randomUUID(), deviceId: "tablette-v1", kind: "SALE", payload: { legacy: true } });
const code = (e: any, c: string) => e?.message === c && e?.status === 409;
const closeInput = (tenantId: string) => input(tenantId, new Date("2026-10-30T19:25:00.000Z"), {
  cycle: 0, countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0", closureMode: "ONLINE", legacySnapshot: "archive",
});

test("rôle applicatif soumis à la RLS", async () => {
  const [{ bypass }] = await prisma.$queryRaw<{ bypass: boolean }[]>`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  assert.equal(bypass, false, "le test exige le rôle applicatif RLS");
});
test("bail exclusif entre deux transactions concurrentes", async () => {
  const tenantId = randomUUID();
  try {
    const outcomes = await Promise.allSettled(["surface-a", "surface-b"].map(holder =>
      realTransaction(tenantId, tx => deposits.claimDeposits(tx, { tenantId, holder, limit: 10 }))));
    assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
    const refused = outcomes.find(o => o.status === "rejected") as PromiseRejectedResult;
    assert.ok(code(refused.reason, "LEASE_HELD"));
  } finally { await realTransaction(tenantId, tx => tx.cashDepositLease.updateMany({ where: { tenantId }, data: { until: new Date(0) } })); }
});
test("bail expiré repris, ordre, format 1 marqué REJEU_TABLETTE, dépendances", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a2 = v2("tab-a", 2), a1 = v2("tab-a", 1, { dependsOn: [a2.actionId] }), b0 = v2("tab-b", 0), old = legacy();
    await deposits.depositActions(tx, { tenantId, actions: [a2, b0, old, a1] });
    const first = await deposits.claimDeposits(tx, { tenantId, holder: "surface-a", limit: 10 });
    assert.deepEqual(first.items.map((i: any) => i.actionId), [a1.actionId, a2.actionId, b0.actionId]);
    assert.deepEqual({ ...first.items[0].dependencies[a2.actionId] }, { status: "PENDING", resultJson: null, lastResultCode: null, formatVersion: 2 });
    const oldRow = await tx.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId: old.actionId } } });
    assert.equal(oldRow!.status, "PENDING"); assert.equal(oldRow!.lastResultCode, "REJEU_TABLETTE"); assert.equal(oldRow!.attempts, 0);
    await assert.rejects(deposits.claimDeposits(tx, { tenantId, holder: "surface-b", limit: 10 }), (e: any) => code(e, "LEASE_HELD"));
    await tx.$executeRaw`UPDATE "CashDepositLease" SET "until" = ${new Date(now.getTime() - 1000)} WHERE "tenantId" = ${tenantId}::uuid`;
    const taken = await deposits.claimDeposits(tx, { tenantId, holder: "surface-b", limit: 1 });
    assert.notEqual(taken.token, first.token); assert.equal(taken.items.length, 1);
    await assert.rejects(deposits.recordDepositResult(tx, { tenantId, token: first.token, actionId: a1.actionId, outcome: "APPLIED", resultJson: {} }),
      (e: any) => code(e, "LEASE_LOST"));
  });
});
test("result : sans token valide LEASE_LOST, APPLIED immuable, REFUSED reste PENDING", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a = v2("tab-a", 1), b = v2("tab-a", 2);
    await deposits.depositActions(tx, { tenantId, actions: [a, b] });
    await assert.rejects(deposits.recordDepositResult(tx, { tenantId, token: randomUUID(), actionId: a.actionId, outcome: "APPLIED", resultJson: {} }),
      (e: any) => code(e, "LEASE_LOST"));
    const { token } = await deposits.claimDeposits(tx, { tenantId, holder: "surface-a", limit: 10 });
    await deposits.recordDepositResult(tx, { tenantId, token, actionId: b.actionId, outcome: "REFUSED", code: "STOCK", reason: "rupture" });
    const refused = await tx.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId: b.actionId } } });
    assert.equal(refused!.status, "PENDING"); assert.equal(refused!.attempts, 1); assert.equal(refused!.lastResultCode, "STOCK");
    await deposits.recordDepositResult(tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s-1" } });
    const again = await deposits.recordDepositResult(tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s-1" } });
    assert.equal(again.idempotent, true);
    await assert.rejects(deposits.recordDepositResult(tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s-2" } }),
      (e: any) => code(e, "ALREADY_APPLIED"));
    const applied = await tx.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId: a.actionId } } });
    assert.equal(applied!.status, "APPLIED"); assert.deepEqual(applied!.resultJson, { saleId: "s-1" }); assert.equal(applied!.attempts, 1);
    assert.deepEqual({ ...(await deposits.releaseLease(tx, { tenantId, token })) }, { released: true });
  });
});
test("isolation RLS : le claim du commerce A ne voit jamais les dépôts de B", async () => {
  const tenantA = randomUUID(), tenantB = randomUUID();
  await rolledBack(tenantB, async tx => {
    await deposits.depositActions(tx, { tenantId: tenantB, actions: [v2("tab-b", 1)] });
    await asTenant(tx, tenantA);
    const claimed = await deposits.claimDeposits(tx, { tenantId: tenantA, holder: "surface-a", limit: 100 });
    assert.equal(claimed.items.length, 0);
    assert.equal(await tx.cashDepositLease.count({ where: { tenantId: tenantB } }), 0);
    await assert.rejects(tx.cashDepositLease.create({ data: { tenantId: tenantB, holder: "x", token: randomUUID(), until: now } }));
  });
});
test("enveloppe format 2 hors payloadHash : même payload, autre auteur → seen", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a = v2("tab-a", 1, { actorName: null });
    await deposits.depositActions(tx, { tenantId, actions: [a] });
    const r = await deposits.depositActions(tx, { tenantId, actions: [{ ...a, actorId: "actor-2", actorName: "Bob" }] });
    assert.equal(r.results[0].result, "seen");
    const row = await tx.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId: a.actionId } } });
    assert.equal(row!.actorId, "actor-1"); assert.equal(row!.actorName, "Bob"); assert.equal(row!.conflictCount, 0);
    assert.equal(row!.formatVersion, 2); assert.equal(row!.sequence, 1n);
  });
});
// R1 (04/11) : ce test portait l'ancien comportement sur des lignes de format 2 ; il ne vaut plus que pour le format 1.
// K2 (relecture 2) : le resultJson d'un accusé de la tablette n'est plus jamais stocké, même en format 1.
test("applied format 1 accusé par la tablette : objet → APPLIED sans resultJson stocké, ligne APPLIED jamais réécrite", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a = legacy(), b = legacy();
    await deposits.depositActions(tx, { tenantId, actions: [a, b] });
    await deposits.depositActions(tx, { tenantId, deviceId: "tablette-v1", actions: [], applied: [a.actionId, { actionId: b.actionId, resultJson: { saleId: "s-1" } }] });
    const find = (actionId: string) => tx.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } });
    const ra = await find(a.actionId), rb = await find(b.actionId);
    assert.equal(ra!.status, "APPLIED"); assert.equal(ra!.resultJson, null);
    assert.equal(rb!.status, "APPLIED"); assert.equal(rb!.resultJson, null); assert.equal(rb!.lastResultCode, null);
    assert.deepEqual(JSON.parse(JSON.stringify((await deposits.depositStatuses(tx, { tenantId, actionIds: [b.actionId] })).items)), [{ actionId: b.actionId, status: "APPLIED" }]);
    await deposits.depositActions(tx, { tenantId, deviceId: "tablette-v1", actions: [], applied: [{ actionId: b.actionId, resultJson: { saleId: "s-2" } }] });
    const again = await find(b.actionId);
    assert.equal(again!.resultJson, null); assert.equal(again!.appliedAt!.getTime(), rb!.appliedAt!.getTime());
    await assert.rejects(deposits.depositActions(tx, { tenantId, actions: [], applied: [{ actionId: b.actionId }] }), (e: any) => e.message === "INVALID_APPLIED");
  });
});
test("réponse du dépôt : status/resultJson après l'opération, conflict, isolation de tenant", async () => {
  const tenantA = randomUUID(), tenantB = randomUUID();
  await rolledBack(tenantB, async tx => {
    const a = v2("tab-a", 1), b = v2("tab-a", 2), c = v2("tab-a", 3);
    // B : la même action, avec un accusé de la tablette (ignoré depuis R1, ligne PENDING) ; A ne doit jamais la voir.
    await deposits.depositActions(tx, { tenantId: tenantB, actions: [a] });
    await deposits.depositActions(tx, { tenantId: tenantB, actions: [], applied: [{ actionId: a.actionId, resultJson: { saleId: "b" } }] });
    await asTenant(tx, tenantA);
    const first = await deposits.depositActions(tx, { tenantId: tenantA, actions: [a, b, c] });
    assert.deepEqual(JSON.parse(JSON.stringify(first.results)), [a, b, c].map(x => ({ actionId: x.actionId, result: "stored", status: "PENDING" })));
    const { token } = await deposits.claimDeposits(tx, { tenantId: tenantA, holder: "s", limit: 10 });
    await deposits.recordDepositResult(tx, { tenantId: tenantA, token, actionId: b.actionId, outcome: "APPLIED", resultJson: { saleId: "s-1" } });
    // R1 : l'accusé n'est honoré que si le serveur a renoncé, et seulement pour l'appareil de la ligne.
    await tx.cashDeposit.update({ where: { tenantId_actionId: { tenantId: tenantA, actionId: c.actionId } }, data: { lastResultCode: "REJEU_TABLETTE" } });
    await deposits.depositActions(tx, { tenantId: tenantA, deviceId: "tab-a", actions: [], applied: [c.actionId] });
    const r = await deposits.depositActions(tx, { tenantId: tenantA, actions: [b, c, { ...a, payload: { autre: true } }] });
    assert.deepEqual(JSON.parse(JSON.stringify(r.results)), [
      { actionId: b.actionId, result: "seen", status: "APPLIED", resultJson: { saleId: "s-1" } },
      { actionId: c.actionId, result: "seen", status: "PENDING" }, // K1 : l'accusé de la tablette ne change jamais une ligne de format 2
      { actionId: a.actionId, result: "conflict", status: "PENDING" },
    ]);
  });
});
const counts = async (tx: Tx, tenantId: string, cashDayId: string) => ({
  openings: await tx.cashDayOpening.count({ where: { tenantId, cashDayId } }),
  openingFacts: await tx.cashDayEvent.count({ where: { tenantId, cashDayId, kind: "OPENING" } }),
  conflicts: await tx.cashDeposit.count({ where: { tenantId, kind: "conflit", operation: "OUVERTURE_JOUR_CLOS" } }),
});
test("Q5 : ouverture sur journée CLOSED → 2xx, 0 OPENING, 0 CashDayOpening, 1 conflit, même rejouée 3 fois", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const opened = await days.openCashDay(tx, input(tenantId, new Date("2026-10-29T23:00:00.000Z")));
    await days.closeCashDay(tx, opened.id, closeInput(tenantId));
    const before = await counts(tx, tenantId, opened.id);
    const late = input(tenantId, new Date("2026-10-30T05:00:00.000Z"));
    for (let i = 0; i < 3; i++) {
      const r = await days.openCashDay(tx, late);
      assert.equal(r.id, opened.id); assert.equal(r.status, "CLOSED"); assert.ok("fondRetenu" in r && "fondNonRetenu" in r);
    }
    const after = await counts(tx, tenantId, opened.id);
    assert.equal(after.openings, before.openings); assert.equal(after.openingFacts, before.openingFacts); assert.equal(after.conflicts, 1);
  });
});
test("Q5 : ouverture sur journée OPEN inchangée ; rejeu d'une ouverture appliquée avant le Z identique", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const first = input(tenantId, new Date("2026-10-29T23:00:00.000Z"));
    const opened = await days.openCashDay(tx, first);
    const second = await days.openCashDay(tx, input(tenantId, new Date("2026-10-29T23:05:00.000Z")));
    assert.equal(second.status, "OPEN");
    let c = await counts(tx, tenantId, opened.id);
    assert.equal(c.openings, 2); assert.equal(c.openingFacts, 2); assert.equal(c.conflicts, 0);
    await days.closeCashDay(tx, opened.id, closeInput(tenantId));
    const replay = await days.openCashDay(tx, first);
    assert.equal(replay.id, opened.id); assert.equal(replay.status, "CLOSED");
    c = await counts(tx, tenantId, opened.id);
    assert.equal(c.openings, 2); assert.equal(c.openingFacts, 2); assert.equal(c.conflicts, 0);
  });
});
test("status : états réels, projection limitée, inconnu absent, 400, isolation RLS entre commerces", async () => {
  const tenantA = randomUUID(), tenantB = randomUUID();
  await rolledBack(tenantA, async tx => {
    // K1 (relecture 2) : seule une ligne de format 1 peut être APPLIED sans resultJson par accusé de la tablette.
    const applied = v2("tab-a", 1), pending = v2("tab-a", 2), bare = legacy();
    await deposits.depositActions(tx, { tenantId: tenantA, actions: [applied, pending, bare] });
    const { token } = await deposits.claimDeposits(tx, { tenantId: tenantA, holder: "surface-a", limit: 10 });
    await deposits.recordDepositResult(tx, { tenantId: tenantA, token, actionId: applied.actionId, outcome: "APPLIED", resultJson: { saleId: "s-1" } });
    await deposits.depositActions(tx, { tenantId: tenantA, deviceId: "tablette-v1", actions: [], applied: [{ actionId: bare.actionId, resultJson: { saleId: "tablette" } }] });
    const unknown = randomUUID();
    const r = await deposits.depositStatuses(tx, { tenantId: tenantA, actionIds: [applied.actionId, pending.actionId, bare.actionId, unknown, applied.actionId] });
    const byId = new Map(r.items.map((i: any) => [i.actionId, i]));
    assert.equal(r.items.length, 3); assert.ok(!byId.has(unknown));
    assert.deepEqual(JSON.parse(JSON.stringify(byId.get(applied.actionId))), { actionId: applied.actionId, status: "APPLIED", resultJson: { saleId: "s-1" } });
    assert.deepEqual({ ...byId.get(pending.actionId) }, { actionId: pending.actionId, status: "PENDING" });
    assert.deepEqual({ ...byId.get(bare.actionId) }, { actionId: bare.actionId, status: "APPLIED" });
    for (const i of r.items) assert.ok(Object.keys(i).every(k => ["actionId", "status", "resultJson"].includes(k)));
    for (const bad of [{ tenantId: tenantA, actionIds: [] }, { tenantId: tenantA, actionIds: Array.from({ length: 1001 }, () => randomUUID()) }, { tenantId: tenantA, actionIds: ["x"] }])
      await assert.rejects(deposits.depositStatuses(tx, bad), (e: any) => e?.status === 400);
    // Commerce B : ni par son propre tenantId (RLS), ni en demandant les ids de A.
    await asTenant(tx, tenantB);
    const fromB = await deposits.depositStatuses(tx, { tenantId: tenantB, actionIds: [applied.actionId, pending.actionId] });
    assert.equal(fromB.items.length, 0);
    const forged = await deposits.depositStatuses(tx, { tenantId: tenantA, actionIds: [applied.actionId] });
    assert.equal(forged.items.length, 0);
  });
});
// ---- Relecture 1 : R1 (qui peut dire APPLIED, garde de l'appareil), R2 (filtre du claim, remise à zéro), R4 (conflictCount) ----
const markPg = (tx: Tx, tenantId: string, actionId: string, lastResultCode: string | null, lastResultReason: string | null = null) =>
  tx.cashDeposit.update({ where: { tenantId_actionId: { tenantId, actionId } }, data: { lastResultCode, lastResultReason } });
const rowPg = (tx: Tx, tenantId: string, actionId: string) => tx.cashDeposit.findUniqueOrThrow({ where: { tenantId_actionId: { tenantId, actionId } } });
// K1/K2 (relecture 2) : encodait l'ancien passage APPLIED par la tablette et le resultJson stocké en format 1.
test("K1/K2 : applied de la tablette sur format 2 (jamais tenté, EN_ATTENTE, REJEU_TABLETTE) → lignes inchangées ; format 1 APPLIED sans resultJson", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const fresh = v2("tab-a", 1), waiting = v2("tab-a", 2), renounced = v2("tab-a", 3), old = legacy(), oldObj = legacy();
    await deposits.depositActions(tx, { tenantId, actions: [fresh, waiting, renounced, old, oldObj] });
    await markPg(tx, tenantId, waiting.actionId, "EN_ATTENTE"); await markPg(tx, tenantId, renounced.actionId, "REJEU_TABLETTE");
    const forged = { cashDayId: randomUUID() };
    await deposits.depositActions(tx, { tenantId, deviceId: "tab-a", actions: [], applied: [
      { actionId: fresh.actionId, resultJson: forged }, { actionId: waiting.actionId, resultJson: forged }, { actionId: renounced.actionId, resultJson: forged }] });
    // K5 : les lignes de format 1 sont accusées par leur propre appareil.
    await deposits.depositActions(tx, { tenantId, deviceId: "tablette-v1", actions: [], applied: [old.actionId, { actionId: oldObj.actionId, resultJson: { saleId: "s" } }] });
    for (const [id, code] of [[fresh.actionId, null], [waiting.actionId, "EN_ATTENTE"], [renounced.actionId, "REJEU_TABLETTE"]] as const) {
      const r = await rowPg(tx, tenantId, id); assert.equal(r.status, "PENDING"); assert.equal(r.resultJson, null); assert.equal(r.lastResultCode, code); }
    assert.equal((await rowPg(tx, tenantId, old.actionId)).status, "APPLIED");
    const ro = await rowPg(tx, tenantId, oldObj.actionId); assert.equal(ro.status, "APPLIED"); assert.equal(ro.resultJson, null);
    const st = await deposits.depositStatuses(tx, { tenantId, actionIds: [fresh.actionId, waiting.actionId, renounced.actionId, oldObj.actionId] });
    for (const i of st.items) assert.ok(!("resultJson" in i), JSON.stringify(i));
  });
});
// K1 (relecture 2) : encodait APPLIED_PAR_TABLETTE pour le même appareil ; la ligne reste désormais inchangée.
test("R1 appareil : AUTRE_APPAREIL inchangé, même appareil inchangé et silencieux, appareil déduit du lot, APPAREIL_INCONNU", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a = v2("tab-a", 1), a2 = v2("tab-a", 2), a3 = v2("tab-a", 3);
    await deposits.depositActions(tx, { tenantId, actions: [a, a2, a3] });
    for (const x of [a, a2]) await markPg(tx, tenantId, x.actionId, "REJEU_TABLETTE");
    const before = await rowPg(tx, tenantId, a.actionId);
    const fromB = await deposits.depositActions(tx, { tenantId, deviceId: "tab-b", actions: [], applied: [a.actionId] });
    assert.deepEqual(JSON.parse(JSON.stringify(fromB.appliedIgnores)), [{ actionId: a.actionId, code: "AUTRE_APPAREIL" }]);
    const after = await rowPg(tx, tenantId, a.actionId);
    assert.equal(after.status, "PENDING"); assert.equal(after.conflictCount, before.conflictCount); assert.equal(after.lastResultCode, "REJEU_TABLETTE");
    const unknown = await deposits.depositActions(tx, { tenantId, actions: [], applied: [a.actionId] });
    assert.deepEqual(JSON.parse(JSON.stringify(unknown.appliedIgnores)), [{ actionId: a.actionId, code: "APPAREIL_INCONNU" }]);
    const same = await deposits.depositActions(tx, { tenantId, deviceId: "tab-a", actions: [], applied: [a.actionId] });
    assert.equal(same.appliedIgnores.length, 0);
    const kept = await rowPg(tx, tenantId, a.actionId); assert.equal(kept.status, "PENDING"); assert.equal(kept.lastResultCode, "REJEU_TABLETTE");
    const inferred = await deposits.depositActions(tx, { tenantId, actions: [a3], applied: [a2.actionId] });
    assert.equal(inferred.appliedIgnores.length, 0); assert.equal((await rowPg(tx, tenantId, a2.actionId)).status, "PENDING");
  });
});
test("R2 : 100 REJEU_TABLETTE puis 1 neuf → claim limit 100 renvoie le neuf ; remise à zéro sur PENDING seulement ; R4 conflictCount", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const old = Array.from({ length: 100 }, (_, i) => v2("tab-a", i + 1));
    await deposits.depositActions(tx, { tenantId, actions: old.slice(0, 50) }); await deposits.depositActions(tx, { tenantId, actions: old.slice(50) });
    await tx.cashDeposit.updateMany({ where: { tenantId, actionId: { in: old.map(o => o.actionId) } }, data: { lastResultCode: "REJEU_TABLETTE" } });
    const fresh = v2("tab-a", 500, { dependsOn: [old[0].actionId] });
    await deposits.depositActions(tx, { tenantId, actions: [fresh] });
    const c = await deposits.claimDeposits(tx, { tenantId, holder: "surface-a", limit: 100 });
    assert.deepEqual(c.items.map((i: any) => i.actionId), [fresh.actionId]);
    assert.deepEqual({ ...c.items[0].dependencies[old[0].actionId] }, { status: "PENDING", resultJson: null, lastResultCode: "REJEU_TABLETTE", formatVersion: 2 });
    assert.equal(c.items[0].conflictCount, 0);
    // Remise à zéro de la marque par un redépôt seen dont clientState change.
    const e = v2("tab-a", 600, { clientState: "error" }), done = v2("tab-a", 601, { clientState: "error" });
    await deposits.depositActions(tx, { tenantId, actions: [e, done] });
    await markPg(tx, tenantId, e.actionId, "NON_APPLICABLE_ERROR", "erreur tablette");
    await deposits.depositActions(tx, { tenantId, actions: [{ ...e, clientState: "pending" }] });
    const re = await rowPg(tx, tenantId, e.actionId); assert.equal(re.lastResultCode, null); assert.equal(re.lastResultReason, null);
    const { token } = await deposits.claimDeposits(tx, { tenantId, holder: "surface-a", limit: 100 });
    await deposits.recordDepositResult(tx, { tenantId, token, actionId: done.actionId, outcome: "APPLIED", resultJson: { saleId: "s-9" } });
    await deposits.depositActions(tx, { tenantId, actions: [{ ...done, clientState: "pending" }] });
    assert.equal((await rowPg(tx, tenantId, done.actionId)).lastResultCode, "APPLIED");
    // R4 : redépôt au payload différent → conflictCount 1 visible dans le claim.
    assert.equal((await deposits.depositActions(tx, { tenantId, actions: [{ ...e, payload: { annule: true } }] })).results[0].result, "conflict");
    const again = await deposits.claimDeposits(tx, { tenantId, holder: "surface-a", limit: 100 });
    const item = again.items.find((i: any) => i.actionId === e.actionId);
    assert.ok(item, "re-claimable après remise à zéro"); assert.equal(item.conflictCount, 1);
  });
});
test("R1 appareil avant C1 : B sur ligne de A (jamais tentée, EN_ATTENTE, REJEU_TABLETTE) → AUTRE_APPAREIL ; A sur sa ligne jamais tentée → silence ; inconnu → APPAREIL_INCONNU", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const fresh = v2("tab-a", 1), waiting = v2("tab-a", 2), renounced = v2("tab-a", 3);
    await deposits.depositActions(tx, { tenantId, actions: [fresh, waiting, renounced] });
    await markPg(tx, tenantId, waiting.actionId, "EN_ATTENTE"); await markPg(tx, tenantId, renounced.actionId, "REJEU_TABLETTE");
    const ids = [fresh.actionId, waiting.actionId, renounced.actionId];
    const before = await Promise.all(ids.map(id => rowPg(tx, tenantId, id)));
    const fromB = await deposits.depositActions(tx, { tenantId, deviceId: "tab-b", actions: [], applied: ids.map(actionId => ({ actionId, resultJson: { saleId: "faux" } })) });
    const got = JSON.parse(JSON.stringify(fromB.appliedIgnores)).sort((x: any, y: any) => x.actionId.localeCompare(y.actionId));
    assert.deepEqual(got, [...ids].sort().map(actionId => ({ actionId, code: "AUTRE_APPAREIL" })));
    for (const [i, id] of ids.entries()) { const r = await rowPg(tx, tenantId, id);
      assert.equal(r.status, "PENDING"); assert.equal(r.resultJson, null); assert.equal(r.lastResultCode, before[i].lastResultCode); assert.equal(r.conflictCount, before[i].conflictCount); }
    const own = await deposits.depositActions(tx, { tenantId, deviceId: "tab-a", actions: [], applied: [fresh.actionId] });
    assert.equal(own.appliedIgnores.length, 0);
    const r = await rowPg(tx, tenantId, fresh.actionId); assert.equal(r.status, "PENDING"); assert.equal(r.lastResultCode, null);
    const unknown = await deposits.depositActions(tx, { tenantId, actions: [], applied: [fresh.actionId] });
    assert.deepEqual(JSON.parse(JSON.stringify(unknown.appliedIgnores)), [{ actionId: fresh.actionId, code: "APPAREIL_INCONNU" }]);
    assert.equal((await rowPg(tx, tenantId, fresh.actionId)).status, "PENDING");
  });
});

// ---- Relecture 2 : K2 (resultJson servi seulement si posé par /result), K3 (dépendances), K4 (filtres de la liste) ----
test("K2/K3 : /result → /status rend le resultJson ; dépendance renoncée exposée avec lastResultCode et formatVersion", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a = v2("tab-a", 1), dep = v2("tab-a", 2), child = v2("tab-a", 3, { dependsOn: [dep.actionId] });
    await deposits.depositActions(tx, { tenantId, actions: [a, dep, child] });
    const { token } = await deposits.claimDeposits(tx, { tenantId, holder: "surface-a", limit: 10 });
    await deposits.recordDepositResult(tx, { tenantId, token, actionId: a.actionId, outcome: "APPLIED", resultJson: { saleId: "s-1" } });
    await deposits.recordDepositResult(tx, { tenantId, token, actionId: dep.actionId, outcome: "REFUSED", code: "REJEU_TABLETTE" });
    const st = await deposits.depositStatuses(tx, { tenantId, actionIds: [a.actionId] });
    assert.deepEqual(JSON.parse(JSON.stringify(st.items)), [{ actionId: a.actionId, status: "APPLIED", resultJson: { saleId: "s-1" } }]);
    const c = await deposits.claimDeposits(tx, { tenantId, holder: "surface-a", limit: 10 });
    const item = c.items.find((i: any) => i.actionId === child.actionId);
    assert.deepEqual({ ...item.dependencies[dep.actionId] }, { status: "PENDING", resultJson: null, lastResultCode: "REJEU_TABLETTE", formatVersion: 2 });
  });
});
test("K4 : listDeposits filtre deviceId et receivedFrom en base ; deviceId invalide → 400", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a = v2("tab-a", 1), b = v2("tab-b", 1);
    await deposits.depositActions(tx, { tenantId, actions: [a, b] });
    await tx.cashDeposit.update({ where: { tenantId_actionId: { tenantId, actionId: a.actionId } }, data: { receivedAt: new Date("2026-01-01T00:00:00.000Z") } });
    const byDevice = await deposits.listDeposits(tx, { tenantId, deviceId: "tab-b" });
    assert.deepEqual(byDevice.items.map((i: any) => i.actionId), [b.actionId]);
    const recent = await deposits.listDeposits(tx, { tenantId, receivedFrom: "2026-06-01T00:00:00.000Z" });
    assert.deepEqual(recent.items.map((i: any) => i.actionId), [b.actionId]);
    const all = await deposits.listDeposits(tx, { tenantId });
    assert.equal(all.items.length, 2);
    await assert.rejects(deposits.listDeposits(tx, { tenantId, deviceId: "a b" }), (e: any) => e?.message === "INVALID_DEVICE_ID" && e?.status === 400);
    await assert.rejects(deposits.listDeposits(tx, { tenantId, receivedFrom: "hier" }), (e: any) => e?.message === "INVALID_RECEIVED_FROM" && e?.status === 400);
  });
});

// ---- K5 : garde de l'appareil sur le format 1, receivedFrom avec fuseau ----
test("K5/K6 format 1 : autre appareil → AUTRE_APPAREIL inchangée ; même appareil → APPLIED ; sans appareil → APPLIED, resultJson null", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const old = legacy();
    await deposits.depositActions(tx, { tenantId, actions: [old] });
    const before = await rowPg(tx, tenantId, old.actionId);
    const fromB = await deposits.depositActions(tx, { tenantId, deviceId: "tab-b", actions: [], applied: [{ actionId: old.actionId, resultJson: { saleId: "faux" } }] });
    assert.deepEqual(JSON.parse(JSON.stringify(fromB.appliedIgnores)), [{ actionId: old.actionId, code: "AUTRE_APPAREIL" }]);
    let r = await rowPg(tx, tenantId, old.actionId);
    assert.equal(r.status, "PENDING"); assert.equal(r.resultJson, null); assert.equal(r.conflictCount, before.conflictCount); assert.equal(r.appliedAt, null);
    const own = await deposits.depositActions(tx, { tenantId, deviceId: "tablette-v1", actions: [], applied: [{ actionId: old.actionId, resultJson: { saleId: "s" } }] });
    assert.equal(own.appliedIgnores.length, 0);
    r = await rowPg(tx, tenantId, old.actionId); assert.equal(r.status, "APPLIED"); assert.equal(r.resultJson, null);
    // K6 : vieille tablette sans deviceId, lot sans actions → APPLIED comme avant, sans signalement.
    const old2 = legacy();
    await deposits.depositActions(tx, { tenantId, actions: [old2] });
    const none = await deposits.depositActions(tx, { tenantId, actions: [], applied: [{ actionId: old2.actionId, resultJson: { saleId: "s" } }] });
    assert.equal(none.appliedIgnores.length, 0);
    const r2 = await rowPg(tx, tenantId, old2.actionId); assert.equal(r2.status, "APPLIED"); assert.equal(r2.resultJson, null);
  });
});
test("K5 : receivedFrom sans fuseau → 400, date seule et fuseau explicite acceptés", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    for (const bad of ["2026-11-04T10:00:00", "2026-11-04T10:00"])
      await assert.rejects(deposits.listDeposits(tx, { tenantId, receivedFrom: bad }), (e: any) => e?.message === "INVALID_RECEIVED_FROM" && e?.status === 400);
    for (const ok of ["2026-11-04", "2026-11-04T10:00:00Z", "2026-11-04T10:00:00+11:00"])
      assert.ok(Array.isArray((await deposits.listDeposits(tx, { tenantId, receivedFrom: ok })).items));
  });
});
test("depositState en base : resultJson d'avant (format 1, ou format 2 sans lastResultCode 'APPLIED') jamais servi ; format 2 'APPLIED' servi", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const old = legacy(), legacyV2 = v2("tab-a", 1), byTablet = v2("tab-a", 2), server = v2("tab-a", 3);
    await deposits.depositActions(tx, { tenantId, actions: [old, legacyV2, byTablet, server] });
    const seed = (actionId: string, resultJson: Record<string, string>, lastResultCode: string | null) =>
      tx.cashDeposit.update({ where: { tenantId_actionId: { tenantId, actionId } }, data: { status: "APPLIED", appliedAt: now, resultJson, lastResultCode } });
    await seed(old.actionId, { saleId: "ancien-f1" }, "APPLIED");
    await seed(legacyV2.actionId, { saleId: "ancien-f2" }, null);
    await seed(byTablet.actionId, { saleId: "tablette" }, "APPLIED_PAR_TABLETTE");
    await seed(server.actionId, { saleId: "serveur" }, "APPLIED");
    const ids = [old.actionId, legacyV2.actionId, byTablet.actionId, server.actionId];
    const expected: any[] = [old, legacyV2, byTablet].map(x => ({ actionId: x.actionId, status: "APPLIED" }));
    expected.push({ actionId: server.actionId, status: "APPLIED", resultJson: { saleId: "serveur" } });
    const st = await deposits.depositStatuses(tx, { tenantId, actionIds: ids });
    const byId = new Map(JSON.parse(JSON.stringify(st.items)).map((i: any) => [i.actionId, i]));
    assert.deepEqual(ids.map(id => byId.get(id)), expected, "/status");
    const r = await deposits.depositActions(tx, { tenantId, actions: [old, legacyV2, byTablet, server] });
    assert.deepEqual(JSON.parse(JSON.stringify(r.results)).map(({ result, ...x }: any) => x), expected, "réponse du dépôt");
  });
});
