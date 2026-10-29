import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { PrismaClient, Prisma } from "@prisma/client";

// Recette CI sur base jetable uniquement. Pas de réseau vers Compta/Stock.
// Les fixtures ordinaires sont annulées ; celle de concurrence utilise un tenant
// UUID synthétique neuf, conservé car les faits de caisse sont immuables.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base de recette uniquement)");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });
type Tx = Prisma.TransactionClient;
const require = createRequire(import.meta.url), lib = fileURLToPath(new URL("../lib/", import.meta.url));
const now = new Date("2026-10-29T01:00:00Z");
class Clock extends Date {
  constructor(value?: string | number | Date) { super(value === undefined ? now.getTime() : value instanceof Date ? value.getTime() : value); }
  static now() { return now.getTime(); }
}
let currentTx: Tx | null = null, creditCalls = 0;
let onCredit: (() => Promise<void>) | undefined;
const logged: string[] = [];
function realTransaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  }, { maxWait: 10000, timeout: 20000 });
}
function transaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return currentTx ? fn(currentTx) : realTransaction(tenantId, fn);
}
const native: Record<string, any> = {}, cache = new Map<string, any>();
function load(file: string): any {
  const path = resolve(lib, file.replace(/\.ts$/, "") + ".ts");
  if (path === resolve(lib, "tenant.ts")) return { withTenant: transaction };
  if (path === resolve(lib, "caisse.ts")) return native;
  if (cache.has(path)) return cache.get(path);
  const module = { exports: {} as any };
  cache.set(path, module.exports);
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const run = vm.runInNewContext(`(function(require,module,exports){${source}\n})`, {
    Date: Clock, Error, Promise, Map, Set, WeakMap, BigInt, JSON, Number, String, Object, Array, Buffer,
    URL, URLSearchParams, console: { warn: (...args: any[]) => logged.push(args.join(" ")), log: (...args: any[]) => logged.push(args.join(" ")), error: (...args: any[]) => logged.push(args.join(" ")) },
  });
  run((name: string) => name.startsWith(".") ? load(resolve(dirname(path), name)) : require(name), module, module.exports);
  return module.exports;
}
const globals: Record<string, any> = { Date: Clock, Error, BigInt, Prisma, randomUUID, createHash, withTenant: transaction };
for (const file of ["cash-day-projection", "caisse-sync", "cash-day-guard", "cash-day-ledger", "sale-lock", "money", "cash-movement", "gift-card", "z-report", "credit", "sync", "partial-refund", "partial-refund-db"]) Object.assign(globals, load(file));
globals.comptaClient = () => ({ creditNote: async () => { creditCalls++; await onCredit?.(); return { creditNoteId: "synthetic-credit", totalXpf: -100 }; } });
globals.log = { warn() {}, error() {} };
const context = vm.createContext(globals), caisse = readFileSync(resolve(lib, "caisse.ts"), "utf8");
for (const name of ["openSessionTx", "closeSessionTx", "currentSession", "openSaleSession", "recordCashMovement", "rembourserPartiellement"]) {
  const start = caisse.indexOf(`export async function ${name}(`), end = caisse.indexOf("\nexport ", start + 10);
  assert.ok(start >= 0, name);
  const js = ts.transpileModule(caisse.slice(start, end < 0 ? undefined : end).replace("export ", ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  native[name] = globals[name] = vm.runInContext(`${js}\n${name}`, context);
}
const days = load("cash-days"), sync = load("caisse-sync"), ledger = load("cash-day-ledger"), sales = load("cash-day-sales");
const projection = load("cash-day-projection");
function input(tenantId: string, offset = 0, extra: Record<string, any> = {}) {
  const occurredAt = new Date(now.getTime() + offset * 86400000).toISOString();
  return { tenantId, actionId: randomUUID(), entityKey: "day", deviceId: "synthetic-device", deviceName: "Recette synthétique",
    occurredAt, businessDay: projection.businessDay(new Date(occurredAt)), actorId: tenantId, actorName: "Recette", receivedById: tenantId,
    sourceKey: randomUUID(), localSessionKey: randomUUID(), openingFloatXpf: "1000", ...extra };
}
async function fixture(fn: (tenant: string, tx: Tx) => Promise<void>) {
  const tenant = randomUUID(), rollback = new Error("ROLLBACK_SYNTHETIC_4B");
  creditCalls = 0; onCredit = undefined; logged.length = 0;
  await assert.rejects(realTransaction(tenant, async tx => {
    currentTx = tx;
    try { await fn(tenant, tx); throw rollback; }
    finally { currentTx = null; onCredit = undefined; }
  }), error => error === rollback);
}
async function flag(tx: Tx, tenantId: string, enabled: boolean) {
  await tx.cashSettings.upsert({ where: { tenantId }, create: { tenantId, toCloseEnabled: enabled }, update: { toCloseEnabled: enabled } });
}
async function previous(tx: Tx, tenantId: string, offset = -1) {
  await flag(tx, tenantId, false);
  const result = await days.openCashDay(tx, input(tenantId, offset));
  await flag(tx, tenantId, true);
  return result;
}
function opening(b: ReturnType<typeof input>) { return sync.cashAction("cash-days:open", b, (tx: Tx) => days.openCashDay(tx, b)); }
function closeInput(tenantId: string, extra: Record<string, any> = {}) {
  return input(tenantId, 0, { cycle: 0, countedXpf: "1000", localExpectedXpf: "1000", localVarianceXpf: "0", closureMode: "ONLINE", ...extra });
}
function json(value: unknown) { return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v); }

test("4b pg : éteint garde le corps 409 ; même ouverture PENDING réussit après allumage et se rejoue", async () => fixture(async (tenant, tx) => {
  const old = await previous(tx, tenant);
  await flag(tx, tenant, false);
  const b = input(tenant), before = json(b);
  const refused = await opening(b);
  assert.equal(refused.status, 409);
  assert.equal(json(refused.body), json({ ok: false, error: "PREVIOUS_SESSION_OPEN", data: { ok: false, error: "SESSION_ALREADY_OPEN", sessionId: old.sessionId } }));
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant } }), 0);
  await flag(tx, tenant, true);
  const accepted = await opening(b), replay = await opening(b);
  assert.equal(accepted.status, 200); assert.equal(json(replay), json(accepted)); assert.equal(json(b), before);
  const session = await tx.cashSession.findFirstOrThrow({ where: { tenantId: tenant, id: old.sessionId } });
  assert.equal(session.status, "TO_CLOSE"); assert.equal(session.closedAt, null); assert.equal(session.closingCountedXpf, null);
  assert.equal(await tx.cashDayEvent.count({ where: { tenantId: tenant, cashDayId: old.id, kind: "TO_CLOSE" } }), 1);
  assert.equal(await tx.cashDayClosure.count({ where: { tenantId: tenant } }), 0);
  const conflict = await tx.cashDeposit.findFirstOrThrow({ where: { tenantId: tenant } });
  assert.equal(conflict.kind, "conflit"); assert.equal(conflict.status, "APPLIED"); assert.equal(conflict.deviceId, "core");
  assert.deepEqual(conflict.payload, {}); assert.equal(conflict.payloadHash, createHash("sha256").update("{}").digest("hex"));
  assert.match(conflict.actionId, /^[0-9a-f-]{14}5[0-9a-f-]{21}$/);
  assert.equal(conflict.operation, "PREVIOUS_SESSION_OPEN"); assert.equal(conflict.entityKey, old.businessDay);
  assert.ok(logged.some(line => line.includes("[conflit]") && line.includes(tenant) && line.includes(old.businessDay)));
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant } }), 1);
  // Même parcours réel : vente datée de la veille après la bascule, puis Z tardif.
  const saleLines = [{ kind: "OTHER", label: "Recette", qty: 1, unitXpf: "106", lineXpf: "106", tgcRatePpm: 60000 }];
  const saleInput = input(tenant, -1, { sourceType: "recette-4b", sourceId: randomUUID(), ticketNumber: "synthetic-transition-1",
    lines: saleLines });
  const sale = await sales.createDaySale(tx, old.id, saleInput);
  await ledger.appendDayFact(tx, tenant, old.id, { kind: "SALE_PAID", sourceRef: sale.id, saleId: sale.id,
    deviceId: saleInput.deviceId, occurredAt: new Date(saleInput.occurredAt),
    snapshot: { lines: saleLines, totalXpf: "106", payments: [{ method: "CASH", amountXpf: "106" }], parTaux: projection.taxes(saleLines) } });
  const closed = await days.closeCashDay(tx, old.id, closeInput(tenant, { countedXpf: "1106", localExpectedXpf: "1106" }));
  assert.equal(closed.report.totalSalesXpf, 106);
  assert.equal(closed.report.expectedXpf, 1106); assert.equal(closed.report.varianceXpf, 0);
  assert.equal(closed.report.cancelledCount, 0); assert.equal(closed.report.refundCashXpf, 0);
  assert.equal(closed.report.movementNetXpf, 0);
  assert.deepEqual(JSON.parse(json(closed.report.parTaux)), { "60000": { ttcXpf: 106, htXpf: 100, tgcXpf: 6 } });
  const state = await days.dayState(tx, tenant, old.id);
  assert.equal(state.status, "CLOSED"); assert.equal(state.closedLate, true);
  assert.equal(await tx.cashDayEvent.count({ where: { tenantId: tenant, cashDayId: old.id, kind: "TO_CLOSE" } }), 1);
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant } }), 1);
}));

