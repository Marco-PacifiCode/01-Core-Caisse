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
    assert.deepEqual({ ...first.items[0].dependencies[a2.actionId] }, { status: "PENDING", resultJson: null });
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
test("applied accusé par la tablette : objet avec resultJson, ligne APPLIED jamais réécrite", async () => {
  const tenantId = randomUUID();
  await rolledBack(tenantId, async tx => {
    const a = v2("tab-a", 1), b = v2("tab-a", 2);
    await deposits.depositActions(tx, { tenantId, actions: [a, b] });
    await deposits.depositActions(tx, { tenantId, actions: [], applied: [a.actionId, { actionId: b.actionId, resultJson: { saleId: "s-1" } }] });
    const find = (actionId: string) => tx.cashDeposit.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } });
    const ra = await find(a.actionId), rb = await find(b.actionId);
    assert.equal(ra!.status, "APPLIED"); assert.equal(ra!.resultJson, null);
    assert.equal(rb!.status, "APPLIED"); assert.deepEqual(rb!.resultJson, { saleId: "s-1" }); assert.equal(rb!.lastResultCode, "APPLIED"); assert.ok(rb!.lastAttemptAt);
    await deposits.depositActions(tx, { tenantId, actions: [], applied: [{ actionId: b.actionId, resultJson: { saleId: "s-2" } }] });
    const again = await find(b.actionId);
    assert.deepEqual(again!.resultJson, { saleId: "s-1" }); assert.equal(again!.appliedAt!.getTime(), rb!.appliedAt!.getTime());
    await assert.rejects(deposits.depositActions(tx, { tenantId, actions: [], applied: [{ actionId: b.actionId }] }), (e: any) => e.message === "INVALID_APPLIED");
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
