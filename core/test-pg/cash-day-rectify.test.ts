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
async function fixture(fn: (tx: Tx, tenantId: string, dayId: string) => Promise<void>) {
  const tenantId = randomUUID(), rollback = new Error("ROLLBACK_RECTIFICATION_TEST");
  await assert.rejects(transaction(tenantId, async tx => {
    currentTx = tx;
    try {
      const opened = await days.openCashDay(tx, input(tenantId, new Date("2026-10-29T23:00:00.000Z")));
      const closed = await days.closeCashDay(tx, opened.id, input(tenantId, new Date("2026-10-30T19:25:00.000Z"), {
        cycle: 0, countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0", closureMode: "ONLINE", legacySnapshot: "archive",
      }));
      assert.ok(closed.id);
      await fn(tx, tenantId, opened.id);
      throw rollback;
    } finally { currentTx = null; }
  }), error => error === rollback);
}
function rectifyInput(tenantId: string, extra: Record<string, unknown> = {}) {
  return { ...input(tenantId, now), actionId: randomUUID(), administration: true, countedXpf: "105700",
    motif: "Réception des ventes après le Z initial", ...extra };
}

test("rectification PG : 56 ventes tardives, idempotence, immutabilité, vente ultérieure et tenant RLS", async () => fixture(async (tx, tenantId, dayId) => {
  const firstClosure = await tx.cashDayClosure.findFirstOrThrow({ where: { tenantId, cashDayId: dayId } });
  const firstEvents = await tx.cashDayEvent.findMany({ where: { tenantId, cashDayId: dayId }, orderBy: { sequence: "asc" } });
  const concurrentSession = await tx.cashSession.create({ data: { tenantId, openedBy: tenantId, openedByName: "Autre caisse",
    openedAt: now, openingFloatXpf: 0n } });
  for (let index = 0; index < 56; index++) {
    const amount = index === 0 ? 80700 : 0;
    const lines = [{ lineXpf: String(amount), tgcRatePpm: 0 }];
    await ledger.appendDayFact(tx, tenantId, dayId, { kind: "SALE_PAID", sourceRef: `late-sale-${index}`,
      deviceId: "late-device", occurredAt: new Date("2026-10-30T20:00:00.000Z"), snapshot: { totalXpf: String(amount), lines,
        parTaux: projection.taxes(lines), payments: [{ method: "CASH", amountXpf: String(amount) }] } });
  }
  const request = rectifyInput(tenantId);
  const first = await days.rectifyCashDay(tx, dayId, request);
  const closureCountAfterFirst = await tx.cashDayClosure.count({ where: { tenantId, cashDayId: dayId } });
  const eventCountAfterFirst = await tx.cashDayEvent.count({ where: { tenantId, cashDayId: dayId } });
  const replay = await days.rectifyCashDay(tx, dayId, request);
  assert.equal(first.alreadyApplied, false); assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.closureId, first.closureId); assert.equal(replay.revision, first.revision);
  assert.equal(await tx.cashDayClosure.count({ where: { tenantId, cashDayId: dayId } }), closureCountAfterFirst);
  assert.equal(await tx.cashDayEvent.count({ where: { tenantId, cashDayId: dayId } }), eventCountAfterFirst);
  assert.equal((await tx.cashSession.findFirstOrThrow({ where: { tenantId, id: concurrentSession.id } })).status, "OPEN");
  assert.equal(first.report.expectedXpf, "105700"); assert.equal(first.report.varianceXpf, "0");
  const newClosure = await tx.cashDayClosure.findFirstOrThrow({ where: { tenantId, cashDayId: dayId, cycle: 1 } });
  assert.equal(newClosure.countedXpf, 105700n); assert.equal(newClosure.authoritative, true);
  assert.equal(newClosure.closureMode, "ONLINE"); assert.equal(newClosure.baselineExpectedXpf, 105700n);
  assert.equal((newClosure.legacySnapshot as any).rectification.motif, request.motif);
  assert.equal((newClosure.legacySnapshot as any).rectification.remplaceClosureId, firstClosure.id);
  assert.deepEqual(await tx.cashDayClosure.findFirstOrThrow({ where: { tenantId, id: firstClosure.id } }), firstClosure);
  const eventsAfter = await tx.cashDayEvent.findMany({ where: { tenantId, cashDayId: dayId, sequence: { lte: BigInt(firstEvents.length) } }, orderBy: { sequence: "asc" } });
  assert.deepEqual(eventsAfter, firstEvents);
  const state = await days.dayState(tx, tenantId, dayId); assert.equal(state.status, "CLOSED");
  const ledgerPage = await days.ledgerPage(tx, tenantId, dayId, new URLSearchParams());
  assert.equal(ledgerPage.projection.ecartZ, 0n);
  assert.equal(ledgerPage.projection.zRemplaces[0].id, firstClosure.id);
  assert.equal(ledgerPage.projection.zRemplaces[0].remplacéPar, newClosure.id);

  const thirdSale = [{ lineXpf: "500", tgcRatePpm: 0 }];
  await ledger.appendDayFact(tx, tenantId, dayId, { kind: "SALE_PAID", sourceRef: "sale-after-rectification", deviceId: "late-device",
    occurredAt: new Date("2026-10-30T20:00:00.000Z"), snapshot: { totalXpf: "500", lines: thirdSale, parTaux: projection.taxes(thirdSale), payments: [{ method: "CASH", amountXpf: "500" }] } });
  const secondRequest = rectifyInput(tenantId, { countedXpf: "106200", motif: "Deuxième rectification justifiée" });
  const second = await days.rectifyCashDay(tx, dayId, secondRequest);
  assert.equal(second.cycle, 2);
  assert.equal((await tx.cashDayClosure.count({ where: { tenantId, cashDayId: dayId } })), 3);
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${randomUUID()}, true)`;
  assert.equal(await tx.cashDayClosure.count({ where: { cashDayId: dayId } }), 0);
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
}));

test("legacySnapshot ONLINE primitif : listes et ledger restent lisibles après rectification", async () => fixture(async (tx, tenantId, dayId) => {
  const otherOpened = await days.openCashDay(tx, input(tenantId, new Date("2026-10-28T23:00:00.000Z")));
  await days.closeCashDay(tx, otherOpened.id, input(tenantId, new Date("2026-10-29T19:25:00.000Z"), {
    cycle: 0, countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0", closureMode: "ONLINE", legacySnapshot: "archive",
  }));
  assert.equal((await days.rectifyCashDay(tx, otherOpened.id, rectifyInput(tenantId))).alreadyApplied, false);
  let listed = await days.listCashDays(tx, tenantId, new URLSearchParams());
  assert.ok(listed.days.some((day: any) => day.id === dayId));
  assert.ok(listed.days.some((day: any) => day.id === otherOpened.id));

  assert.equal((await days.rectifyCashDay(tx, dayId, rectifyInput(tenantId))).alreadyApplied, false);
  assert.equal((await days.ledgerPage(tx, tenantId, dayId, new URLSearchParams())).projection.zRemplaces.length, 1);
  listed = await days.listCashDays(tx, tenantId, new URLSearchParams());
  assert.ok(listed.days.some((day: any) => day.id === dayId));
}));

test("rectification PG refuse OPEN, mode Caisse et date hors fenêtre", async () => {
  const tenantId = randomUUID(), rollback = new Error("ROLLBACK_RECTIFICATION_REFUSALS");
  await assert.rejects(transaction(tenantId, async tx => {
    currentTx = tx;
    const opened = await days.openCashDay(tx, input(tenantId, now));
    const req = rectifyInput(tenantId);
    await assert.rejects(days.rectifyCashDay(tx, opened.id, req), (error: any) => error?.message === "DAY_ALREADY_OPEN");
    await days.closeCashDay(tx, opened.id, input(tenantId, now, { cycle: 0, countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0", closureMode: "ONLINE" }));
    await assert.rejects(days.rectifyCashDay(tx, opened.id, { ...req, actionId: randomUUID(), administration: false }),
      (error: any) => error?.message === "MODE_CAISSE");
    await assert.rejects(days.rectifyCashDay(tx, opened.id, { ...req, actionId: randomUUID(), occurredAt: new Date(now.getTime() - 6 * 60_000).toISOString() }),
      (error: any) => error?.message === "OCCURRED_AT_OUT_OF_RANGE");
    currentTx = null; throw rollback;
  }), error => error === rollback);
});
