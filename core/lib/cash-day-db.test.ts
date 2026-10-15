// Ports Prisma simulés : exécute les fonctions de production, sans DB ni client régénéré.
// Les verrous/RLS PostgreSQL sont vérifiés dans le SQL ; cette simulation ne remplace pas leur recette SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import * as projection from "./cash-day-projection.ts";
import * as policy from "./cash-shared-policy.ts";
import * as money from "./money.ts";
import * as credit from "./credit.ts";
import * as refundPolicy from "./partial-refund.ts";
import * as movements from "./cash-movement.ts";
import * as gifts from "./gift-card.ts";
import * as reports from "./z-report.ts";
import * as corrections from "./payment-correction.ts";

const require = createRequire(import.meta.url);
const tenant = "10000000-0000-0000-0000-000000000001", tenantB = "10000000-0000-0000-0000-000000000002";
const actor = "10000000-0000-0000-0000-000000000003", now = new Date("2026-10-15T01:00:00.000Z");
const fixedDate = class extends Date { constructor(value?: string | number) { super(value ?? now.getTime()); } static now() { return now.getTime(); } };
function load(file: string, imports: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  const run = vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { Date: fixedDate, Map, Set, BigInt, JSON, Error, Number, String, Object, Array });
  run((name: string) => name in imports ? imports[name] : require(name), module, module.exports);
  return module.exports;
}
function caisseFunction(name: string, globals: Row) {
  const source = readFileSync(new URL("caisse.ts", import.meta.url), "utf8");
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf("\nexport ", start + 10);
  const js = ts.transpileModule(source.slice(start, end < 0 ? undefined : end).replace("export ", ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${js}\n${name}`, { Date: fixedDate, ...projection, ...money, ...credit, ...globals });
}
type Row = Record<string, any>;
function fixture() {
  let state: Record<string, Row[]> = {}, saved: Record<string, Row[]> | null = null, serial = 0;
  let tail = Promise.resolve();
  const queries: string[] = [];
  const names = ["partialRefund", "cashDay", "cashDaySession", "cashDayOpening", "cashDayClosure", "cashDayEvent", "cashSession", "caisseSyncAction", "cashSettings", "parkedBasket", "pickupOrder", "sale", "giftCard", "cashMovement"];
  names.forEach(n => state[n] = []);
  function match(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (k === "OR") return v.some((w: Row) => match(row, w));
      if (k.includes("_") && v && typeof v === "object") return match(row, v);
      if (v && typeof v === "object" && !(v instanceof Date)) return Object.entries(v).every(([op, n]) =>
        op === "lte" ? row[k] <= n! : op === "gte" ? row[k] >= n! : op === "gt" ? row[k] > n! : op === "in" ? (n as unknown[]).includes(row[k]) : false);
      return row[k] === v;
    });
  }
  const tx: Row = {};
  tx.salePayment = {
    async count({ where }: Row) { return state.sale.find(s => s.id === where.saleId)!.payments.filter((p: Row) => match(p, where.settleRef === undefined ? {} : { settleRef: where.settleRef })).length; },
    async findMany({ where }: Row) { return structuredClone(state.sale.find(s => s.id === where.saleId)!.payments); },
    async create({ data }: Row) { state.sale.find(s => s.id === data.saleId)!.payments.push(structuredClone(data)); return data; },
  };
  function view(name: string, row: Row, include?: Row) {
    const out = structuredClone(row);
    if (name === "cashDay" && include) {
      out.canonicalSession = structuredClone(state.cashSession.find(s => s.id === row.canonicalSessionId));
      out.currentSession = structuredClone(state.cashSession.find(s => s.id === row.currentSessionId));
    }
    if (name === "sale" && include?.session) out.session = structuredClone(state.cashSession.find(s => s.id === row.sessionId) ?? null);
    return out;
  }
  for (const name of names) {
    tx[name] = {
      async findFirst({ where, include }: Row = {}) { const row = state[name].find(r => match(r, where)); return row ? view(name, row, include) : null; },
      async findUnique(args: Row) { return this.findFirst(args); },
      async findUniqueOrThrow(args: Row) { const row = await this.findFirst(args); assert.ok(row); return row; },
      async findFirstOrThrow(args: Row) { return this.findUniqueOrThrow(args); },
      async findMany({ where, orderBy, take }: Row = {}) {
        let rows = state[name].filter(r => match(r, where));
        const sort = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        rows.sort((a, b) => { for (const item of sort) for (const [k, direction] of Object.entries(item)) if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * (direction === "desc" ? -1 : 1); return 0; });
        return structuredClone(take ? rows.slice(0, take) : rows);
      },
      async create({ data }: Row) {
        const id = `20000000-0000-0000-0000-${String(++serial).padStart(12, "0")}`;
        const row: Row = { id, revision: name === "cashDay" ? 0n : 0, cycle: 0, createdAt: now, updatedAt: now, receivedAt: now,
          claimedByDevice: null, claimActionId: null, actorId: null, legacySnapshot: null, cashDayId: null, paidAt: null, creditNoteId: null,
          deviceId: null, deviceName: null, ticketNumber: null, sellerId: null, sellerName: null, saleId: null, ...structuredClone(data) };
        if (name === "cashSession") Object.assign(row, { status: "OPEN", openedAt: data.openedAt ?? now, posteId: data.posteId ?? null, ...data });
        if (name === "cashDay") Object.assign(row, { scope: "rotisserie-caisse", ...data });
        if (name === "parkedBasket") row.status = data.status ?? "WAITING";
        if (name === "pickupOrder") row.status = data.status ?? "A_PREPARER";
        if (name === "caisseSyncAction") row.state = data.state ?? "PENDING";
        if (name === "sale") { row.status = data.status ?? "DRAFT"; row.payments ??= []; row.lines = data.lines?.create ?? data.lines ?? []; }
        state[name].push(row); return structuredClone(row);
      },
      async updateMany({ where, data }: Row) {
        let count = 0;
        for (const row of state[name].filter(r => match(r, where))) {
          count++;
          for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === "object" && "increment" in v ? row[k] + (v as Row).increment : structuredClone(v);
        }
        return { count };
      },
      async update({ where, data }: Row) { const changed = await this.updateMany({ where, data }); assert.equal(changed.count, 1); return this.findFirst({ where }); },
    };
  }
  tx.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?"); queries.push(sql);
    if (sql.includes('FROM "CashDay"')) return state.cashDay.filter(r => r.tenantId === values[0] && r.id === values[1]).map(r => ({ id: r.id }));
    return [];
  };
  tx.$executeRawUnsafe = async (sql: string) => { queries.push(sql); if (sql.startsWith("SAVEPOINT")) saved = structuredClone(state); if (sql.startsWith("ROLLBACK TO")) state = structuredClone(saved!); };
  tx.$executeRaw = async (strings: TemplateStringsArray) => { queries.push(strings.join("?")); };
  async function withTenant<T>(_tenantId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    const pending = tail; let release!: () => void; tail = new Promise<void>(resolve => release = resolve); await pending;
    const before = structuredClone(state);
    try { return await fn(tx); } catch (e) { state = before; throw e; } finally { release(); }
  }
  const sync = load("caisse-sync.ts", { "./tenant": { withTenant }, "./cash-day-projection": projection });
  const ledger = load("cash-day-ledger.ts", { "./cash-day-projection": projection, "./caisse-sync": sync });
  const native = {
    async openSessionTx(tx: Row, tenantId: string, b: Row) {
      const old = await tx.cashSession.findFirst({ where: { tenantId, posteId: null, status: "OPEN" } });
      if (old) return { ok: false, sessionId: old.id };
      return { ok: true, session: await tx.cashSession.create({ data: { tenantId, ...b, openedAt: b.occurredAt } }) };
    },
    closeSessionTx: caisseFunction("closeSessionTx", { ...movements, ...gifts, ...reports }),
  };
  const days = load("cash-days.ts", { "./caisse": native, "./cash-day-ledger": ledger, "./caisse-sync": sync, "./cash-day-projection": projection });
  const shared = load("cash-shared-data.ts", { "./cash-day-projection": projection, "./cash-shared-policy": policy, "./caisse-sync": sync });
  const sales = load("cash-day-sales.ts", { "./cash-day-ledger": ledger, "./cash-day-projection": projection, "./cash-shared-policy": policy, "./caisse-sync": sync });
  return { tx, sync, ledger, days, shared, sales, native, withTenant, rows: (name: string) => structuredClone(state[name]), queries };
}
function input(overrides: Row = {}) { return { tenantId: tenant, actionId: "open-a", entityKey: "day", deviceId: "A", deviceName: "Synthétique A", occurredAt: now.toISOString(),
  actorId: actor, actorName: "Opérateur synthétique", receivedById: actor, businessDay: "2026-10-15", localSessionKey: "local-A", sourceKey: "opening-A", openingFloatXpf: "25000", ...overrides }; }
const basketLines = [{ qty: 1, unitXpf: "3000", lineXpf: "3000", label: "Synthétique", kind: "OTHER", tgcRatePpm: 60000 }];

test("avoir J+1 sur vente J : Z 26000 puis 24800, origine acceptée et rejeu sans doublon", async () => {
  for (const explicitDate of [true, false]) {
    const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const first = f.rows("cashDay")[0].id, tomorrow = "2026-10-16T01:00:00.000Z";
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "yesterday",
      status: "PAID", paidAt: now, totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n }] } });
    await f.tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, status: "DONE", actionId: actor,
      createdAt: new Date(tomorrow), input: { refundMethod: "CASH", ...(explicitDate ? { occurredAt: tomorrow } : {}) }, plan: { amountXpf: 200, parTaux: [] } } });
    const attach = input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "yesterday" }] });
    await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, first, attach));
    const c = input({ sourceKey: "close-J", cycle: 0, closureMode: "ONLINE", countedXpf: "26000", localExpectedXpf: "26000", localVarianceXpf: "0" });
    await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, first, c));
    await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input({ businessDay: "2026-10-16", occurredAt: tomorrow,
      sourceKey: "opening-J+1", localSessionKey: "local-J+1" })));
    const second = f.rows("cashDay")[1].id;
    // L'import du jour trouve l'avoir même sans origine de vente fournie.
    await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, second, input({ cycle: 0 })));
    for (let i = 0; i < 2; i++) await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, second, attach));
    for (const [id, expected] of [[first, 26000n], [second, 24800n]] as const) {
      const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
      assert.equal(page.projection.totauxCourants.expectedXpf, expected);
    }
    assert.equal(f.rows("sale")[0].cashDayId, first);
    assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE").length, 1);
    assert.equal(f.rows("cashDayEvent").find(e => e.kind === "PARTIAL_REFUND_DONE")!.cashDayId, second);
  }
});

test("clôture CashDay : ledger 25800 avec avoir 200, théorique persisté et écart zéro", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "close-refund",
    status: "PAID", paidAt: now, totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n }] } });
  await f.tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, status: "DONE", actionId: actor,
    input: { refundMethod: "CASH" }, plan: { amountXpf: 200, parTaux: [] } } });
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, id, input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "close-refund" }] })));
  const c = input({ sourceKey: "close", cycle: 0, closureMode: "ONLINE", countedXpf: "25800", localExpectedXpf: "25800", localVarianceXpf: "0" });
  const result = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, id, c));
  assert.equal(result.report.expectedXpf, 25800); assert.equal(result.report.varianceXpf, 0);
  const session = f.rows("cashSession")[0];
  assert.equal(session.expectedXpf, 25800n); assert.equal(session.varianceXpf, 0n);
  await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, id, c));
  const native = await f.withTenant(tenant, (tx: Row) => f.native.closeSessionTx(tx, tenant, { sessionId: session.id, closingCountedXpf: 0n }));
  assert.equal(native.report.expectedXpf, 25800); assert.equal(native.report.varianceXpf, 0);
  const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
  assert.equal(page.projection.ecartZ, 0n);
});

test("correction CASH vers CARD pendant OPEN et avant import : théorique 25000, rejeu sans doublon", async () => {
  for (const beforeImport of [false, true]) {
    const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const id = f.rows("cashDay")[0].id;
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: beforeImport ? null : id,
      sourceType: "synthetic", sourceId: "corrected", status: "PAID", paidAt: now, invoiceId: "synthetic-invoice", comptaSyncedAt: now,
      totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n, settleRef: "initial" }] } });
    if (!beforeImport) await f.withTenant(tenant, (tx: Row) => f.ledger.recordSharedSale(tx, tenant, sale.id));
    const correct = caisseFunction("corrigerMoyenPaiement", { withTenant: f.withTenant, ...f.ledger,
      lockSaleRow: async () => true, comptaClient: () => ({ paymentCorrection: async () => ({ ok: true }) }),
      runPaymentCorrection: (deps: corrections.PaymentCorrectionDeps, b: corrections.PaymentCorrectionInput) => corrections.runPaymentCorrection(deps, { ...b, maintenant: now }),
    });
    const b = { saleId: sale.id, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 };
    const results = await Promise.all([correct(tenant, b), correct(tenant, b)]);
    assert.ok(results.every(r => r.ok)); assert.ok(results.some(r => r.alreadyCorrected));
    const attach = input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "corrected" }] });
    for (let i = 0; i < 2; i++) await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, id, attach));
    const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
    assert.equal(f.rows("cashSession")[0].status, "OPEN");
    assert.equal(page.projection.totauxCourants.expectedXpf, 25000n);
    assert.equal(page.projection.totauxCourants.byMethod.CASH, 0n);
    assert.equal(page.projection.totauxCourants.byMethod.CARD, 1000n);
    assert.equal(page.projection.totauxCourants.totalSalesXpf, 1000n);
    assert.equal(f.rows("sale")[0].payments.length, 3);
    assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "SALE_PAID").length, 1);
    assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PAYMENT_CORRECTION").length, 1);
    // Rejeu du checkout après correction : le moyen NET (carte) est un rejeu, l'ancien (espèces) un 409.
    const checkout = caisseFunction("checkoutSale", {
      getSale: () => f.tx.sale.findFirst({ where: { id: sale.id } }), withTenant: f.withTenant, comptaClient: () => ({}),
      lockSharedSale: f.ledger.lockSharedSale, lockSaleRow: async () => true,
      prepareSharedCheckout: f.ledger.prepareSharedCheckout, recordSharedSale: f.ledger.recordSharedSale,
      consumePickupOrder: f.ledger.consumePickupOrder, ackFinancial: f.sync.ackFinancial,
      CAISSE_SOURCE_TYPE: "caisse", syncLoadedSale: async () => ({ synced: true, invoiceId: null, stockDecremented: 0 }),
    });
    const card = await checkout(tenant, sale.id, [{ method: "CARD", amountXpf: 1000n }]);
    assert.equal(card.ok, true); assert.equal(card.alreadyPaid, true);
    await assert.rejects(checkout(tenant, sale.id, [{ method: "CASH", amountXpf: 1000n }]),
      (e: Row) => e.status === 409 && e.message === "SALE_ALREADY_PAID");
    assert.equal(f.rows("sale")[0].payments.length, 3);
  }
});

test("import : avoir espèces existant, théorique 25 800, complément et rejeu sans doublon", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "legacy-refund",
    status: "PAID", paidAt: now, totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n }] } });
  const b = input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "legacy-refund" }] });
  await f.tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, status: "DONE", actionId: actor,
    input: { refundMethod: "CASH" }, plan: { amountXpf: 200, parTaux: [] } } });
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, id, b));
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, id, b));
  const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
  assert.equal(page.projection.totauxCourants.expectedXpf, 25800n);
  assert.equal(page.projection.totauxCourants.refundCashXpf, 200n);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE").length, 1);
});

test("checkouts CASH/CARD concurrents : un succès, un 409 avec le paiement retenu", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: id, totalXpf: 1000n, lines: [{ lineXpf: 1000n }] } });
  let locked = 0;
  const checkout = caisseFunction("checkoutSale", {
    getSale: () => f.tx.sale.findFirst({ where: { id: sale.id } }), withTenant: f.withTenant,
    comptaClient: () => ({}),
    lockSharedSale: f.ledger.lockSharedSale, lockSaleRow: async () => { locked++; return true; },
    prepareSharedCheckout: f.ledger.prepareSharedCheckout, recordSharedSale: f.ledger.recordSharedSale,
    consumePickupOrder: f.ledger.consumePickupOrder, ackFinancial: f.sync.ackFinancial,
    CAISSE_SOURCE_TYPE: "caisse", syncLoadedSale: async () => ({ synced: true, invoiceId: null, stockDecremented: 0 }),
  });
  const finance = load("cash-day-finance.ts", { "./tenant": { withTenant: f.withTenant }, "./caisse": { checkoutSale: checkout },
    "./caisse-sync": f.sync, "./cash-day-ledger": f.ledger, "./cash-day-projection": projection, "./partial-refund": refundPolicy });
  const body = (actionId: string, method: string) => input({ actionId, payments: [{ method, amountXpf: "1000" }] });
  const a = body(actor, "CASH"), b = body(tenantB, "CARD");
  const results = await Promise.allSettled([finance.dayFinancial(id, sale.id, "checkout", a), finance.dayFinancial(id, sale.id, "checkout", b),
    finance.dayFinancial(id, sale.id, "checkout", a)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2,
    results.map(r => r.status === "rejected" ? String(r.reason?.stack) : "success").join("\n"));
  const refused = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(refused.reason.status, 409); assert.equal(refused.reason.message, "SALE_ALREADY_PAID");
  assert.equal(refused.reason.data.payments[0].method, "CASH"); assert.ok(locked >= 1);
  const replay = await finance.dayFinancial(id, sale.id, "checkout", a);
  assert.equal(replay.ok, true); assert.equal(replay.alreadyApplied, true);
  assert.equal(f.rows("sale")[0].payments.length, 1);
  // Route historique : même paiement = rejeu idempotent ; autre moyen = 409, jamais un succès.
  const same = await checkout(tenant, sale.id, [{ method: "CASH", amountXpf: 1000n }]);
  assert.equal(same.ok, true); assert.equal(same.alreadyPaid, true);
  await assert.rejects(checkout(tenant, sale.id, [{ method: "CARD", amountXpf: 1000n }]),
    (e: Row) => e.status === 409 && e.message === "SALE_ALREADY_PAID");
  assert.equal(f.rows("sale")[0].payments.length, 1);
});

test("route remboursement partiel : métadonnées transmises au ledger et rejeu sans doublon", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  const native = caisseFunction("rembourserPartiellement", {
    ...refundPolicy, assertTenantId: (v: string) => v, withTenant: f.withTenant,
    lockDay: f.ledger.lockDay, appendDayFact: f.ledger.appendDayFact, ackFinancial: f.sync.ackFinancial,
    comptaClient: () => ({}),
    // Port de confirmation Compta : appelle le vrai branchement ledger de caisse.ts.
    partialRefundWithPorts: async (_t: string, _s: string, _b: Row, deps: Row) => {
      await deps.transact((tx: Row) => deps.recordDrawer(tx, { id: actor }, { amountXpf: 200, parTaux: [] }));
      return { ok: true };
    },
  });
  const route = load("../app/api/sales/[id]/partial-refund/route.ts", {
    "next/server": { NextResponse: { json: (body: unknown, options: Row) => ({ body, status: options.status }) } },
    "@/lib/service-auth": { hasServiceKey: () => true }, "@/lib/caisse": { rembourserPartiellement: native },
    "@/lib/partial-refund": refundPolicy,
  });
  const b = { tenantId: tenant, actionId: actor, reason: "Retour synthétique", lines: [{ lineId: tenantB, qty: 1 }],
    refundMethod: "CASH", cashDrawer: "EXTERNAL", cashDayId: id, drawerBusinessDay: "2026-10-15", deviceId: "A", occurredAt: now.toISOString() };
  for (let i = 0; i < 2; i++) assert.equal((await route.POST({ json: async () => b }, { params: Promise.resolve({ id: tenantB }) })).status, 200);
  const facts = f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE");
  assert.equal(facts.length, 1); assert.equal(facts[0].cashDeltaXpf, -200n); assert.equal(facts[0].sourceRef, actor);
});

test("deux ouvertures concurrentes : 1 CashDay/OPEN, fond premier serveur et fonds divergents tracés", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.sync.cashAction("open", input(), (tx: Row) => f.days.openCashDay(tx, input())),
    f.sync.cashAction("open", input({ actionId: "open-b", sourceKey: "opening-B", deviceId: "B", localSessionKey: "local-B", openingFloatXpf: "30000" }),
      (tx: Row) => f.days.openCashDay(tx, input({ actionId: "open-b", sourceKey: "opening-B", deviceId: "B", localSessionKey: "local-B", openingFloatXpf: "30000" })))]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(f.rows("cashDay").length, 1); assert.equal(f.rows("cashSession").length, 1);
  assert.equal(f.rows("cashDayOpening").length, 2); assert.equal(f.rows("cashSession")[0].openingFloatXpf, 25000n);
  assert.equal(b.body.data.fondNonRetenu, true); assert.ok(f.queries.some(s => s.includes("pg_advisory_xact_lock")));
});
test("accusé perdu, action concurrente identique, contenu divergent et transaction interrompue", async () => {
  const f = fixture(); let applied = 0;
  const mutation = async (tx: Row) => { applied++; return f.days.openCashDay(tx, input()); };
  const out = await Promise.all([f.sync.cashAction("open", input(), mutation), f.sync.cashAction("open", input(), mutation)]);
  assert.equal(applied, 1); assert.equal(out[1].body.alreadyApplied, true);
  assert.equal((await f.sync.cashAction("open", input({ openingFloatXpf: "1" }), mutation)).body.error, "ACTION_ID_CONFLICT");
  const before = f.rows("cashDayEvent");
  await assert.rejects(f.sync.cashAction("crash", input({ actionId: "crash" }), async (tx: Row) => {
    await tx.cashMovement.create({ data: { tenantId: tenant, amountXpf: 999n } }); throw new Error("crash avant commit");
  }));
  assert.equal(f.rows("cashMovement").length, 0); assert.deepEqual(f.rows("cashDayEvent"), before);
  assert.equal(f.rows("caisseSyncAction").some(r => r.actionId === "crash"), false);
});
test("conflit conservé sans mutation, isolation A/B et ancien jour OPEN non fusionné", async () => {
  const f = fixture();
  await f.sync.cashAction("open", input(), (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  const conflict = await f.sync.cashAction("close", input({ tenantId: tenantB, actionId: "cross" }), (tx: Row) => f.days.closeCashDay(tx, id, input({ tenantId: tenantB })));
  assert.equal(conflict.status, 404); assert.equal(f.rows("caisseSyncAction").find(r => r.actionId === "cross")!.state, "REJECTED");
  const next = input({ actionId: "next", businessDay: "2026-10-16", occurredAt: "2026-10-16T01:00:00Z" });
  const result = await f.sync.cashAction("open", next, (tx: Row) => f.days.openCashDay(tx, next));
  assert.equal(result.body.error, "PREVIOUS_SESSION_OPEN"); assert.equal(f.rows("cashDay").length, 1);
});
test("2 close concurrents : premier comptage Z, second recomptage ; réouverture nouveau cycle, fond unique", async () => {
  const f = fixture(); await f.sync.cashAction("open", input(), (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  const c = (key: string, counted = "25000", cycle = 0) => input({ actionId: key, sourceKey: key, cycle, closureMode: "ONLINE", countedXpf: counted, localExpectedXpf: "25000", localVarianceXpf: String(BigInt(counted) - 25000n) });
  await Promise.all([f.sync.cashAction("close", c("c1"), (tx: Row) => f.days.closeCashDay(tx, id, c("c1"))),
    f.sync.cashAction("close", c("c2", "30000"), (tx: Row) => f.days.closeCashDay(tx, id, c("c2", "30000")))]);
  assert.deepEqual(f.rows("cashDayClosure").map(c => c.authoritative), [true, false]);
  const old = f.rows("cashSession")[0];
  const reopen = input({ actionId: "reopen", administration: true });
  await f.sync.cashAction("reopen", reopen, (tx: Row) => f.days.reopenCashDay(tx, id, reopen));
  assert.equal(f.rows("cashSession")[1].openingFloatXpf, 0n); assert.deepEqual(f.rows("cashSession")[0], old);
  await f.sync.cashAction("close", c("c3", "25000", 1), (tx: Row) => f.days.closeCashDay(tx, id, c("c3", "25000", 1)));
  assert.deepEqual(f.rows("cashDayClosure").map(c => c.authoritative), [true, false, true]);
  const historical = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams({ atRevision: "3" })));
  assert.equal(historical.projection.reouvertures.length, 0); assert.equal(historical.projection.compte, 25000n);
});
test("claims concurrents, tombstone, révision atomique, acompte 500 conservé sans mouvement", async () => {
  const f = fixture();
  const b = input({ actionId: "basket", sourceKey: "basket", label: "Test", lines: basketLines });
  await f.sync.cashAction("basket", b, (tx: Row) => f.shared.createBasket(tx, b)); const id = f.rows("parkedBasket")[0].id;
  const a = input({ actionId: "claim-a", baseRevision: 0 }), other = input({ actionId: "claim-b", baseRevision: 0, deviceId: "B" });
  const results = await Promise.all([f.sync.cashAction("claim", a, (tx: Row) => f.shared.changeBasket(tx, id, a, true)), f.sync.cashAction("claim", other, (tx: Row) => f.shared.changeBasket(tx, id, other, true))]);
  assert.deepEqual(results.map(r => r.status), [200, 409]);
  const deleted = input({ actionId: "delete", baseRevision: 1, status: "DELETED" });
  await f.sync.cashAction("patch", deleted, (tx: Row) => f.shared.changeBasket(tx, id, deleted, false));
  await f.sync.cashAction("import", { ...b, actionId: "basket-import" }, (tx: Row) => f.shared.createBasket(tx, b));
  assert.equal(f.rows("parkedBasket")[0].status, "DELETED");
  const order = input({ actionId: "order", sourceKey: "order", importMode: true, clientName: "Donnée synthétique", phone: "", pickupDay: "2026-10-15", pickupTime: "12:00", lines: basketLines, totalXpf: "3000", depositXpf: "500" });
  await f.sync.cashAction("order", order, (tx: Row) => f.shared.createPickup(tx, order));
  assert.equal(f.rows("pickupOrder")[0].depositXpf, 500n); assert.equal(f.rows("sale").length, 0); assert.equal(f.rows("cashMovement").length, 0);
});
test("ledger : arrivée tardive CLOSED, alias, aucune facture/vente supplémentaire à l'import, révision paginée >200", async () => {
  const f = fixture(); await f.sync.cashAction("open", input(), (tx: Row) => f.days.openCashDay(tx, input())); const id = f.rows("cashDay")[0].id;
  const c = input({ actionId: "close", sourceKey: "close", cycle: 0, closureMode: "OFFLINE", countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0", legacySnapshot: { knownSourceRefs: [] } });
  await f.sync.cashAction("close", c, (tx: Row) => f.days.closeCashDay(tx, id, c));
  const body = input({ actionId: "sale", sourceType: "synthetic", sourceId: "A-001", ticketNumber: "A-001", lines: basketLines, offlineCompleted: true });
  await f.sync.cashAction("sale", body, (tx: Row) => f.sales.createDaySale(tx, id, body));
  const s = f.rows("sale")[0];
  await f.withTenant(tenant, async (tx: Row) => {
    await tx.sale.update({ where: { id: s.id }, data: { status: "PAID", paidAt: now, payments: [{ method: "CASH", amountXpf: 3000n }] } });
    await f.ledger.recordSharedSale(tx, tenant, s.id);
  });
  const legacy = input({ actionId: "attach", cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "A-001" }] });
  await f.sync.cashAction("attach", legacy, (tx: Row) => f.days.attachLegacy(tx, id, legacy));
  assert.equal(f.rows("sale").length, 1); assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "SALE_PAID").length, 1);
  for (let i = 0; i < 205; i++) await f.withTenant(tenant, (tx: Row) => f.ledger.appendDayFact(tx, tenant, id, { kind: "MOVEMENT", sourceRef: `m${i}`, deviceId: "B", occurredAt: now, snapshot: { kind: "CASH_IN", amountXpf: "1" } }));
  const first = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
  const second = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams({ cursor: first.nextCursor, atRevision: String(first.revision) })));
  assert.equal(first.data.length, 200); assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
  assert.equal(first.data.length + second.data.length, f.rows("cashDayEvent").length); assert.equal(first.projection.ecartZ, -3205n);
});