test("4b pg : +61 s refusé et jour serveur jamais basculé, même tablette en avance à minuit", async () => fixture(async (tenant, tx) => {
  await flag(tx, tenant, true);
  const future = input(tenant, 0, { occurredAt: new Date(now.getTime() + 61000).toISOString() });
  assert.equal((await opening(future)).body.error, "FUTURE_DATE");
  assert.equal(await tx.cashSession.count({ where: { tenantId: tenant } }), 0);
  const today = await days.openCashDay(tx, input(tenant));
  const saved = now.getTime();
  try {
    now.setTime(Date.parse("2026-10-29T12:59:30Z")); // 23:59:30 NC
    const tomorrow = input(tenant, 0, { occurredAt: "2026-10-29T13:00:00Z", businessDay: "2026-10-30" });
    assert.equal((await opening(tomorrow)).body.error, "PREVIOUS_SESSION_OPEN");
    assert.equal((await tx.cashSession.findFirstOrThrow({ where: { tenantId: tenant, id: today.sessionId } })).status, "OPEN");
    assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant } }), 0);
  } finally { now.setTime(saved); }
}));

test("4b pg : tardif J-7 créé TO_CLOSE ; J-8 refus définitif et conflit durable après SAVEPOINT", async () => fixture(async (tenant, tx) => {
  await flag(tx, tenant, true);
  await days.openCashDay(tx, input(tenant));
  const accepted = await opening(input(tenant, -7));
  assert.equal(accepted.status, 200); assert.equal(accepted.body.data.status, "TO_CLOSE");
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant, operation: "OUVERTURE_TARDIVE", status: "APPLIED" } }), 1);
  const b = input(tenant, -8), refused = await opening(b);
  assert.equal(refused.status, 409); assert.equal(refused.body.error, "OUVERTURE_TROP_ANCIENNE");
  assert.equal(json(await opening(b)), json(refused));
  assert.equal(await tx.cashDay.count({ where: { tenantId: tenant, businessDay: b.businessDay } }), 0);
  assert.equal(await tx.cashSession.count({ where: { tenantId: tenant } }), 2);
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant, operation: "OUVERTURE_TROP_ANCIENNE", entityKey: b.businessDay, status: "APPLIED" } }), 1);
}));

test("4b pg : une session historique non liée reste OPEN ; sourceKey d'un autre jour refusé sans création", async () => fixture(async (tenant, tx) => {
  const session = await tx.cashSession.create({ data: { tenantId: tenant, openedBy: tenant, openedAt: new Date(input(tenant, -1).occurredAt) } });
  await flag(tx, tenant, true);
  const refused = await opening(input(tenant));
  assert.equal(refused.body.error, "PREVIOUS_SESSION_OPEN");
  assert.equal((await tx.cashSession.findFirstOrThrow({ where: { tenantId: tenant, id: session.id } })).status, "OPEN");
  assert.equal(await tx.cashDay.count({ where: { tenantId: tenant } }), 0);
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant } }), 0);
  const late = input(tenant, -2);
  assert.equal((await opening(late)).status, 200);
  const collision = await opening(input(tenant, -3, { sourceKey: late.sourceKey }));
  assert.equal(collision.status, 409); assert.equal(collision.body.error, "SOURCE_CONFLICT");
  assert.equal(await tx.cashDay.count({ where: { tenantId: tenant } }), 1);
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant } }), 1);
}));

test("4b pg : espèces sur OPEN du jour seulement, jamais TO_CLOSE ni ancienne OPEN", async () => fixture(async (tenant, tx) => {
  const old = await previous(tx, tenant);
  const today = await days.openCashDay(tx, input(tenant));
  const movement = await native.recordCashMovement(tenant, { kind: "CASH_OUT", amountXpf: 50n, reason: "Recette", createdBy: tenant });
  assert.equal(movement.ok, true); assert.equal(movement.movement.sessionId, today.sessionId);
  assert.equal((await tx.cashSession.findFirstOrThrow({ where: { tenantId: tenant, id: old.sessionId } })).status, "TO_CLOSE");
  await days.closeCashDay(tx, today.id, closeInput(tenant, { countedXpf: "950", localExpectedXpf: "950" }));
  assert.equal((await native.recordCashMovement(tenant, { kind: "CASH_IN", amountXpf: 50n, reason: "Recette", createdBy: tenant })).error, "NO_OPEN_SESSION");
  // Une OPEN restée d'hier, sans ouverture aujourd'hui, n'est pas un tiroir du jour.
  await tx.cashSession.update({ where: { id: old.sessionId }, data: { status: "OPEN" } });
  assert.equal((await native.recordCashMovement(tenant, { kind: "CASH_IN", amountXpf: 50n, reason: "Recette", createdBy: tenant })).error, "NO_OPEN_SESSION");
}));

test("4b pg : vente en ligne TO_CLOSE, CLOSED inchangé, rapport figé enrichi et complément borné", async () => fixture(async (tenant, tx) => {
  const old = await previous(tx, tenant);
  await days.openCashDay(tx, input(tenant));
  const b = input(tenant, -1, { sourceType: "recette-4b", sourceId: randomUUID(), ticketNumber: "synthetic-1",
    lines: [{ kind: "OTHER", label: "Recette", qty: 1, unitXpf: "106", lineXpf: "106", tgcRatePpm: 60000 }] });
  const sale = await sales.createDaySale(tx, old.id, b);
  assert.ok(sale.id);
  const line = { kind: "OTHER", label: "Recette", qty: 1, unitXpf: "106", lineXpf: "106", tgcRatePpm: 60000 };
  await ledger.appendDayFact(tx, tenant, old.id, { kind: "SALE_PAID", sourceRef: sale.id, saleId: sale.id, deviceId: b.deviceId,
    occurredAt: new Date(b.occurredAt), snapshot: { lines: [line], totalXpf: "106", payments: [{ method: "CASH", amountXpf: "106" }], parTaux: projection.taxes([line]) } });
  const closed = await days.closeCashDay(tx, old.id, closeInput(tenant, { countedXpf: "1106", localExpectedXpf: "1106" }));
  assert.equal(closed.report.totalSalesXpf, 106); assert.equal(closed.report.cancelledCount, 0);
  assert.equal(closed.report.refundCashXpf, 0); assert.equal(closed.report.movementNetXpf, 0);
  assert.deepEqual(JSON.parse(json(closed.report.parTaux)), { "60000": { ttcXpf: 106, htXpf: 100, tgcXpf: 6 } });
  const state = await days.dayState(tx, tenant, old.id);
  assert.equal(state.status, "CLOSED"); assert.equal(state.closedLate, true);
  await assert.rejects(sales.createDaySale(tx, old.id, { ...b, sourceId: randomUUID() }), (error: any) => error.message === "DAY_CLOSED");
  const report = json(closed.report);
  await sales.dayMovement(tx, old.id, input(tenant, -1, { kind: "CASH_OUT", amountXpf: "6", reason: "Recette" }));
  const atCutoff = await days.ledgerPage(tx, tenant, old.id, new URLSearchParams({ atRevision: String(closed.cutoffRevision) }));
  const latest = await days.ledgerPage(tx, tenant, old.id, new URLSearchParams());
  assert.equal(latest.projection.totauxCourants.expectedXpf - atCutoff.projection.totauxCourants.expectedXpf, -6n);
  await days.closeCashDay(tx, old.id, closeInput(tenant)); // recomptage non authoritative
  const listed = await days.listCashDays(tx, tenant, new URLSearchParams());
  assert.equal(json(listed.days.find((day: any) => day.id === old.id).closure.report), report);
}));

test("4b pg : PENDING finalisé après clôture, ACK conservé, DONE rejoué sans deuxième avoir", async () => fixture(async (tenant, tx) => {
  const old = await previous(tx, tenant);
  await days.openCashDay(tx, input(tenant));
  const sale = await tx.sale.create({ data: { tenantId: tenant, cashDayId: old.id, sessionId: old.sessionId, status: "PAID",
    invoiceId: "synthetic-invoice", totalXpf: 100n, subtotalXpf: 100n, createdAt: new Date(input(tenant, -1).occurredAt),
    lines: { create: { tenantId: tenant, kind: "OTHER", label: "Recette", qty: 1, unitXpf: 100n, lineXpf: 100n } } }, include: { lines: true } });
  const actionId = randomUUID(), refundInput = { actionId, reason: "Recette", lines: [{ lineId: sale.lines[0].id, qty: 1 }], refundMethod: "CASH",
    cashDrawer: "EXTERNAL", cashDayId: old.id, drawerBusinessDay: old.businessDay, deviceId: "synthetic-device", occurredAt: input(tenant, -1).occurredAt };
  const plan = { invoiceId: sale.invoiceId, lines: [{ lineId: sale.lines[0].id, qty: 1, ttcXpf: 100, tgcRatePpm: 0 }], amountXpf: 100,
    parTaux: [{ tgcRatePpm: 0, htXpf: 100, tgcXpf: 0, ttcXpf: 100 }], fullyRefunded: true };
  await tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, actionId, cashDayId: old.id, drawerBusinessDay: old.businessDay,
    deviceId: "synthetic-device", input: refundInput, plan } });
  const b = input(tenant, -1, { actionId, entityKey: sale.id });
  const kind = `cash-days:${old.id}:sales:${sale.id}:partial-refund`;
  await sync.financialReservation(kind, b);
  onCredit = async () => { await days.closeCashDay(tx, old.id, closeInput(tenant)); };
  const done = await native.rembourserPartiellement(tenant, sale.id, refundInput);
  assert.equal(done.ok, true); assert.equal(creditCalls, 1);
  assert.equal((await tx.caisseSyncAction.findFirstOrThrow({ where: { tenantId: tenant, actionId } })).state, "ACK");
  assert.equal(json(await native.rembourserPartiellement(tenant, sale.id, refundInput)), json(done));
  assert.equal(creditCalls, 1);
  assert.equal(await tx.cashDayEvent.count({ where: { tenantId: tenant, cashDayId: old.id, kind: "PARTIAL_REFUND_DONE" } }), 1);
  const latest = await days.ledgerPage(tx, tenant, old.id, new URLSearchParams());
  const closure = await tx.cashDayClosure.findFirstOrThrow({ where: { tenantId: tenant, cashDayId: old.id, authoritative: true } });
  const before = await days.ledgerPage(tx, tenant, old.id, new URLSearchParams({ atRevision: String(closure.cutoffRevision) }));
  assert.equal(latest.projection.totauxCourants.expectedXpf - before.projection.totauxCourants.expectedXpf, -100n);
  await assert.rejects(native.rembourserPartiellement(tenant, sale.id, { ...refundInput, actionId: randomUUID() }), (error: any) => error.message === "CASHDAY_ROUTE_REQUIRED");
  assert.equal(await tx.partialRefund.count({ where: { tenantId: tenant } }), 1);
}));

test("4b pg : /sessions garde unicité OPEN et clôture native, sans CashDay ni conflit", async () => fixture(async (tenant, tx) => {
  await flag(tx, tenant, true);
  const first = await native.openSessionTx(tx, tenant, { openedBy: tenant, openingFloatXpf: 1000n });
  const second = await native.openSessionTx(tx, tenant, { openedBy: tenant, openingFloatXpf: 1000n });
  assert.equal(first.ok, true); assert.equal(second.ok, false); assert.equal(second.error, "SESSION_ALREADY_OPEN");
  assert.equal(second.sessionId, first.session.id);
  const closed = await native.closeSessionTx(tx, tenant, { sessionId: first.session.id, closedBy: tenant, closingCountedXpf: 1000n });
  assert.equal(closed.ok, true); assert.equal(closed.report.expectedXpf, 1000);
  assert.equal(await tx.cashDay.count({ where: { tenantId: tenant } }), 0);
  assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant } }), 0);
}));

test("4b pg : CashDay historique et /sessions natif du même tenant gardent leur lecture/remplacement", async () => fixture(async (tenant, tx) => {
  await flag(tx, tenant, true);
  const late = await days.openCashDay(tx, input(tenant, -1)); // TO_CLOSE, pas de session OPEN liée
  const legacy = await native.openSessionTx(tx, tenant, { openedBy: tenant, openingFloatXpf: 1000n });
  assert.equal(legacy.ok, true);
  assert.equal((await native.currentSession(tenant)).id, legacy.session.id);
  const old = await tx.cashSession.create({ data: { tenantId: tenant, openedBy: tenant, status: "CLOSED", openedAt: new Date(input(tenant, -2).occurredAt) } });
  assert.equal(await native.openSaleSession(tx, tenant, old.id), legacy.session.id);
  assert.equal((await days.dayState(tx, tenant, late.id)).status, "TO_CLOSE");
}));

test("4b pg : deux ouvertures simultanées, un seul OPEN, une transition et un conflit", async () => {
  const tenant = randomUUID();
  await realTransaction(tenant, tx => previous(tx, tenant));
  const requests = [input(tenant), input(tenant)];
  const results = await Promise.all(requests.map(opening));
  assert.ok(results.every(result => result.status === 200));
  assert.equal(results[0].body.data.id, results[1].body.data.id);
  await realTransaction(tenant, async tx => {
    assert.equal(await tx.cashSession.count({ where: { tenantId: tenant, status: "OPEN" } }), 1);
    assert.equal(await tx.cashSession.count({ where: { tenantId: tenant, status: "TO_CLOSE" } }), 1);
    assert.equal(await tx.cashDayEvent.count({ where: { tenantId: tenant, kind: "TO_CLOSE" } }), 1);
    assert.equal(await tx.cashDeposit.count({ where: { tenantId: tenant, kind: "conflit", status: "APPLIED" } }), 1);
  });
});
