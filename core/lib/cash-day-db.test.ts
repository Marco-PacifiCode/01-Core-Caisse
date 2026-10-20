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
import * as voidPolicy from "./void-sale.ts";
import * as importsPolicy from "./import-cloture.ts";
import * as loyalty from "./loyalty.ts";
import { syncBlocksVoid, checkoutStatusAfterSync } from "./sync.ts";

const require = createRequire(import.meta.url);
const tenant = "ab000000-0000-0000-0000-000000000001", tenantB = "cd000000-0000-0000-0000-000000000002";
const actor = "ef000000-0000-0000-0000-000000000003", now = new Date("2026-10-15T01:00:00.000Z");
const fixedDate = class extends Date { constructor(value?: string | number) { super(value ?? now.getTime()); } static now() { return now.getTime(); } };
function load(file: string, imports: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as any };
  const run = vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { Date: fixedDate, Map, Set, BigInt, JSON, Error, Number, String, Object, Array, URL, URLSearchParams });
  run((name: string) => name in imports ? imports[name] : require(name), module, module.exports);
  return module.exports;
}
const syncForTests = load("caisse-sync.ts", { "./tenant": { withTenant: async (_tenant: string, fn: (tx: any) => unknown) => fn({}) }, "./tenant.ts": { withTenant: async (_tenant: string, fn: (tx: any) => unknown) => fn({}) }, "./cash-day-projection": projection, "./cash-day-projection.ts": projection, "node:crypto": require("node:crypto") });
const tenantLock = syncForTests.lockCashTenant;
let activeSync: Row;
function caisseFunction(name: string, globals: Row) {
  const source = readFileSync(new URL("caisse.ts", import.meta.url), "utf8");
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf("\nexport ", start + 10);
  const js = ts.transpileModule(source.slice(start, end < 0 ? undefined : end).replace("export ", ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${js}\n${name}`, { Date: fixedDate, ...projection, ...money, ...credit, ...corrections,
    assertLegacyWriteAllowed: globals.assertLegacyWriteAllowed, lockCashTenant: globals.lockCashTenant ?? tenantLock,
    uuid: activeSync.uuid, findHistoricalKey: activeSync.findHistoricalKey, findHistoricalSource: activeSync.findHistoricalSource,
    receivedActionInput: activeSync.receivedActionInput, normalizeActionId: activeSync.normalizeActionId, normalizeActionInput: activeSync.normalizeActionInput,
    randomUUID: require("node:crypto").randomUUID, createHash: require("node:crypto").createHash, canonical: projection.canonical,
    syncBlocksVoid, checkoutStatusAfterSync, ...globals });
}
type Row = Record<string, any>;
function fixture(enforceDayBeforeSale = false) {
  let state: Record<string, Row[]> = {}, saved: Record<string, Row[]> | null = null, serial = 0;
  let tail = Promise.resolve();
  const queries: string[] = [];
  const lockTraces: string[][] = [];
  let heldDays = new Set<string>(), trace: string[] = [];
  const saleLock = (id: string) => {
    if (enforceDayBeforeSale) assert.ok(heldDays.size, "Day doit être verrouillé avant Sale");
    trace.push(`Sale:${id}`);
  };
  const names = ["voidAction", "partialRefund", "cashDay", "cashDaySession", "cashDayOpening", "cashDayClosure", "cashDayEvent", "cashSession", "caisseSyncAction", "cashSettings", "parkedBasket", "pickupOrder", "sale", "giftCard", "cashMovement", "loyaltyProgram", "loyaltyAccount", "loyaltyEntry"];
  names.forEach(n => state[n] = []);
  function match(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (k === "currentSession") return match(state.cashSession.find(s => s.id === row.currentSessionId) ?? {}, v);
      if (k === "session" && row.sessionId) return match(state.cashSession.find(s => s.id === row.sessionId && s.tenantId === row.tenantId) ?? {}, v);
      if (k === "cashDay" && row.cashDayId) return match(state.cashDay.find(d => d.id === row.cashDayId && d.tenantId === row.tenantId) ?? {}, v);
      if (k === "canonicalDays" || k === "currentDays" || k === "dayAliases") {
        const related = k === "dayAliases" ? state.cashDaySession.filter(d => d.sessionId === row.id)
          : state.cashDay.filter(d => d[k === "canonicalDays" ? "canonicalSessionId" : "currentSessionId"] === row.id);
        return !related.some(d => match(d, v.none));
      }
      if (k === "payments") return !!state.sale.find(s => s.id === row.id)?.payments?.length;
      if (k === "OR") return v.some((w: Row) => match(row, w));
      if (k === "AND") return v.every((w: Row) => match(row, w));
      if (k.includes("_") && v && typeof v === "object") return match(row, v);
      if (v && typeof v === "object" && !(v instanceof Date)) return Object.entries(v).every(([op, n]) =>
        op === "lte" ? row[k] <= n! : op === "lt" ? row[k] < n! : op === "gte" ? row[k] >= n! : op === "gt" ? row[k] > n! : op === "not" ? row[k] !== n : op === "in" ? (n as unknown[]).includes(row[k]) : op === "notIn" ? !(n as unknown[]).includes(row[k]) : false);
      return row[k] instanceof Date && v instanceof Date ? row[k].getTime() === v.getTime() : row[k] === v;
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
      if (include.events) out.events = structuredClone(state.cashDayEvent.filter(e => e.cashDayId === row.id && match(e, include.events.where))
        .sort((a, b) => a.sequence > b.sequence ? -1 : a.sequence < b.sequence ? 1 : 0).slice(0, include.events.take));
    }
    if (name === "cashDaySession" && include) {
      out.cashDay = structuredClone(state.cashDay.find(d => d.tenantId === row.tenantId && d.id === row.cashDayId));
      out.session = structuredClone(state.cashSession.find(s => s.tenantId === row.tenantId && s.id === row.sessionId));
    }
    if (name === "sale" && include?.session) out.session = structuredClone(state.cashSession.find(s => s.id === row.sessionId) ?? null);
    return out;
  }
  for (const name of names) {
    tx[name] = {
      async findFirst(args: Row = {}) { return (await this.findMany({ ...args, take: 1 }))[0] ?? null; },
      async count({ where }: Row = {}) { return state[name].filter(r => match(r, where)).length; },
      async findUnique(args: Row) { return this.findFirst(args); },
      async findUniqueOrThrow(args: Row) { const row = await this.findFirst(args); assert.ok(row); return row; },
      async findFirstOrThrow(args: Row) { return this.findUniqueOrThrow(args); },
      async findMany({ where, orderBy, take, include, select }: Row = {}) {
        let rows = state[name].filter(r => match(r, where));
      const sort = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        rows.sort((a, b) => { for (const item of sort) for (const [k, direction] of Object.entries(item)) {
          const left = name === "cashDaySession" && k === "session" ? state.cashSession.find(s => s.tenantId === a.tenantId && s.id === a.sessionId)?.closedAt : a[k];
          const right = name === "cashDaySession" && k === "session" ? state.cashSession.find(s => s.tenantId === b.tenantId && s.id === b.sessionId)?.closedAt : b[k];
          const leftValue = left instanceof Date ? left.getTime() : left, rightValue = right instanceof Date ? right.getTime() : right;
          if (leftValue !== rightValue) return (leftValue < rightValue ? -1 : 1) * (direction === "desc" ? -1 : 1);
        } return 0; });
        return (take ? rows.slice(0, take) : rows).map(row => {
          const out = view(name, row, include);
          return select ? Object.fromEntries(Object.keys(select).map(k => [k, out[k]])) : out;
        });
      },
      async create({ data }: Row) {
        const id = `a0000000-0000-0000-0000-${String(++serial).padStart(12, "0")}`;
        const row: Row = { id, revision: name === "cashDay" ? 0n : 0, cycle: 0, createdAt: now, updatedAt: now, receivedAt: now,
          claimedByDevice: null, claimActionId: null, actorId: null, legacySnapshot: null, cashDayId: null, paidAt: null, creditNoteId: null, voidPreparedAt: null,
          sessionId: null, posteId: null, deviceId: null, deviceName: null, ticketNumber: null, sellerId: null, sellerName: null, saleId: null, ...structuredClone(data) };
        if (name === "cashSession") Object.assign(row, { status: "OPEN", openedAt: data.openedAt ?? now, posteId: data.posteId ?? null, ...data });
        if (name === "cashDay") Object.assign(row, { scope: "rotisserie-caisse", ...data });
        if (name === "parkedBasket") row.status = data.status ?? "WAITING";
        if (name === "pickupOrder") row.status = data.status ?? "A_PREPARER";
        if (name === "caisseSyncAction") row.state = data.state ?? "PENDING";
        if (name === "sale") { row.status = data.status ?? "DRAFT"; row.payments ??= []; row.lines = data.lines?.create ?? data.lines ?? []; }
        if (name === "partialRefund") row.status = data.status ?? "PENDING";
        state[name].push(row); return structuredClone(row);
      },
      async updateMany({ where, data }: Row) {
        let count = 0;
        for (const row of state[name].filter(r => match(r, where))) {
          if (name === "sale") saleLock(row.id);
          count++;
          for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === "object" && "increment" in v ? row[k] + (v as Row).increment : structuredClone(v);
        }
        return { count };
      },
      async update({ where, data }: Row) { const changed = await this.updateMany({ where, data }); assert.equal(changed.count, 1); return this.findFirst({ where }); },
    };
  }
  Object.assign(tx.salePayment, {
    findFirst: async ({ where }: Row) => state.sale.find(s => s.id === where.saleId)?.payments.find((p: Row) => p.settleRef === where.settleRef) ?? null,
    count: async ({ where }: Row) => state.sale.find(s => s.id === where.saleId)?.payments.filter((p: Row) => where.settleRef === undefined || p.settleRef === where.settleRef).length ?? 0,
    findMany: async ({ where }: Row) => structuredClone(state.sale.find(s => s.id === where.saleId)?.payments ?? []),
    create: async ({ data }: Row) => { const sale = state.sale.find(s => s.id === data.saleId); if (!sale) throw new Error(`sale not found: ${data.saleId}`); sale.payments.push(structuredClone(data)); return data; },
  });
  tx.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?"); queries.push(sql);
    if (sql.includes('FROM "CashDay"')) {
      const id = String(values[1]);
      if (enforceDayBeforeSale && !heldDays.has(id)) assert.ok(!trace.some(l => l.startsWith("Sale:")), "Nouveau Day interdit après Sale");
      heldDays.add(id); trace.push(`Day:${id}`);
      return state.cashDay.filter(r => r.tenantId === values[0] && r.id === values[1]).map(r => ({ id: r.id }));
    }
    if (sql.includes('FROM "Sale"')) {
      saleLock(String(values[0]));
      return state.sale.filter(r => r.id === values[0] && r.tenantId === values[1]).map(r => ({ id: r.id }));
    }
    if (sql.includes("pg_advisory_xact_lock") && String(values[0]).startsWith("cash-l4:")) trace.push(`Tenant:${values[0]}`);
    return [];
  };
  tx.$executeRawUnsafe = async (sql: string) => { queries.push(sql); if (sql.startsWith("SAVEPOINT")) saved = structuredClone(state); if (sql.startsWith("ROLLBACK TO")) state = structuredClone(saved!); };
  tx.$executeRaw = async (strings: TemplateStringsArray) => { queries.push(strings.join("?")); };
  async function withTenant<T>(_tenantId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    const pending = tail; let release!: () => void; tail = new Promise<void>(resolve => release = resolve); await pending;
    const before = structuredClone(state);
    heldDays = new Set(); trace = [];
    try { return await fn(tx); } catch (e) { state = before; throw e; } finally { lockTraces.push(trace); release(); }
  }
  const sync = load("caisse-sync.ts", { "./tenant": { withTenant }, "./tenant.ts": { withTenant }, "./cash-day-projection": projection, "./cash-day-projection.ts": projection, "node:crypto": require("node:crypto") });
  activeSync = sync;
  const legacyGuard = load("cash-day-guard.ts", { "./tenant": { withTenant }, "./caisse-sync": sync, "./cash-day-projection": projection });
  const ledger = load("cash-day-ledger.ts", { "./cash-day-projection": projection, "./caisse-sync": sync });
  const locks = load("sale-lock.ts", { "./cash-day-projection": projection, "./caisse-sync": sync });
  const native = {
    async openSessionTx(tx: Row, tenantId: string, b: Row) {
      const old = await tx.cashSession.findFirst({ where: { tenantId, posteId: null, status: "OPEN" } });
      if (old) return { ok: false, sessionId: old.id };
      return { ok: true, session: await tx.cashSession.create({ data: { tenantId, ...b, openedAt: b.occurredAt } }) };
    },
    closeSessionTx: caisseFunction("closeSessionTx", { ...movements, ...gifts, ...reports, ...ledger, assertLegacyWriteAllowed: legacyGuard.assertLegacyWriteAllowed, lockCashTenant: sync.lockCashTenant }),
  };
  const days = load("cash-days.ts", { "./caisse": native, "./cash-day-ledger": ledger, "./caisse-sync": sync, "./cash-day-projection": projection, "./sale-lock": locks, "./cash-day-guard": legacyGuard });
  const shared = load("cash-shared-data.ts", { "./cash-day-projection": projection, "./cash-shared-policy": policy, "./caisse-sync": sync });
  const sales = load("cash-day-sales.ts", { "./cash-day-ledger": ledger, "./cash-day-projection": projection, "./cash-shared-policy": policy, "./caisse-sync": sync, "./sale-lock": locks });
  return { tx, sync, ledger, locks, days, shared, sales, native, guard: legacyGuard, withTenant, rows: (name: string) => structuredClone(state[name]), queries, lockTraces };
}
function input(overrides: Row = {}) { return { tenantId: tenant, actionId: "open-a", entityKey: "day", deviceId: "A", deviceName: "Synthétique A", occurredAt: now.toISOString(),
  actorId: actor, actorName: "Opérateur synthétique", receivedById: actor, businessDay: "2026-10-15", localSessionKey: "local-A", sourceKey: "opening-A", openingFloatXpf: "25000", ...overrides }; }
const basketLines = [{ qty: 1, unitXpf: "3000", lineXpf: "3000", label: "Synthétique", kind: "OTHER", tgcRatePpm: 60000 }];

function financialPorts(f: ReturnType<typeof fixture>, overrides: Row = {}) {
  const refundDb = load("partial-refund-db.ts", { "./cash-movement.ts": movements, "./partial-refund.ts": refundPolicy, "./cash-day-guard": f.guard, "./caisse-sync": f.sync });
  const globals = {
    ...refundPolicy, ...voidPolicy, ...f.ledger, ...f.locks, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, ackFinancial: f.sync.ackFinancial,
    assertTenantId: (v: string) => v, withTenant: f.withTenant,
    getSale: (tenantId: string, id: string) => f.tx.sale.findFirst({ where: { tenantId, id } }),
    partialRefundWithPorts: refundDb.partialRefundWithPorts,
    comptaClient: () => ({
      invoiceDetail: async (_tenant: string, id: string) => {
        const sale = f.rows("sale").find(s => s.invoiceId === id)!;
        return { id, sourceType: "caisse", sourceId: sale.id, totalXpf: Number(sale.totalXpf), paidXpf: Number(sale.totalXpf), tgcRatePpm: 0,
          lines: sale.lines.map((l: Row) => ({ ...l, id: `invoice-${l.id}`, unitXpf: Number(l.unitXpf) })) };
      },
      creditNote: async () => { await overrides.afterCredit?.(); return { creditNoteId: "synthetic-credit", totalXpf: -1000 }; },
    }),
    reverseSaleLoyalty: async () => {},
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    CAISSE_SOURCE_TYPE: "caisse", syncLoadedSale: async () => ({ synced: true, invoiceId: null, stockDecremented: 0 }),
    ...overrides,
  };
  return Object.fromEntries(["checkoutSale", "annulerVente", "rembourserPartiellement"].map(name => [name, caisseFunction(name, globals)]));
}

test('annulerVente : référence fidélité historique uppercase retrouvée, références dérivées depuis Sale.id stocké', async () => {
  for (const receivedUppercase of [false, true]) {
    const f = fixture();
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: 'PAID', paidAt: now, invoiceId: 'synthetic-invoice', totalXpf: 1000n,
      lines: [thousandLine()] } });
    const accountId = 'ab000000-0000-0000-0000-000000000088';
    const entryAt = new Date('2026-10-14T01:00:00.000Z');
    await f.tx.loyaltyEntry.create({ data: { tenantId: tenant, accountId, kind: 'POINTS', points: 27, sourceType: 'sale', sourceId: sale.id,
      saleId: sale.id, ref: `points:sale:${sale.id.toUpperCase()}`, occurredAt: entryAt } });
    await f.tx.loyaltyEntry.create({ data: { tenantId: tenant, accountId, kind: 'REWARD', points: -20, sourceType: 'sale', sourceId: sale.id,
      ref: 'reward:historic:1', occurredAt: entryAt, redeemedAt: now, redeemedSaleId: sale.id } });
    const reward = f.rows('loyaltyEntry').find(e => e.kind === 'REWARD')!;
    await f.tx.loyaltyEntry.create({ data: { tenantId: tenant, accountId, kind: 'REDEEM', rewardEntryId: reward.id, sourceType: 'sale',
      sourceId: sale.id, saleId: sale.id, ref: `redeem:sale:${sale.id.toUpperCase()}`, occurredAt: entryAt } });
    const realLoyaltyDb = load('loyalty-db.ts', { './loyalty.ts': loyalty, './caisse-sync.ts': f.sync,
      './log.ts': { log: { info() {}, warn() {}, error() {} } } });
    let creditKey = '', comptaCalls = 0;
    const native = financialPorts(f, {
      reverseSaleLoyalty: realLoyaltyDb.reverseSale,
      comptaClient: () => ({ invoiceDetail: async () => ({ id: 'synthetic-invoice', sourceType: 'caisse', sourceId: sale.id,
        totalXpf: 1000, paidXpf: 1000, tgcRatePpm: 0, lines: [{ ...thousandLine(), id: 'invoice-line', unitXpf: 1000 }] }),
        creditNote: async (value: Row) => { comptaCalls++; creditKey = value.creditKey; return { creditNoteId: 'synthetic-credit', totalXpf: -1000 }; } }),
    });
    const receivedSaleId = receivedUppercase ? sale.id.toUpperCase() : sale.id;
    const first = await native.annulerVente(tenant, receivedSaleId, { actionId: actor });
    const second = await native.annulerVente(tenant, receivedSaleId, { actionId: actor });
    const reversals = f.rows('loyaltyEntry').filter(e => e.kind === 'REVERSAL');
    assert.equal(first.alreadyVoid, false); assert.equal(second.ok, true);
    // Avoir TOTAL : Compta refuse une creditKey sans montant (AMOUNT_REQUIRED_WITH_KEY, PC-0235 bis) ;
    // son idempotence tient à l'index unique de l'avoir total de la facture.
    assert.equal(creditKey, undefined); assert.equal(comptaCalls, 1);
    assert.equal(reversals.filter(e => e.ref === `unpoints:sale:${sale.id}`).length, 1);
    assert.equal(reversals.find(e => e.ref === `unpoints:sale:${sale.id}`)!.points, -27);
    assert.equal(reversals.filter(e => e.ref === `unredeem:sale:${sale.id}`).length, 1);
    assert.equal(f.rows('loyaltyEntry').find(e => e.id === reward.id)!.redeemedAt, null);
    assert.equal(f.rows('loyaltyEntry').find(e => e.id === reward.id)!.redeemedSaleId, null);
  }
});

function api(f: ReturnType<typeof fixture>, path: string, native: Row) {
  const server = { NextResponse: { json: (body: unknown, options: Row = {}) => ({ body, status: options.status ?? 200 }) } };
  const http = load("cash-shared-http.ts", { "next/server": server, "./service-auth": { hasServiceKey: () => true },
    "./tenant": { withTenant: f.withTenant }, "./caisse-sync": f.sync, "./cash-day-projection": projection });
  return load(`../app/api/${path}`, {
    "@/lib/cash-shared-http": http, "@/lib/caisse-sync": f.sync, "@/lib/cash-day-sales": f.sales, "@/lib/cash-days": f.days,
    "next/server": { NextResponse: { json: (body: unknown, options: Row = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/service-auth": { hasServiceKey: () => true }, "@/lib/cles-service": { horsPortee: () => null }, "@/lib/caisse": native,
    "@/lib/cash-day-guard": load("cash-day-guard.ts", { "./tenant": { withTenant: f.withTenant }, "./caisse-sync": f.sync, "./cash-day-projection": projection }),
    "@/lib/partial-refund": refundPolicy, "@/lib/cash-day-projection": projection, "@/lib/credit": credit,
    "@/lib/tenant": { withTenant: f.withTenant }, "@/lib/serialize": { xpf: Number },
    "@/lib/log": { log: { info() {} } }, "@/lib/postes": { noterPosteHorsLigne: async () => {} },
  });
}
async function expected(f: ReturnType<typeof fixture>, id: string) {
  const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
  return page.projection.totauxCourants.expectedXpf;
}
const routeRequired = (e: Row) => e.status === 409 && e.message === "CASHDAY_ROUTE_REQUIRED";
const thousandLine = () => ({ id: tenantB, kind: "OTHER", label: "Article synthétique", qty: 1, unitXpf: 1000n, lineXpf: 1000n, tgcRatePpm: 0 });

test("GET cash-days : ordre décroissant, curseur exclusif, dernier instantané et lecture sans verrou", async () => {
  const f = fixture();
  const created = [];
  for (const business of ["2026-10-13", "2026-10-14", "2026-10-15"]) {
    const session = await f.tx.cashSession.create({ data: { tenantId: tenant, openedAt: new Date(`${business}T01:00:00Z`),
      openingFloatXpf: 25000n, openedBy: actor, openedByName: "Synthétique", closedAt: null } });
    created.push(await f.tx.cashDay.create({ data: { tenantId: tenant, businessDay: business,
      canonicalSessionId: session.id, currentSessionId: session.id } }));
  }
  const frozen = { cycle: 1, countedXpf: "27000", report: { expectedXpf: 26000, varianceXpf: 1000 } };
  for (const [sequence, snapshot] of [[2n, { report: { expectedXpf: 1 } }], [4n, frozen]] as const)
    await f.tx.cashDayEvent.create({ data: { tenantId: tenant, cashDayId: created[1].id, kind: "CLOSURE", sequence, snapshot } });
  await f.tx.cashDayEvent.create({ data: { tenantId: tenant, cashDayId: created[1].id, kind: "REOPEN", sequence: 5n, snapshot: {} } });
  await f.tx.cashDay.create({ data: { tenantId: tenantB, businessDay: "2026-10-16" } });
  await f.tx.cashDay.create({ data: { tenantId: tenant, scope: "other", businessDay: "2026-10-16" } });
  const route = api(f, "cash-days/route.ts", {});
  const get = (suffix = "", id = tenant.toUpperCase()) => route.GET({ url: `http://test/api/cash-days?tenantId=${id}${suffix}` });
  const before = f.rows("cashDayEvent"), queryCount = f.queries.length;
  const first = await get("&limit=2");
  assert.equal(first.status, 200);
  assert.deepEqual(Array.from(first.body.days, (d: Row) => d.businessDay), ["2026-10-15", "2026-10-14"]);
  assert.equal(first.body.days[0].closure, null);
  assert.deepEqual(first.body.days[1].closure, frozen);
  assert.equal(first.body.days[0].fond, "25000");
  assert.equal(first.body.nextCursor, "2026-10-14");
  const second = await get(`&limit=2&cursor=${first.body.nextCursor}`);
  assert.deepEqual(Array.from(second.body.days, (d: Row) => d.businessDay), ["2026-10-13"]);
  assert.equal(second.body.nextCursor, null);
  assert.equal((await get()).body.days.length, 3);
  assert.equal((await get("&cursor=2026-10-13")).body.days.length, 0);
  const absent = await get("", actor);
  assert.equal(absent.body.days.length, 0);
  assert.equal(f.queries.length, queryCount, "aucune requête de verrouillage");
  assert.deepEqual(f.rows("cashDayEvent"), before);
  const legacyResponse = await get("&businessDay=2026-10-15&limit=invalid&cursor=invalid");
  assert.equal(legacyResponse.status, 200);
  const expectedDay = await f.days.dayState(f.tx, tenant, created[2].id);
  assert.deepEqual(legacyResponse.body, projection.jsonValue({ day: expectedDay, defaultFloatXpf: 25000n }));
  assert.equal("closure" in legacyResponse.body.day, false);
  assert.equal((await get("&businessDay=2026-10-12")).body.day, null);
});

test("GET cash-days et legacy : limit/cursor invalides renvoient 400 INVALID_PAYLOAD", async () => {
  const f = fixture();
  for (const path of ["cash-days/route.ts", "cash-days/legacy/route.ts"]) {
    const route = api(f, path, {}), max = path.includes("legacy") ? 31 : 100;
    for (const suffix of ["limit=0", "limit=-1", "limit=1.5", "limit=", "limit=x", "limit=1e1", `limit=${max + 1}`,
      "cursor=", "cursor=2026-2-01", "cursor=2026-02-30", "cursor=2026-13-01", "cursor=oops", "cursor=2026-10-15T00:00:00Z"]) {
      const response = await route.GET({ url: `http://test/api?tenantId=${tenant}&${suffix}` });
      assert.equal(response.status, 400, `${path} ${suffix}`);
      assert.equal(response.body.error, "INVALID_PAYLOAD");
    }
    for (const limit of [1, max]) assert.equal((await route.GET({ url: `http://test/api?tenantId=${tenant}&limit=${limit}` })).status, 200);
    assert.equal((await route.GET({ url: "http://test/api?tenantId=invalid" })).status, 400);
  }
});

test("GET legacy : jours croissants UTC+11, exclusions canonique/courante/alias/vente rattachée et isolation", async () => {
  const f = fixture();
  const allSessions = [];
  for (const openedAt of ["2026-10-12T13:00:00Z", "2026-10-14T12:59:59Z", "2026-10-14T13:00:00Z"]) {
    allSessions.push(await f.tx.cashSession.create({ data: { tenantId: tenant, openedAt: new Date(openedAt),
      openingFloatXpf: 9007199254740993n, closingCountedXpf: null, expectedXpf: null, varianceXpf: null } }));
  }
  const linked = [];
  for (let i = 0; i < 3; i++) linked.push(await f.tx.cashSession.create({ data: { tenantId: tenant, openedAt: now } }));
  const day = await f.tx.cashDay.create({ data: { tenantId: tenant, businessDay: "2026-10-15",
    canonicalSessionId: linked[0].id, currentSessionId: linked[1].id } });
  await f.tx.cashDaySession.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId: linked[2].id } });
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "sale-origin",
    totalXpf: 1200n, createdAt: now, paidAt: new Date("2026-10-16T01:00:00Z") } });
  await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sourceType: "synthetic", sourceId: "linked", totalXpf: 9n } });
  for (const missing of [{ sourceType: null, sourceId: null }, { sourceType: "synthetic", sourceId: null }, { sourceType: "", sourceId: "empty" }])
    await f.tx.sale.create({ data: { tenantId: tenant, createdAt: now, ...missing } });
  await f.tx.cashSession.create({ data: { tenantId: tenantB, openedAt: new Date("2020-01-01") } });
  await f.tx.sale.create({ data: { tenantId: tenantB, sourceType: "synthetic", sourceId: "other" } });
  const route = api(f, "cash-days/legacy/route.ts", {});
  const get = (suffix = "", id = tenant.toUpperCase()) => route.GET({ url: `http://test/api/cash-days/legacy?tenantId=${id}${suffix}` });
  const queryCount = f.queries.length;
  const response = await get("&limit=2");
  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(response.body.days, (d: Row) => d.businessDay), ["2026-10-13", "2026-10-14"]);
  assert.equal(response.body.days[0].sessions[0].openingFloatXpf, "9007199254740993");
  assert.equal(response.body.days[0].cashDayId, null);
  assert.equal(response.body.nextCursor, "2026-10-14");
  const last = await get(`&limit=2&cursor=${response.body.nextCursor}`);
  assert.equal(last.body.days.length, 2); assert.equal(last.body.nextCursor, null);
  const entry = last.body.days[0];
  assert.equal(entry.businessDay, "2026-10-15"); assert.equal(entry.cashDayId, day.id);
  assert.deepEqual(Array.from(entry.sessions, (s: Row) => s.id), [allSessions[2].id]);
  assert.deepEqual(Array.from(entry.origins, (s: Row) => s.saleId), []);
  assert.equal(entry.salesWithoutSource, 3); assert.equal(entry.more, false);
  // Créée le 15, payée le 16 : rangée au jour de paiement, comme attachLegacy (paidAt ?? createdAt).
  const paidDay = last.body.days[1];
  assert.equal(paidDay.businessDay, "2026-10-16"); assert.equal(paidDay.cashDayId, null);
  assert.deepEqual(Array.from(paidDay.origins, (s: Row) => s.saleId), [sale.id]);
  assert.equal(paidDay.origins[0].totalXpf, "1200"); assert.equal(paidDay.salesWithoutSource, 0);
  assert.equal((await get()).body.days.length, 4);
  assert.equal((await get("&cursor=2026-10-15")).body.days.length, 1);
  assert.equal((await get("&cursor=2026-10-16")).body.days.length, 0);
  assert.equal((await get("", actor)).body.days.length, 0);
  assert.equal(f.queries.length, queryCount);
});

test("GET legacy pending-closures : sessions CLOSED rattachées sans Z, ordre/cursor exclusif et validations", async () => {
  const f = fixture();
  const day = await f.tx.cashDay.create({ data: { tenantId: tenant, businessDay: "2026-10-15", cycle: 2 } });
  const make = async (closedAt: string, status = "CLOSED", tenantId = tenant) => {
    const session = await f.tx.cashSession.create({ data: { tenantId, status, openedAt: now, closedAt: new Date(closedAt),
      openingFloatXpf: 500n, closingCountedXpf: 600n, expectedXpf: 550n, varianceXpf: 50n } });
    return session;
  };
  const three = await make("2026-10-15T03:00:00Z"), one = await make("2026-10-15T02:00:00Z"), two = await make("2026-10-15T03:00:00Z");
  const open = await make("2026-10-15T04:00:00Z", "OPEN");
  const unattached = await make("2026-10-15T05:00:00Z");
  const foreign = await make("2026-10-15T06:00:00Z", "CLOSED", tenantB);
  for (const session of [one, two, three, open]) await f.tx.cashDaySession.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId: session.id, cycle: 1 } });
  await f.tx.cashDaySession.create({ data: { tenantId: tenantB, cashDayId: day.id, sessionId: foreign.id, cycle: 0 } });
  const route = api(f, "cash-days/legacy/pending-closures/route.ts", {});
  const get = (suffix = "", id = tenant.toUpperCase()) => route.GET({ url: `http://test/api?tenantId=${id}${suffix}` });
  const before = f.rows("cashDaySession"), queryCount = f.queries.length;
  const first = await get("&limit=2");
  assert.equal(first.status, 200);
  assert.deepEqual(Array.from(first.body.items, (x: Row) => x.session.id), [one.id, three.id]);
  assert.equal(first.body.items[0].cashDayId, day.id);
  assert.equal(first.body.items[0].businessDay, "2026-10-15");
  assert.equal(first.body.items[0].cycle, 2);
  assert.equal(first.body.items[0].session.openingFloatXpf, "500");
  assert.equal(first.body.nextCursor, three.id);
  const second = await get(`&limit=2&cursor=${three.id}`);
  assert.deepEqual(Array.from(second.body.items, (x: Row) => x.session.id), [two.id]);
  assert.equal(second.body.nextCursor, null);
  const g = fixture();
  await g.days.openCashDay(g.tx, input());
  const liveDay = g.rows("cashDay")[0];
  const legacy = await g.tx.cashSession.create({ data: { tenantId: tenant, status: "CLOSED", openedAt: now,
    closedAt: new Date("2026-10-15T02:00:00Z"), openingFloatXpf: 500n } });
  await g.days.attachLegacy(g.tx, liveDay.id, input({ sessionIds: [legacy.id], cycle: 0 }));
  await g.days.closeCashDay(g.tx, liveDay.id, input({ sourceKey: "legacy-z", cycle: 0, closureMode: "IMPORT",
    countedXpf: "600", localExpectedXpf: "550", localVarianceXpf: "50", legacySessionId: legacy.id,
    legacySnapshot: { knownSourceRefs: [] } }));
  const closedRoute = api(g, "cash-days/legacy/pending-closures/route.ts", {});
  const closed = await closedRoute.GET({ url: `http://test/api?tenantId=${tenant}` });
  assert.equal(closed.body.items.some((item: Row) => item.session.id === legacy.id), false);
  assert.deepEqual((await get("", actor)).body.items, []);
  for (const suffix of ["limit=0", "limit=-1", "limit=1.5", "limit=", "limit=x", "limit=201"])
    assert.equal((await get(`&${suffix}`)).status, 400, suffix);
  const unknownCursor = await get(`&cursor=${"ff000000-0000-0000-0000-000000000000"}`);
  assert.equal(unknownCursor.status, 400);
  assert.equal(unknownCursor.body.error, "INVALID_CURSOR");
  const otherTenantCursor = await get(`&cursor=${foreign.id}`);
  assert.equal(otherTenantCursor.status, 400);
  assert.equal(otherTenantCursor.body.error, "INVALID_CURSOR");
  assert.equal(f.queries.length, queryCount, "aucune requête de verrouillage");
  assert.deepEqual(f.rows("cashDaySession"), before);
});

test("GET legacy : plafond commun 200, more et comptage sans source non tronqué", async () => {
  const f = fixture();
  for (let i = 0; i < 110; i++) {
    await f.tx.cashSession.create({ data: { tenantId: tenant, openedAt: now } });
    await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: `sale-${i}`, createdAt: now, totalXpf: 1n } });
  }
  for (let i = 0; i < 205; i++) await f.tx.sale.create({ data: { tenantId: tenant, sourceType: null, sourceId: null } });
  const route = api(f, "cash-days/legacy/route.ts", {});
  const get = () => route.GET({ url: `http://test/api?tenantId=${tenant}` });
  const first = (await get()).body.days[0];
  assert.equal(first.sessions.length, 100); assert.equal(first.origins.length, 100);
  assert.equal(first.more, true); assert.equal(first.salesWithoutSource, 205);
  assert.deepEqual((await get()).body.days[0], first);
});

test("GET legacy : attachLegacy fait disparaître la session et la vente rattachées", async () => {
  const f = fixture();
  await f.days.openCashDay(f.tx, input());
  const day = f.rows("cashDay")[0];
  const session = await f.tx.cashSession.create({ data: { tenantId: tenant, openedAt: now, openingFloatXpf: 0n } });
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "to-attach", totalXpf: 1000n,
    status: "PAID", paidAt: now, createdAt: now, lines: [thousandLine()], payments: [{ method: "CASH", amountXpf: 1000n }] } });
  const route = api(f, "cash-days/legacy/route.ts", {});
  const get = () => route.GET({ url: `http://test/api?tenantId=${tenant}` });
  const before = await get();
  assert.equal(before.body.days[0].sessions[0].id, session.id);
  assert.equal(before.body.days[0].origins[0].saleId, sale.id);
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, input({ cycle: 0,
    sessionIds: [session.id], origins: [{ sourceType: "synthetic", sourceId: "to-attach" }] })));
  assert.equal((await get()).body.days.length, 0);
});

test("huitième relecture : clôture refusée pendant Compta, rejeu de l'avoir 1000 DONE puis Z 24000", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: "PAID", invoiceId: "synthetic-invoice", totalXpf: 1000n, lines: [thousandLine()] } });
  const closeInput = input({ sourceKey: "close-pending", cycle: 0, closureMode: "ONLINE", countedXpf: "24000", localExpectedXpf: "24000", localVarianceXpf: "0" });
  let first = true;
  const native = financialPorts(f, { afterCredit: async () => {
    if (!first) return;
    first = false;
    assert.equal(f.rows("partialRefund")[0].status, "PENDING");
    for (const close of [
      () => f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, closeInput)),
      () => f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, { ...closeInput, closureMode: "IMPORT", legacySnapshot: { knownSourceRefs: [] } })),
      () => f.withTenant(tenant, (tx: Row) => f.native.closeSessionTx(tx, tenant, { sessionId: day.currentSessionId, closingCountedXpf: 24000n })),
    ]) await assert.rejects(close(), (e: Row) => e.status === 409 && e.message === "REFUND_IN_PROGRESS");
    assert.equal(f.rows("cashSession")[0].status, "OPEN");
    assert.equal(f.rows("cashDayClosure").length, 0);
    throw new Error("Réponse Compta perdue après émission");
  } });
  const finance = load("cash-day-finance.ts", { "./caisse": native, "./tenant": { withTenant: f.withTenant },
    "./caisse-sync": f.sync, "./cash-day-ledger": f.ledger, "./cash-day-projection": projection, "./partial-refund": refundPolicy });
  const b = input({ actionId: actor.toUpperCase(), tenantId: tenant.toUpperCase(), entityKey: sale.id.toUpperCase(), reason: "Retour synthétique", lines: [{ lineId: tenantB.toUpperCase(), qty: 1 }], refundMethod: "CASH" });
  await assert.rejects(finance.dayFinancial(day.id, "invalid-sale-id", "partial-refund", b), (e: Row) => e.status === 400 && e.message === "INVALID_PAYLOAD");
  assert.equal(f.rows("caisseSyncAction").length, 0); assert.equal(f.rows("partialRefund").length, 0);
  assert.equal((await finance.dayFinancial(day.id.toUpperCase(), sale.id.toUpperCase(), "partial-refund", b)).ok, false);
  assert.equal(f.rows("partialRefund")[0].status, "PENDING");
  assert.equal(f.rows("caisseSyncAction")[0].state, "PENDING");
  assert.equal(await expected(f, day.id), 25000n);
  const replay = await finance.dayFinancial(day.id, sale.id, "partial-refund", { ...b, tenantId: tenant, actionId: actor, entityKey: sale.id, lines: [{ lineId: tenantB, qty: 1 }] });
  assert.equal(replay.ok, true); assert.equal(f.rows("partialRefund")[0].status, "DONE");
  assert.equal(f.rows("caisseSyncAction")[0].state, "ACK");
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE").length, 1);
  assert.equal(await expected(f, day.id), 24000n);
  const closed = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, closeInput));
  assert.equal(closed.report.expectedXpf, 24000); assert.equal(closed.report.varianceXpf, 0);
  assert.deepEqual(await finance.dayFinancial(day.id, sale.id, "partial-refund", b), replay);
});

test("huitième relecture : ancienne réservation sur jour clos, refus explicite sans CONFLICT", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: "PAID", invoiceId: "synthetic-invoice", totalXpf: 1000n, lines: [thousandLine()] } });
  const native = financialPorts(f, { afterCredit: () => { throw new Error("Réponse perdue"); } });
  const finance = load("cash-day-finance.ts", { "./caisse": native, "./tenant": { withTenant: f.withTenant },
    "./caisse-sync": f.sync, "./cash-day-ledger": f.ledger, "./cash-day-projection": projection, "./partial-refund": refundPolicy });
  const b = input({ actionId: actor, entityKey: sale.id, reason: "Retour synthétique", lines: [{ lineId: tenantB, qty: 1 }], refundMethod: "CASH" });
  await finance.dayFinancial(day.id, sale.id, "partial-refund", b);
  await f.tx.cashSession.update({ where: { id: day.currentSessionId }, data: { status: "CLOSED" } });
  for (let i = 0; i < 2; i++) {
    const result = await finance.dayFinancial(day.id, sale.id, "partial-refund", b);
    assert.equal(result.status, 409); assert.equal(result.error, "REFUND_DAY_CLOSED_REOPEN_REQUIRED");
    assert.match(result.data.message, /rouvrir/);
    assert.equal(f.rows("caisseSyncAction")[0].state, "PENDING");
  }
  assert.equal(f.rows("partialRefund")[0].status, "PENDING"); assert.equal(await expected(f, day.id), 25000n);
});

test("huitième relecture : première ouverture concurrente et retrait 500, fait MOVEMENT et T 24500", async () => {
  const f = fixture();
  await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 25000n, openedAt: now } });
  let lockTail = Promise.resolve();
  // Seul le verrou consultatif réel sérialise ces deux transactions simulées.
  async function transact(fn: (tx: Row) => Promise<any>, opening = false) {
    let held = false, release: (() => void) | undefined;
    const tx = { ...f.tx, $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("pg_advisory_xact_lock") && !held) {
        const previous = lockTail; lockTail = new Promise<void>(resolve => { release = resolve; });
        await previous; held = true;
      }
      return f.tx.$queryRaw(strings, ...values);
    } };
    if (opening) tx.cashDay = { ...f.tx.cashDay, create: async (args: Row) => { reached(); await creationGate; return f.tx.cashDay.create(args); } };
    try { return await fn(tx); } finally { release?.(); }
  }
  let reached!: () => void, resume!: () => void;
  const atCreation = new Promise<void>(resolve => { reached = resolve; });
  const creationGate = new Promise<void>(resolve => { resume = resolve; });
  const opening = transact(tx => f.days.openCashDay(tx, input()), true);
  await atCreation;
  assert.equal(f.rows("cashDay").length, 0, "le premier jour n'existe pas encore");
  const record = caisseFunction("recordCashMovement", { ...f.ledger, withTenant: (_tenant: string, fn: (tx: Row) => Promise<any>) => transact(fn), assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockCashTenant: f.sync.lockCashTenant });
  const withdrawal = record(tenant, { kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique" });
  await new Promise<void>(resolve => setImmediate(resolve));
  resume();
  const [, result] = await Promise.all([opening, withdrawal]);
  assert.equal(result.ok, true);
  assert.equal(f.rows("cashMovement").length, 1);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "MOVEMENT" && e.cashDeltaXpf === -500n).length, 1);
  assert.equal(await expected(f, f.rows("cashDay")[0].id), 24500n);
});

test("clôture historique : rattachement entre précontrôle et transaction renvoie 409, Z hors historique absent", async () => {
  const f = fixture();
  const session = await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 25000n, openedAt: now } });
  const close = caisseFunction("closeSession", { withTenant: f.withTenant, closeSessionTx: f.native.closeSessionTx, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed });
  assert.equal(await f.guard.cashDayGuard(tenant, { sessionId: session.id }), false);
  const route = api(f, "sessions/[id]/close/route.ts", { closeSession: async (tenantId: string, body: Row) => {
    // La route a passé son filtre ; la première ouverture gagne avant sa transaction.
    await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, f.rows("cashDay")[0].id, input({ cycle: 0, sessionIds: [session.id] })));
    return close(tenantId, body);
  } });
  const response = await route.POST({ json: async () => ({ tenantId: tenant, closedBy: actor, closingCountedXpf: 25000 }) },
    { params: Promise.resolve({ id: session.id }) });
  assert.equal(response.status, 409); assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED");
  const day = f.rows("cashDay")[0];
  assert.equal(f.rows("cashDayClosure").length, 0);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "CLOSURE").length, 0);
  assert.equal(f.rows("cashSession").find(s => s.id === session.id)?.status, "OPEN");
  const closed = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, input({ cycle: 0, sourceKey: "real-z",
    closureMode: "ONLINE", countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0" })));
  assert.equal(closed.report.expectedXpf, 25000); assert.equal(closed.report.varianceXpf, 0);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "CLOSURE").length, 1);
});

test("huitième relecture : correction vente sans cashDayId, HTTP et transaction 409 ; tenant natif conservé", async () => {
  for (const hasDay of [true, false]) {
    const f = fixture();
    if (hasDay) await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: "PAID", totalXpf: 1000n,
      paidAt: now, invoiceId: "synthetic-invoice", comptaSyncedAt: now, payments: [{ method: "CASH", amountXpf: 1000n, settleRef: "initial" }] } });
    let external = 0;
    const correct = caisseFunction("corrigerMoyenPaiement", { withTenant: f.withTenant, ...f.ledger, ...f.locks,
      normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference, findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
      assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
      comptaClient: () => ({ paymentCorrection: async () => { external++; return { ok: true }; } }),
      verifierCorrection: corrections.verifierCorrection, generationCorrection: corrections.generationCorrection, correctionKeyPour: corrections.correctionKeyPour, runPaymentCorrection: (deps: corrections.PaymentCorrectionDeps, b: corrections.PaymentCorrectionInput) => corrections.runPaymentCorrection(deps, { ...b, maintenant: now }),
    });
    const b = { saleId: sale.id, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 };
    if (hasDay) await assert.rejects(correct(tenant, b), routeRequired);
    else assert.equal((await correct(tenant, b)).ok, true);
    const route = api(f, "sales/[id]/payment-correction/route.ts", { corrigerMoyenPaiement: correct });
    const response = await route.POST({ json: async () => ({ tenantId: tenant, ...b,
      ...(hasDay ? {} : { fromMethod: "CARD", toMethod: "CASH" }) }) }, { params: Promise.resolve({ id: sale.id }) });
    assert.equal(response.status, hasDay ? 409 : 200);
    assert.equal(f.rows("sale")[0].payments.length, hasDay ? 1 : 5);
    assert.equal(external, hasDay ? 0 : 2);
    if (hasDay) { assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED"); assert.equal(await expected(f, f.rows("cashDay")[0].id), 25000n); }
  }
});

test("neuvième relecture : première ouverture refusée pendant correction, puis correction rattachée au journal", async () => {
  const f = fixture();
  const historicalSession = await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 25000n, openedAt: now } });
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sessionId: historicalSession.id, status: "PAID", totalXpf: 1000n,
    paidAt: now, invoiceId: "synthetic-invoice", comptaSyncedAt: now, sourceType: "synthetic", sourceId: "corrected",
    lines: [thousandLine()], payments: [{ method: "CASH", amountXpf: 1000n, settleRef: "initial" }] } });
  const correct = caisseFunction("corrigerMoyenPaiement", { withTenant: f.withTenant, ...f.ledger, ...f.locks,
    normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference, findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
    normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference, findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
    comptaClient: () => ({ paymentCorrection: async () => { await assert.rejects(f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input())), (e: Row) => e.status === 409 && e.message === "LEGACY_IN_PROGRESS"); return { ok: true }; } }),
    runPaymentCorrection: (deps: corrections.PaymentCorrectionDeps, b: corrections.PaymentCorrectionInput) => corrections.runPaymentCorrection(deps, { ...b, maintenant: now }),
  });
  const response = await api(f, "sales/[id]/payment-correction/route.ts", { corrigerMoyenPaiement: correct }).POST(
    { json: async () => ({ tenantId: tenant, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 }) }, { params: Promise.resolve({ id: sale.id }) });
  assert.equal(response.status, 200); assert.equal(f.rows("sale")[0].payments.length, 3);
  await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, f.rows("cashDay")[0].id, input({ cycle: 0, sessionIds: [historicalSession.id], origins: [{ sourceType: "synthetic", sourceId: "corrected" }] })));
  assert.equal(f.rows("sale")[0].payments.length, 3);
  assert.equal(f.rows("sale")[0].cashDayId, f.rows("cashDay")[0].id);
  assert.equal(await expected(f, f.rows("cashDay")[0].id), 25000n);
  const locks = f.lockTraces.find(t => t.includes(`Sale:${sale.id}`))!;
  assert.ok(locks.indexOf(`Tenant:cash-l4:${tenant}`) < locks.indexOf(`Sale:${sale.id}`));
});

test("première ouverture : correction PENDING est LEGACY_IN_PROGRESS jusqu'au rejeu identique", async () => {
  const f = fixture();
  const session = await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 25000n, openedAt: now } });
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sessionId: session.id, sourceType: "synthetic", sourceId: "corr-pending",
    status: "PAID", totalXpf: 1000n, paidAt: now, invoiceId: "synthetic-invoice", comptaSyncedAt: now,
    lines: [thousandLine()], payments: [{ method: "CASH", amountXpf: 1000n, settleRef: "initial" }] } });
  let first = true;
  const correctionKeys: string[] = [];
  const correct = caisseFunction("corrigerMoyenPaiement", { withTenant: f.withTenant, ...f.ledger, ...f.locks,
    normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference, findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
    comptaClient: () => ({ paymentCorrection: async (args: Row) => { correctionKeys.push(args.correctionKey); if (first) { first = false; throw new Error("synthetic timeout"); } return { ok: true }; } }),
    runPaymentCorrection: (deps: corrections.PaymentCorrectionDeps, b: corrections.PaymentCorrectionInput) => corrections.runPaymentCorrection(deps, { ...b, maintenant: now }),
  });
  const request = { saleId: sale.id, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 };
  const failed = await correct(tenant, request);
  assert.equal(failed.ok, false); assert.equal(failed.error, "COMPTA_CORRECTION_FAILED");
  assert.equal(f.rows("caisseSyncAction").filter(a => a.kind === "legacy-payment-correction" && a.state === "PENDING").length, 1);
  const opening = input({ actionId: "correction-pending-open" });
  const open = () => f.sync.cashAction("open", opening, (tx: Row) => f.days.openCashDay(tx, opening));
  assert.equal((await open()).body.error, "LEGACY_IN_PROGRESS");
  await assert.rejects(f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, actor, input({ cycle: 0 }))),
    (e: Row) => e.status === 409 && e.message === "LEGACY_IN_PROGRESS");
  const replay = await correct(tenant, request);
  assert.equal(replay.ok, true);
  assert.equal(correctionKeys.length, 2); assert.equal(correctionKeys[0], correctionKeys[1]);
  assert.equal(f.rows("caisseSyncAction").find(a => a.kind === "legacy-payment-correction")!.state, "ACK");
  assert.equal((await open()).status, 200);
  assert.ok(f.rows("caisseSyncAction").every(a => a.state === "ACK"));
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, f.rows("cashDay")[0].id, input({ cycle: 0, sessionIds: [session.id], origins: [{ sourceType: "synthetic", sourceId: "corr-pending" }] })));
  assert.equal(await expected(f, f.rows("cashDay")[0].id), 25000n);
});

test("avoir historique PENDING : ouverture bloquée, même clé DONE, retrait 500 et avoir 1000 au journal", async () => {
  const f = fixture();
  const session = await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 25000n, openedAt: now } });
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: "PAID", paidAt: new Date("2026-10-14T01:00:00Z"),
    invoiceId: "synthetic-old-invoice", totalXpf: 1000n, lines: [thousandLine()] } });
  const record = caisseFunction("recordCashMovement", { withTenant: f.withTenant, ...f.ledger, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed });
  assert.equal((await record(tenant, { kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique" })).ok, true);
  let first = true, credits = 0;
  const native = financialPorts(f, { afterCredit: () => { credits++; if (first) { first = false; throw new Error("accusé Compta perdu"); } } });
  const request = { actionId: actor, reason: "Retour synthétique", lines: [{ lineId: tenantB, qty: 1 }], refundMethod: "CASH" };
  assert.equal((await native.rembourserPartiellement(tenant, sale.id, request)).ok, false);
  assert.equal(f.rows("partialRefund")[0].status, "PENDING");
  assert.equal(f.rows("partialRefund")[0].cashDayId, null);
  const opening = input({ actionId: "refund-pending-open" });
  const open = () => f.sync.cashAction("open", opening, (tx: Row) => f.days.openCashDay(tx, opening));
  assert.equal((await open()).body.error, "LEGACY_IN_PROGRESS");
  assert.equal(f.rows("cashDay").length, 0);
  await assert.rejects(f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, actor, input({ cycle: 0 }))),
    (e: Row) => e.status === 409 && e.message === "LEGACY_IN_PROGRESS");
  const replay = await native.rembourserPartiellement(tenant, sale.id, request);
  assert.equal(replay.ok, true); assert.equal(credits, 2);
  assert.equal(f.rows("partialRefund").length, 1); assert.equal(f.rows("partialRefund")[0].status, "DONE");
  assert.equal((await native.rembourserPartiellement(tenant, sale.id, request)).ok, true);
  assert.equal(credits, 2, "rejeu DONE sans nouvel appel Compta");
  assert.equal((await open()).status, 200);
  assert.ok(f.rows("caisseSyncAction").every(a => a.state === "ACK"));
  const day = f.rows("cashDay")[0];
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, input({ cycle: 0, sessionIds: [session.id] })));
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE").length, 1);
  assert.equal(await expected(f, day.id), 23500n);
  const closed = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, input({ cycle: 0, sourceKey: "refund-z",
    closureMode: "ONLINE", countedXpf: "23500", localExpectedXpf: "23500", localVarianceXpf: "0" })));
  assert.equal(closed.report.expectedXpf, 23500); assert.equal(closed.report.varianceXpf, 0);
});

test("bascule : annulations avec ou sans clé et paiements DRAFT restent historiques jusqu'à terminaison", async () => {
  for (const kind of ["void-action", "void-prepared", "checkout"] as const) {
    const f = fixture();
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: kind === "checkout" ? "DRAFT" : "PAID",
      ...(kind === "void-prepared" ? { voidPreparedAt: now } : {}),
      payments: kind === "checkout" ? [{ method: "CASH", amountXpf: 1000n }] : [] } });
    const action = kind === "void-action" ? await f.tx.voidAction.create({ data: { tenantId: tenant, actionId: actor, saleId: sale.id, status: "PENDING" } }) : null;
    const opening = input();
    const open = () => f.sync.cashAction("open", opening, (tx: Row) => f.days.openCashDay(tx, opening));
    assert.equal((await open()).body.error, "LEGACY_IN_PROGRESS", kind);
    assert.equal(f.rows("cashDay").length, 0);
    if (action) await f.tx.voidAction.update({ where: { id: action.id }, data: { status: "DONE" } });
    await f.tx.sale.update({ where: { id: sale.id }, data: { status: kind === "checkout" ? "PAID" : "VOID" } });
    assert.equal((await open()).status, 200, kind);
    assert.equal(f.rows("cashDay").length, 1);
  }
});

test("huitième relecture : import Z historique, HTTP et transaction 409 ; tenant natif conservé", async () => {
  for (const hasDay of [true, false]) {
    const f = fixture();
    if (hasDay) await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const importer = caisseFunction("importerCloture", { ...importsPolicy, withTenant: f.withTenant, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockCashTenant: f.sync.lockCashTenant,
      Prisma: { PrismaClientKnownRequestError: class extends Error {} } });
    const b = { sourceType: "synthetic", sourceId: "z-legacy", openedBy: actor, openedAt: now.toISOString(), closedAt: now.toISOString(),
      openingFloatXpf: 25000, closingCountedXpf: 25000, expectedXpf: 25000 };
    const before = f.rows("cashSession");
    if (hasDay) await assert.rejects(importer(tenant, b), routeRequired);
    else { const result = await importer(tenant, b); assert.equal(result.ok, true); assert.equal(result.varianceXpf, 0); }
    const route = api(f, "sessions/import/route.ts", { importerCloture: importer });
    const response = await route.POST({ json: async () => ({ tenantId: tenant, ...b }) });
    assert.equal(response.status, hasDay ? 409 : 200);
    if (hasDay) { assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED"); assert.deepEqual(f.rows("cashSession"), before); }
    else { assert.equal(f.rows("cashSession").length, 1); assert.equal(f.rows("cashSession")[0].status, "CLOSED"); assert.equal(response.body.alreadyExisted, true); }
  }
});

test("septième relecture : CashDay fermé et session historique OPEN, retrait 500 refusé sans écriture", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, input({ sourceKey: "closed", cycle: 0,
    closureMode: "ONLINE", countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0" })));
  const legacy = await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 0n, openedAt: new Date("2026-10-14T01:00:00Z") } });
  const before = f.rows("cashDayEvent");
  const record = caisseFunction("recordCashMovement", { withTenant: f.withTenant, ...f.ledger, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockCashTenant: f.sync.lockCashTenant });
  const result = await record(tenant, { kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique" });
  assert.equal(result.ok, false); assert.equal(result.error, "NO_OPEN_SESSION");
  assert.equal(f.rows("cashMovement").length, 0); assert.deepEqual(f.rows("cashDayEvent"), before);
  assert.equal(f.rows("cashSession").find(s => s.id === legacy.id)!.status, "OPEN");
  assert.equal(await expected(f, day.id), 25000n);
});

for (const operation of ["checkout", "void"] as const) {
  test(`septième relecture : ${operation}, préparation et finalisation verrouillent Day avant Sale`, async () => {
    const f = fixture(true); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const day = f.rows("cashDay")[0];
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId: day.canonicalSessionId,
      totalXpf: 1000n, lines: [thousandLine()], ...(operation === "void" ? {
        status: "PAID", paidAt: now, invoiceId: "synthetic-invoice", payments: [{ method: "CASH", amountXpf: 1000n }],
      } : {}) } });
    const start = f.lockTraces.length;
    const operationNative = financialPorts(f);
    const result = operation === "checkout"
      ? await operationNative.checkoutSale(tenant, sale.id, [{ method: "CASH", amountXpf: 1000n }], { cashDayId: day.id })
      : await operationNative.annulerVente(tenant.toUpperCase(), sale.id.toUpperCase(), { sharedActionId: actor.toUpperCase(), actionId: actor.toUpperCase() });
    assert.equal(result.ok, true);
    const transactions = f.lockTraces.slice(start).filter(t => t.includes(`Sale:${sale.id}`));
    // Depuis le 19/10, le checkout paie et passe PAID dans UNE transaction ; l'annulation en garde deux.
    assert.equal(transactions.length, operation === "checkout" ? 1 : 2, "chaque transaction prend le verrou Sale");
    for (const locks of transactions) {
      assert.ok(locks.indexOf(`Tenant:cash-l4:${tenant}`) >= 0);
      assert.ok(locks.indexOf(`Tenant:cash-l4:${tenant}`) < locks.indexOf(`Day:${day.id}`));
      assert.ok(locks.indexOf(`Day:${day.id}`) < locks.indexOf(`Sale:${sale.id}`));
    }
    assert.equal(f.rows("sale")[0].status, operation === "checkout" ? "PAID" : "VOID");
    assert.equal(f.rows("cashDayEvent").filter(e => e.kind === (operation === "checkout" ? "SALE_PAID" : "SALE_VOID")).length, 1);
  });

  // Checkout en une transaction : plus de phase 2 où un rattachement concurrent pourrait apparaître.
  for (const phase of operation === "checkout" ? [1] : [1, 2]) {
    test(`septième relecture : ${operation} phase ${phase}, rattachement changé sous verrou refusé même en voie partagée`, async () => {
      const f = fixture(true); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
      const day = f.rows("cashDay")[0];
      const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId: day.canonicalSessionId,
        totalXpf: 1000n, lines: [thousandLine()] } });
      let calls = 0;
      const native = financialPorts(f, { lockSaleRow: async (tx: Row, id: string, tenantId: string) => {
        // Simule le rattachement concurrent devenu visible après l'attente du verrou.
        if (++calls === phase) await tx.sale.update({ where: { id }, data: { cashDayId: actor } });
        return f.locks.lockSaleRow(tx, id, tenantId);
      } });
      await assert.rejects(operation === "checkout"
        ? native.checkoutSale(tenant, sale.id, [{ method: "CASH", amountXpf: 1000n }], { sharedActionId: actor })
        : native.annulerVente(tenant, sale.id, { sharedActionId: actor }), routeRequired);
      assert.equal(f.rows("sale")[0].status, "DRAFT");
      assert.equal(f.rows("sale")[0].cashDayId, day.id, "transaction annulée");
      assert.equal(f.rows("sale")[0].payments.length, 0);
      assert.equal(f.rows("cashDayEvent").filter(e => e.saleId === sale.id).length, 0);
      assert.ok(f.lockTraces.every(t => !t.includes(`Day:${actor}`)), "aucun nouveau Day après Sale");
    });
  }
}

test("sixième relecture (a) : POST sans session puis checkout historique CASH 1000 refusés, T 25000, aucun paiement", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
    const native = financialPorts(f);
  const create = api(f, "sales/route.ts", { createSale: () => { assert.fail("aucune création historique autorisée"); } });
  const created = await create.POST({ json: async () => ({ tenantId: tenant, lines: [{ ...thousandLine(), unitXpf: 1000 }] }) });
  assert.equal(created.status, 409); assert.equal(created.body.error, "CASHDAY_ROUTE_REQUIRED");
  assert.equal(f.rows("sale").length, 0);
  // Ticket historique déjà présent avant le passage du commerce à CashDay.
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, totalXpf: 1000n, lines: [thousandLine()] } });
  const checkout = api(f, "sales/[id]/checkout/route.ts", native);
  const paid = await checkout.POST({ json: async () => ({ tenantId: tenant, payments: [{ method: "CASH", amountXpf: 1000 }] }) }, { params: Promise.resolve({ id: sale.id }) });
  assert.equal(paid.status, 409); assert.equal(paid.body.error, "CASHDAY_ROUTE_REQUIRED");
  // Même contrôle dans la transaction si la garde HTTP a lu avant l'ouverture du jour.
  await assert.rejects(native.checkoutSale(tenant, sale.id, [{ method: "CASH", amountXpf: 1000n }]), routeRequired);
  assert.equal(f.rows("sale")[0].status, "DRAFT"); assert.equal(f.rows("sale")[0].payments.length, 0);
  assert.equal(await expected(f, day.id), 25000n);
});

test("sixième relecture (b) : avoir CASH 1000 sur vente ancienne sans CashDay refusé, avec CashDay T 24000", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: "PAID", paidAt: new Date("2026-10-14T01:00:00Z"),
    invoiceId: "old-invoice", totalXpf: 1000n, lines: [thousandLine()], payments: [{ method: "CASH", amountXpf: 1000n }] } });
  const native = financialPorts(f), route = api(f, "sales/[id]/partial-refund/route.ts", native);
  const b = { tenantId: tenant, actionId: actor, reason: "Retour synthétique", lines: [{ lineId: tenantB, qty: 1 }], refundMethod: "CASH" };
  const response = await route.POST({ json: async () => b }, { params: Promise.resolve({ id: sale.id }) });
  assert.equal(response.status, 409); assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED");
  // Vérifie aussi le refus propre à l'adaptateur si la session choisie appartient à CashDay.
  const refundDb = load("partial-refund-db.ts", { "./cash-movement.ts": movements, "./partial-refund.ts": refundPolicy, "./cash-day-guard": f.guard, "./caisse-sync": f.sync });
  await assert.rejects(refundDb.partialRefundWithPorts(tenant, sale.id, b, {
    transact: (fn: (tx: Row) => Promise<unknown>) => f.withTenant(tenant, fn),
    lockTenant: (tx: Row) => f.guard.assertLegacyWriteAllowed(tx, tenant),
    lockAction: async () => {}, lockSale: (tx: Row) => f.locks.lockSaleRow(tx, sale.id, tenant),
    compta: { invoiceDetail: async () => ({ id: "old-invoice", sourceType: "caisse", sourceId: sale.id, totalXpf: 1000, paidXpf: 1000, tgcRatePpm: 0,
      lines: [{ ...thousandLine(), id: "invoice-line", unitXpf: 1000 }] }), creditNote: async () => assert.fail("aucun avoir émis") },
  }), routeRequired);
  assert.equal(f.rows("cashMovement").length, 0); assert.equal(f.rows("partialRefund").length, 0);
  assert.equal(await expected(f, day.id), 25000n);
  const valid = { ...b, cashDrawer: "EXTERNAL", cashDayId: day.id, drawerBusinessDay: day.businessDay, deviceId: "A", occurredAt: now.toISOString() };
  for (let i = 0; i < 2; i++) {
    const done = await route.POST({ json: async () => valid }, { params: Promise.resolve({ id: sale.id }) });
    assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(done.body.ok, true);
  }
  assert.equal(f.rows("cashMovement").filter(m => m.kind === "REFUND").length, 0);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE").length, 1);
  assert.equal(await expected(f, day.id), 24000n);
  assert.equal(f.rows("sale")[0].cashDayId, null);
});

for (const operation of ["checkout", "void"] as const) {
  test(`sixième relecture (${operation === "checkout" ? "c" : "d"}) : attachLegacy entre lecture et transaction ${operation}, refus historique ou journal CashDay`, async () => {
    for (const shared of [false, true]) {
      const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
      const day = f.rows("cashDay")[0];
      const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "racing", totalXpf: 1000n, lines: [thousandLine()] } });
      if (shared) await f.sync.financialReservation(`cash-days:${day.id}:sales:${sale.id}:${operation}`, input({ actionId: actor }));
      let first = true;
      const native = financialPorts(f, { getSale: async () => {
        const before = await f.tx.sale.findFirst({ where: { id: sale.id } });
        if (first) {
          first = false;
          await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "racing" }] })));
        }
        return before;
      } });
      const run = () => operation === "checkout"
        ? native.checkoutSale(tenant, sale.id, [{ method: "CASH", amountXpf: 1000n }], shared ? { sharedActionId: actor } : undefined)
        : native.annulerVente(tenant, sale.id, shared ? { actionId: actor, sharedActionId: actor } : undefined);
      if (shared) assert.equal((await run()).ok, true);
      else await assert.rejects(run(), routeRequired);
      const current = f.rows("sale")[0], facts = f.rows("cashDayEvent");
      assert.equal(current.cashDayId, day.id);
      assert.equal(current.status, shared ? operation === "checkout" ? "PAID" : "VOID" : "DRAFT");
      assert.equal(facts.filter(e => e.kind === (operation === "checkout" ? "SALE_PAID" : "LOCAL_VOID")).length, shared ? 1 : 0);
      assert.equal(current.payments.length, shared && operation === "checkout" ? 1 : 0);
      assert.equal(await expected(f, day.id), shared && operation === "checkout" ? 26000n : 25000n);
      assert.ok(f.queries.some(q => q.includes('FROM "Sale"') && q.includes("FOR UPDATE")));
    }
  });
}

test("avoir avec cashDayId : fermeture après garde HTTP refusée sous lockDay avant Compta et écriture", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: "PAID", invoiceId: "old-invoice", totalXpf: 1000n, lines: [thousandLine()] } });
  await f.tx.cashSession.update({ where: { id: day.currentSessionId }, data: { status: "CLOSED" } });
  const native = financialPorts(f, { comptaClient: () => ({ invoiceDetail: () => assert.fail("aucune lecture Compta"), creditNote: () => assert.fail("aucun avoir") }) });
  await assert.rejects(native.rembourserPartiellement(tenant, sale.id, { actionId: actor, reason: "Retour synthétique", lines: [{ lineId: tenantB, qty: 1 }], refundMethod: "CASH", cashDrawer: "EXTERNAL",
    cashDayId: day.id, drawerBusinessDay: day.businessDay, deviceId: "A", occurredAt: now.toISOString() }), routeRequired);
  assert.equal(f.rows("partialRefund").length, 0); assert.equal(f.rows("cashMovement").length, 0);
  assert.equal(await expected(f, day.id), 25000n);
  assert.ok(f.queries.some(q => q.includes('FROM "CashDay"') && q.includes("FOR UPDATE")));
});

test("void HTTP : rattachement après préparation, relecture finale refuse en 409 et T reste 25000", async () => {
  const f = fixture();
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "late-void", totalXpf: 1000n, lines: [thousandLine()] } });
  let calls = 0;
  const native = financialPorts(f, { withTenant: async (t: string, fn: (tx: Row) => Promise<unknown>) => {
    if (++calls === 2) {
      await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
      const day = f.rows("cashDay")[0];
      await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "late-void" }] })));
    }
    return f.withTenant(t, fn);
  } });
  const route = api(f, "sales/[id]/void/route.ts", native);
  const response = await route.POST({ json: async () => ({ tenantId: tenant }), headers: new Headers() }, { params: Promise.resolve({ id: sale.id }) });
  assert.equal(response.status, 409); assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED");
  assert.equal(f.rows("sale")[0].status, "DRAFT"); assert.ok(f.rows("sale")[0].cashDayId);
  assert.equal(f.rows("cashDayEvent").filter(e => ["SALE_VOID", "LOCAL_VOID"].includes(e.kind)).length, 0);
  assert.equal(await expected(f, f.rows("cashDay")[0].id), 25000n);
});

test("ancien avoir PENDING sur jour clos : refus explicite de réouverture, T 25000", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: "PAID", invoiceId: "old-invoice", totalXpf: 1000n, lines: [thousandLine()] } });
  const native = financialPorts(f, { afterCredit: () => f.withTenant(tenant, (tx: Row) => tx.cashSession.update({ where: { id: day.currentSessionId }, data: { status: "CLOSED" } })) });
  await assert.rejects(native.rembourserPartiellement(tenant, sale.id, { actionId: actor, reason: "Retour synthétique", lines: [{ lineId: tenantB, qty: 1 }], refundMethod: "CASH", cashDrawer: "EXTERNAL",
    cashDayId: day.id, drawerBusinessDay: day.businessDay, deviceId: "A", occurredAt: now.toISOString() }),
    (e: Row) => e.status === 409 && e.message === "REFUND_DAY_CLOSED_REOPEN_REQUIRED" && e.data.message.includes("rouvrir"));
  assert.equal(f.rows("partialRefund")[0].status, "PENDING"); assert.equal(f.rows("cashMovement").length, 0);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE").length, 0);
  assert.equal(await expected(f, day.id), 25000n);
});

test("CashDay ouvert prioritaire sur une session native plus récente : retrait 500 et T 24500", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const other = await f.tx.cashSession.create({ data: { tenantId: tenant, posteId: actor,
    openingFloatXpf: 999n, openedAt: new Date(now.getTime() + 1000) } });
  const record = caisseFunction("recordCashMovement", { withTenant: f.withTenant, ...f.ledger, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockCashTenant: f.sync.lockCashTenant });
  const result = await record(tenant, { kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique", ref: "priority" });
  assert.equal(result.movement.sessionId, day.currentSessionId);
  assert.notEqual(result.movement.sessionId, other.id);
  const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, day.id, new URLSearchParams()));
  assert.equal(page.projection.totauxCourants.expectedXpf, 24500n);
});

test("import : mouvements canonique et alias du jour, avoir carte sans effet tiroir, rejeu unique", async () => {
  for (const alias of [false, true]) {
    const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const day = f.rows("cashDay")[0];
    const sessionId = alias ? (await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 0n, openedAt: now } })).id : day.canonicalSessionId;
    const movement = await f.tx.cashMovement.create({ data: { tenantId: tenant, sessionId, kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique" } });
    await f.tx.cashMovement.create({ data: { tenantId: tenant, sessionId, kind: "CASH_OUT", amountXpf: 900n,
      reason: "Autre jour", createdAt: new Date("2026-10-14T01:00:00Z") } });
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, sessionId, status: "PAID", paidAt: now,
      sourceType: "synthetic", sourceId: "card-import", totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CARD", amountXpf: 1000n }] } });
    await f.tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, actionId: actor, status: "DONE",
      input: { refundMethod: "CARD" }, plan: { amountXpf: 300, parTaux: [] } } });
    const b = input({ cycle: 0, sessionIds: [sessionId], origins: [{ sourceType: "synthetic", sourceId: "card-import" }] });
    await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, b));
    await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, b));
    const facts = f.rows("cashDayEvent");
    assert.equal(facts.filter(e => e.kind === "MOVEMENT").length, 1);
    assert.equal(facts.find(e => e.kind === "MOVEMENT")!.sourceRef, movement.id);
    const refunds = facts.filter(e => e.kind === "PARTIAL_REFUND_DONE");
    assert.equal(refunds.length, 1); assert.equal(refunds[0].cashDeltaXpf, 0n);
    assert.equal(refunds[0].snapshot.payments[0].method, "CARD");
    assert.equal(refunds[0].snapshot.payments[0].amountXpf, "300");
    const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, day.id, new URLSearchParams()));
    assert.equal(page.projection.totauxCourants.expectedXpf, 24500n);
    assert.ok(f.queries.every(q => !q.includes('"Poste"')));
  }
});

test("ACK financier : nature, vente et CashDay doivent correspondre à la réservation", async () => {
  const f = fixture(), kind = `cash-days:${actor}:sales:${tenantB}:checkout`;
  await f.sync.financialReservation(kind, input({ actionId: actor }));
  const before = f.rows("caisseSyncAction");
  for (const data of [
    { id: tenantB, saleId: tenantB, cashDayId: actor, status: "DONE" },
    { id: tenant, saleId: tenant, cashDayId: actor, status: "PAID" },
    { id: tenantB, saleId: tenantB, cashDayId: tenant, status: "PAID" },
  ]) {
    await assert.rejects(f.withTenant(tenant, (tx: Row) => f.sync.ackFinancial(tx, tenant, actor, data)),
      (e: Row) => e.status === 409 && e.message === "ACTION_ID_CONFLICT");
    assert.deepEqual(f.rows("caisseSyncAction"), before);
  }
  await f.withTenant(tenant, (tx: Row) => f.sync.ackFinancial(tx, tenant, actor, { id: tenantB, saleId: tenantB, cashDayId: actor, status: "PAID" }));
  assert.equal(f.rows("caisseSyncAction")[0].state, "ACK");
});

test("avoir historique : collision checkout PENDING refusée en HTTP 409 avant Compta", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId: day.currentSessionId } });
  await f.sync.financialReservation(`cash-days:${day.id}:sales:${sale.id}:checkout`, input({ actionId: actor }));
  let externalCalls = 0;
  const refundDb = load("partial-refund-db.ts", { "./cash-movement.ts": movements, "./partial-refund.ts": refundPolicy, "./cash-day-guard": f.guard, "./caisse-sync": f.sync });
  const native = caisseFunction("rembourserPartiellement", { assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
    ...refundPolicy, assertTenantId: (v: string) => v, withTenant: f.withTenant,
    lockDay: f.ledger.lockDay, lockSharedSale: f.ledger.lockSharedSale, ackFinancial: f.sync.ackFinancial,
    lockSaleRow: async () => true, lockVoidResource: async () => {},
    comptaClient: () => ({ invoiceDetail: async () => { externalCalls++; }, creditNote: async () => { externalCalls++; } }),
    partialRefundWithPorts: refundDb.partialRefundWithPorts,
  });
  const route = load("../app/api/sales/[id]/partial-refund/route.ts", {
    "next/server": { NextResponse: { json: (body: unknown, options: Row) => ({ body, status: options.status }) } },
    "@/lib/service-auth": { hasServiceKey: () => true }, "@/lib/cles-service": { horsPortee: () => null }, "@/lib/caisse": { rembourserPartiellement: native },
    "@/lib/cash-day-guard": load("cash-day-guard.ts", { "./tenant": { withTenant: f.withTenant }, "./caisse-sync": f.sync, "./cash-day-projection": projection }),
    "@/lib/partial-refund": refundPolicy, "@/lib/cash-day-projection": projection,
  });
  const b = { tenantId: tenant, actionId: actor, reason: "Retour synthétique", lines: [{ lineId: tenantB, qty: 1 }],
    refundMethod: "CARD", cashDayId: day.id, drawerBusinessDay: "2026-10-15", deviceId: "A", occurredAt: now.toISOString() };
  const result = await route.POST({ json: async () => b }, { params: Promise.resolve({ id: sale.id }) });
  assert.equal(result.status, 409); assert.equal(result.body.error, "ACTION_ID_CONFLICT");
  assert.equal(externalCalls, 0); assert.equal(f.rows("caisseSyncAction")[0].state, "PENDING");
  assert.equal(f.rows("partialRefund").length, 0);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE").length, 0);
});

test("mouvement historique CashDay canonique ou alias : retrait 500, Z 24500 et rejeu sans doublon", async () => {
  for (const alias of [false, true]) {
    const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const id = f.rows("cashDay")[0].id;
    const close = (sourceKey: string, cycle: number, countedXpf: string) => input({ sourceKey, cycle, closureMode: "ONLINE",
      countedXpf, localExpectedXpf: countedXpf, localVarianceXpf: "0" });
    if (alias) {
      await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, id, close("before-reopen", 0, "25000")));
      await f.withTenant(tenant, (tx: Row) => f.days.reopenCashDay(tx, id, input({ actionId: "reopen", administration: true })));
    }
    const record = caisseFunction("recordCashMovement", { withTenant: f.withTenant, ...f.ledger, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockCashTenant: f.sync.lockCashTenant });
    const b = { kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique", ref: "legacy-out" };
    const first = await record(tenant, b);
    const replay = await record(tenant, b);
    assert.equal(first.ok, true); assert.equal(replay.alreadyExisted, true);
    assert.equal(first.movement.id, replay.movement.id);
    assert.equal(first.movement.sessionId, f.rows("cashDay")[0].currentSessionId);
    assert.equal(f.rows("cashMovement").length, 1);
    assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "MOVEMENT").length, 1);
    const result = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, id, close("after-out", alias ? 1 : 0, "24500")));
    assert.equal(result.report.expectedXpf, 24500); assert.equal(result.report.varianceXpf, 0);
    assert.equal(result.report.cashOutXpf, 500);
    const session = f.rows("cashSession").find(s => s.id === result.report.sessionId)!;
    assert.equal(session.expectedXpf, 24500n); assert.equal(session.varianceXpf, 0n);
  }
  // Même mouvement déjà journalisé par le chemin CashDay : même clé, aucun second fait.
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  await f.withTenant(tenant, (tx: Row) => f.sales.dayMovement(tx, id, input({ actionId: "shared-out", kind: "CASH_OUT", amountXpf: "500", reason: "Retrait synthétique" })));
  const record = caisseFunction("recordCashMovement", { withTenant: f.withTenant, ...f.ledger, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockCashTenant: f.sync.lockCashTenant });
  await record(tenant, { kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique", ref: "shared:shared-out" });
  assert.equal(f.rows("cashMovement").length, 1);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "MOVEMENT").length, 1);
  assert.ok(f.queries.every(q => !q.includes('"Poste"')));
  // Une session native isolée garde son mouvement sans fait CashDay.
  const standalone = fixture();
  await standalone.withTenant(tenant, (tx: Row) => standalone.native.openSessionTx(tx, tenant, { openingFloatXpf: 25000n }));
  const legacy = caisseFunction("recordCashMovement", { withTenant: standalone.withTenant, ...standalone.ledger, assertLegacyWriteAllowed: standalone.guard.assertLegacyWriteAllowed, lockCashTenant: standalone.sync.lockCashTenant });
  await legacy(tenant, { kind: "CASH_OUT", amountXpf: 500n, reason: "Retrait synthétique", ref: "standalone" });
  const session = standalone.rows("cashSession")[0];
  const closed = await standalone.withTenant(tenant, (tx: Row) => standalone.native.closeSessionTx(tx, tenant, { sessionId: session.id, closingCountedXpf: 24500n }));
  assert.equal(closed.report.expectedXpf, 24500); assert.equal(closed.report.varianceXpf, 0);
  assert.equal(standalone.rows("cashDayEvent").length, 0);
});

test("seconde clôture après réouverture : rapport journalier CASH 1000 + CARD 2000 figé", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const paid = async (amount: bigint, method: string, sessionId: string) => {
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId,
      status: "PAID", paidAt: now, totalXpf: amount, lines: [{ lineXpf: amount }], payments: [{ method, amountXpf: amount }] } });
    await f.withTenant(tenant, (tx: Row) => f.ledger.recordSharedSale(tx, tenant, sale.id));
  };
  const close = (sourceKey: string, cycle: number) => input({ sourceKey, cycle, closureMode: "ONLINE",
    countedXpf: "26000", localExpectedXpf: "26000", localVarianceXpf: "0" });
  await paid(1000n, "CASH", day.canonicalSessionId);
  const first = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, close("first", 0)));
  assert.equal(first.report.totalSalesXpf, 1000); assert.equal(first.report.expectedXpf, 26000);
  const frozen = f.rows("cashSession")[0];
  await f.withTenant(tenant, (tx: Row) => f.days.reopenCashDay(tx, day.id, input({ actionId: "reopen", administration: true })));
  // Le chemin CashDay vend sur la canonique même après réouverture.
  await paid(2000n, "CARD", day.canonicalSessionId);
  const second = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, close("second", 1)));
  assert.equal(second.report.totalSalesXpf, 3000); assert.equal(second.report.salesCount, 2);
  assert.equal(second.report.cashSalesXpf, 1000); assert.equal(second.report.byMethod.CASH, 1000);
  assert.equal(second.report.byMethod.CARD, 2000); assert.equal(second.report.openingFloatXpf, 25000);
  assert.equal(second.report.expectedXpf, 26000); assert.equal(second.report.varianceXpf, 0);
  const stored = f.rows("cashDayEvent").find(e => e.kind === "CLOSURE" && e.sourceRef === "second")!;
  assert.equal(projection.canonical(stored.snapshot.report), projection.canonical(second.report));
  const replay = await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, close("second", 1)));
  assert.equal(projection.canonical(replay.report), projection.canonical(second.report));
  assert.deepEqual(f.rows("cashSession")[0], frozen);
  const current = f.rows("cashSession")[1];
  assert.equal(current.expectedXpf, 26000n); assert.equal(current.varianceXpf, 0n);
  assert.ok(f.queries.every(q => !q.includes('"Poste"')));
});

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

test("avoir réservé J, confirmé J+1 : compté au jour de la confirmation, jamais deux fois", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const first = f.rows("cashDay")[0].id, tomorrow = "2026-10-16T01:00:00.000Z";
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "reserve-j",
    status: "PAID", paidAt: now, totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n }] } });
  await f.tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, status: "DONE", actionId: actor,
    createdAt: new Date(now), input: { refundMethod: "CASH" }, outcome: { ok: true, doneAt: tomorrow }, plan: { amountXpf: 200, parTaux: [] } } });
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, first, input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "reserve-j" }] })));
  const c = input({ sourceKey: "close-J", cycle: 0, closureMode: "ONLINE", countedXpf: "26000", localExpectedXpf: "26000", localVarianceXpf: "0" });
  await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, first, c));
  await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input({ businessDay: "2026-10-16", occurredAt: tomorrow,
    sourceKey: "opening-J+1", localSessionKey: "local-J+1" })));
  const second = f.rows("cashDay")[1].id;
  for (let i = 0; i < 2; i++) await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, second, input({ cycle: 0 })));
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, first, input({ cycle: 0 })));
  for (const [id, expected] of [[first, 26000n], [second, 24800n]] as const) {
    const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
    assert.equal(page.projection.totauxCourants.expectedXpf, expected);
  }
  const facts = f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE");
  assert.equal(facts.length, 1); assert.equal(facts[0].cashDayId, second);
});
test("avoir réservé 6 semaines avant sa confirmation : compté au jour de la confirmation", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const id = f.rows("cashDay")[0].id;
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "reserve-ancienne",
    status: "PAID", paidAt: new Date("2026-09-01T01:00:00.000Z"), totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n }] } });
  await f.tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, status: "DONE", actionId: actor,
    createdAt: new Date("2026-09-01T01:00:00.000Z"), input: { refundMethod: "CASH" }, outcome: { ok: true, doneAt: now.toISOString() },
    plan: { amountXpf: 200, parTaux: [] } } });
  for (let i = 0; i < 2; i++) await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, id, input({ cycle: 0 })));
  const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
  assert.equal(page.projection.totauxCourants.expectedXpf, 24800n);
});
test("avoir déjà porté au journal d'un autre jour : jamais rattaché une seconde fois", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const first = f.rows("cashDay")[0].id;
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: "synthetic", sourceId: "ailleurs",
    status: "PAID", paidAt: now, totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n }] } });
  const refund = await f.tx.partialRefund.create({ data: { tenantId: tenant, saleId: sale.id, status: "DONE", actionId: actor,
    input: { refundMethod: "CASH" }, plan: { amountXpf: 200, parTaux: [] } } });
  await f.tx.cashDayEvent.create({ data: { tenantId: tenant, cashDayId: "99999999-9999-4999-a999-999999999999", kind: "PARTIAL_REFUND_DONE",
    sourceRef: actor, refundActionId: refund.id, deviceId: "autre", occurredAt: new Date(now), snapshot: {}, sequence: 1n, cashDeltaXpf: -200n } });
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, first, input({ cycle: 0 })));
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PARTIAL_REFUND_DONE" && e.cashDayId === first).length, 0);
});
test("PREVIOUS_SESSION_OPEN n'est pas mémorisé : le rejeu identique réussit une fois l'autre session close", async () => {
  const f = fixture();
  await f.sync.cashAction("open", input(), (tx: Row) => f.days.openCashDay(tx, input()));
  const next = input({ actionId: "next-retry", sourceKey: "opening-next-retry", businessDay: "2026-10-16", occurredAt: "2026-10-16T01:00:00Z" });
  let calls = 0;
  const open = () => f.sync.cashAction("open", next, (tx: Row) => { calls++; return f.days.openCashDay(tx, next); });
  assert.equal((await open()).body.error, "PREVIOUS_SESSION_OPEN");
  assert.equal(f.rows("caisseSyncAction").find(r => r.actionId === "next-retry")!.state, "PENDING");
  const id = f.rows("cashDay")[0].id;
  await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, id, input({ sourceKey: "close-before-retry", cycle: 0, closureMode: "ONLINE",
    countedXpf: "25000", localExpectedXpf: "25000", localVarianceXpf: "0" })));
  const retried = await open();
  assert.equal(retried.status, 200); assert.equal(calls, 2); assert.equal(f.rows("cashDay").length, 2);
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
    const f = fixture();
    if (!beforeImport) await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    let id = f.rows("cashDay")[0]?.id;
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: beforeImport ? null : id,
      sourceType: "synthetic", sourceId: "corrected", status: "PAID", paidAt: now, invoiceId: "synthetic-invoice", comptaSyncedAt: now,
      totalXpf: 1000n, lines: [{ lineXpf: 1000n }], payments: [{ method: "CASH", amountXpf: 1000n, settleRef: "initial" }] } });
    if (!beforeImport) await f.withTenant(tenant, (tx: Row) => f.ledger.recordSharedSale(tx, tenant, sale.id));
    let comptaCalls = 0;
    const correct = caisseFunction("corrigerMoyenPaiement", { withTenant: f.withTenant, ...f.ledger,
      normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference, findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
      assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
      lockSaleRow: async () => true, comptaClient: () => ({ paymentCorrection: async () => { comptaCalls++; return { ok: true }; } }),
      verifierCorrection: corrections.verifierCorrection, generationCorrection: corrections.generationCorrection, correctionKeyPour: corrections.correctionKeyPour, runPaymentCorrection: (deps: corrections.PaymentCorrectionDeps, b: corrections.PaymentCorrectionInput) => corrections.runPaymentCorrection(deps, { ...b, maintenant: now }),
    });
    const b = { saleId: sale.id, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 };
    assert.notEqual(sale.id, sale.id.toUpperCase());
    const results = await Promise.all([correct(tenant.toUpperCase(), { ...b, saleId: sale.id.toUpperCase() }), correct(tenant, b)]);
    assert.ok(results.every(r => r.ok)); assert.ok(results.some(r => r.alreadyCorrected));
    const comptaBeforeInvalid = comptaCalls;
    await assert.rejects(correct(tenant, { ...b, saleId: "invalid-sale-id" }), (e: Row) => e.status === 400 && e.message === "INVALID_PAYLOAD");
    assert.equal(comptaCalls, comptaBeforeInvalid, "UUID invalide refusé avant Compta");
    if (beforeImport) {
      await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
      id = f.rows("cashDay")[0].id;
    }
    const attach = input({ cycle: 0, origins: [{ sourceType: "synthetic", sourceId: "corrected" }] });
    for (let i = 0; i < 2; i++) await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, id, attach));
    const page = await f.withTenant(tenant, (tx: Row) => f.days.ledgerPage(tx, tenant, id, new URLSearchParams()));
    assert.equal(f.rows("cashSession")[0].status, "OPEN");
    assert.equal(page.projection.totauxCourants.expectedXpf, 25000n);
    assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PAYMENT_CORRECTION").length, 1);
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
  assert.equal(replay.ok, true); assert.deepEqual(replay, f.rows("caisseSyncAction").find(a => a.actionId === actor)!.response);
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
  const native = caisseFunction("rembourserPartiellement", { assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
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
    "@/lib/service-auth": { hasServiceKey: () => true }, "@/lib/cles-service": { horsPortee: () => null }, "@/lib/caisse": { rembourserPartiellement: native },
    "@/lib/partial-refund": refundPolicy,
      "@/lib/cash-day-guard": load("cash-day-guard.ts", { "./tenant": { withTenant: f.withTenant }, "./caisse-sync": f.sync, "./cash-day-projection": projection }),
      "@/lib/cash-day-projection": projection,
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
  assert.equal(applied, 1); assert.equal(projection.canonical(out[1]), projection.canonical(out[0]));
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
  const next = input({ actionId: "next", sourceKey: "opening-next-day", businessDay: "2026-10-16", occurredAt: "2026-10-16T01:00:00Z" });
  const nextWithPoste = { ...next, posteId: "caisse-1" };
  const result = await f.sync.cashAction("open", nextWithPoste, (tx: Row) => f.days.openCashDay(tx, nextWithPoste));
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

test("quota plein : openCashDay crée une session sans posteId", async () => {
  const f = fixture(); let quotaCalls = 0; let receivedPosteId: unknown = "sentinel";
  const quota = { plafond: 1, utilise: 1 };
  const inscrirePosteEnLigne = async () => { quotaCalls++; return { ok: false, quota: { error: "POSTE_QUOTA_ATTEINT", ...quota } }; };
  const realOpenSessionTx = caisseFunction("openSessionTx", { Prisma: { PrismaClientKnownRequestError: class extends Error {} } });
  f.native.openSessionTx = async (tx: Row, tenantId: string, b: Row) => { receivedPosteId = b.posteId ?? null; return realOpenSessionTx(tx, tenantId, b); };
  f.native.inscrirePosteEnLigne = inscrirePosteEnLigne;
  f.native.openSession = async () => { const registered = await inscrirePosteEnLigne(); return registered.ok ? { ok: true } : { ok: false, ...registered.quota }; };
  const result = await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  assert.equal(result.id, f.rows("cashDay")[0].id);
  assert.equal(receivedPosteId, null);
  assert.equal(f.rows("cashSession")[0].posteId, null);
  assert.equal(quotaCalls, 0);
  assert.deepEqual(quota, { plafond: 1, utilise: 1 });
  const manager = readFileSync(new URL("cash-days.ts", import.meta.url), "utf8");
  const opening = manager.slice(manager.indexOf("export async function openCashDay"), manager.indexOf("export async function dayState"));
  assert.match(opening, /openSessionTx\(tx/); assert.doesNotMatch(opening, /openSession\(|inscrirePosteEnLigne/);
});

test("correction partagée : vente UUID majuscule puis rejeu minuscule conserve un seul appel Compta", async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows("cashDay")[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, status: "PAID", paidAt: now,
    invoiceId: "synthetic-invoice", comptaSyncedAt: now, totalXpf: 1000n, lines: [thousandLine()],
    payments: [{ method: "CASH", amountXpf: 1000n, settleRef: "initial" }] } });
  await f.withTenant(tenant, (tx: Row) => f.ledger.recordSharedSale(tx, tenant, sale.id));
  let comptaCalls = 0;
  const correct = caisseFunction("corrigerMoyenPaiement", { withTenant: f.withTenant, ...f.ledger, normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference,
    findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockSaleRow: async () => true,
    comptaClient: () => ({ paymentCorrection: async () => { comptaCalls++; return { ok: true }; } }),
    verifierCorrection: corrections.verifierCorrection, generationCorrection: corrections.generationCorrection,
    correctionKeyPour: corrections.correctionKeyPour,
    runPaymentCorrection: (deps: corrections.PaymentCorrectionDeps, b: corrections.PaymentCorrectionInput) => corrections.runPaymentCorrection(deps, { ...b, maintenant: now }),
  });
  assert.notEqual(sale.id, sale.id.toUpperCase());
  const first = await correct(tenant.toUpperCase(), { saleId: sale.id.toUpperCase(), fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 });
  assert.equal(first.ok, true);
  assert.ok(f.rows("sale")[0].payments.filter((p: Row) => p.settleRef?.startsWith("corr:")).every((p: Row) => p.settleRef.includes(sale.id)));
  const replay = await correct(tenant, { saleId: sale.id, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 });
  assert.equal(replay.ok, true); assert.equal(replay.alreadyCorrected, true); assert.equal(comptaCalls, 1);
  await assert.rejects(correct(tenant, { saleId: "invalid-sale-id", fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 }),
    (e: Row) => e.status === 400 && e.message === "INVALID_PAYLOAD");
  assert.equal(comptaCalls, 1);
  assert.equal(f.rows("cashDayEvent").filter(e => e.kind === "PAYMENT_CORRECTION").length, 1);
  assert.equal(await expected(f, day.id), 25000n);
});

test('correction partagée : settleRef nouvelle dérivée de l’ID stocké malgré saleId reçu majuscule', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows('cashDay')[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sourceType: 'synthetic', sourceId: 'corr-history', status: 'PAID', paidAt: now,
    invoiceId: 'synthetic-invoice', comptaSyncedAt: now, totalXpf: 1000n, lines: [thousandLine()],
    payments: [{ method: 'CASH', amountXpf: 1000n, settleRef: 'initial' }] } });
  const correct = caisseFunction('corrigerMoyenPaiement', { withTenant: f.withTenant, ...f.ledger, normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference,
    findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed, lockSaleRow: async () => true,
    comptaClient: () => ({ paymentCorrection: async () => ({ ok: true }) }),
    verifierCorrection: corrections.verifierCorrection, generationCorrection: corrections.generationCorrection,
    correctionKeyPour: corrections.correctionKeyPour,
    runPaymentCorrection: (deps: corrections.PaymentCorrectionDeps, b: corrections.PaymentCorrectionInput) => corrections.runPaymentCorrection(deps, { ...b, maintenant: now }),
  });
  const result = await correct(tenant, { saleId: sale.id.toUpperCase(), fromMethod: 'CASH', toMethod: 'CARD', amountXpf: 100 });
  assert.equal(result.ok, true);
  assert.ok(f.rows('sale')[0].payments.filter((p: Row) => p.settleRef?.startsWith('corr:')).every((p: Row) => p.settleRef.includes(sale.id)));
  assert.equal(f.rows('cashDayEvent').filter(e => e.kind === 'PAYMENT_CORRECTION').length, 1);
  assert.equal(await expected(f, day.id), 25900n);
});

test("createSale garde posteId texte exact et normalise les autres UUID avant accès aux ports", async () => {
  fixture(); // fournit à caisseFunction les fonctions uuid/normalizeActionInput réellement chargées.
  const ids = {
    tenant: "ab000000-0000-0000-0000-000000000011", session: "ab000000-0000-0000-0000-000000000012",
    cashier: "ab000000-0000-0000-0000-000000000013", poste: "ab000000-0000-0000-0000-000000000014",
    product: "ab000000-0000-0000-0000-000000000015", service: "ab000000-0000-0000-0000-000000000016",
    order: "ab000000-0000-0000-0000-000000000017",
  };
  let salesCreated = 0, cardsCreated = 0, giftInput: Row | undefined, saleData: Row | undefined;
  const tx = {
    sale: { create: async ({ data }: Row) => { salesCreated++; saleData = data; return { id: "a0000000-0000-0000-0000-000000000099", totalXpf: data.totalXpf }; } },
    giftCard: { create: async ({ data }: Row) => { cardsCreated++; assert.equal(data.serviceId, ids.service); return data; } },
  };
  const globals = { withTenant: async (_tenantId: string, fn: (tx: Row) => Promise<unknown>) => fn(tx),
    assertLegacyWriteAllowed: async () => {}, validateGiftCard: (input: Row) => { giftInput = input; return { ok: true, data: { ...input } }; },
    GIFT_CARD_SELECT: {}, toGiftCardView: (row: Row) => row, Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    // Session OPEN : renvoyée telle quelle ; elle doit déjà être normalisée.
    openSaleSession: async (_tx: Row, _tenantId: string, sessionId: string) => { assert.equal(sessionId, ids.session); return sessionId; } };
  const createSale = caisseFunction("createSale", { ...globals, uuid: activeSync.uuid, normalizeActionInput: activeSync.normalizeActionInput, receivedActionInput: activeSync.receivedActionInput });
  const upper = (id: string) => id.toUpperCase();
  assert.notEqual(ids.session, upper(ids.session));
  const sale = await createSale(upper(ids.tenant), { sessionId: upper(ids.session), cashierId: upper(ids.cashier), posteId: upper(ids.poste),
    lines: [{ kind: "PRODUCT", productId: upper(ids.product), label: "Article synthétique", qty: 1, unitXpf: 1000n }] });
  assert.equal(sale.ok, true); assert.equal(salesCreated, 1);
  assert.equal(saleData!.sessionId, ids.session); assert.equal(saleData!.cashierId, ids.cashier); assert.equal(saleData!.posteId, upper(ids.poste));
  assert.equal(saleData!.lines.create[0].productId, ids.product);
  const freePoste = await createSale(ids.tenant, { posteId: "caisse-1", lines: [{ kind: "OTHER", label: "X", qty: 1, unitXpf: 1n }] });
  assert.equal(freePoste.ok, true); assert.equal(saleData!.posteId, "caisse-1");
  await assert.rejects(createSale(ids.tenant, { sessionId: "invalid-session", lines: [{ kind: "OTHER", label: "X", qty: 1, unitXpf: 1n }] }),
    (e: Row) => e.status === 400 && e.message === "INVALID_PAYLOAD");
  assert.equal(salesCreated, 2, "session invalide refusée avant le port base");

  const createGift = caisseFunction("createGiftCardWithoutSale", globals);
  const created = await createGift(upper(ids.tenant), { code: "SYNTHETIC", amountXpf: 1000, serviceId: upper(ids.service), orderId: upper(ids.order) });
  assert.equal(created.ok, true); assert.equal(cardsCreated, 1);
  assert.equal(giftInput!.serviceId, ids.service); assert.equal(giftInput!.orderId, ids.order);
  await assert.rejects(createGift(ids.tenant, { code: "INVALID", amountXpf: 1000, serviceId: "invalid-service" }),
    (e: Row) => e.status === 400 && e.message === "INVALID_PAYLOAD");
  assert.equal(cardsCreated, 1, "serviceId invalide refusé avant le port base");
});

for (const operation of ["partial-refund", "void"] as const) {
  test(`UUID ${operation} CashDay : majuscules puis rejeu minuscule, Z 25000, invalide avant Compta`, async () => {
    const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
    const day = f.rows("cashDay")[0];
    const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId: day.canonicalSessionId,
      sourceType: "synthetic", sourceId: `uuid-${operation}`, status: "PAID", paidAt: now, invoiceId: "synthetic-invoice",
      totalXpf: 1000n, lines: [thousandLine()], payments: [{ method: "CASH", amountXpf: 1000n }] } });
    await f.withTenant(tenant, (tx: Row) => f.ledger.recordSharedSale(tx, tenant, sale.id));
    assert.equal(await expected(f, day.id), 26000n);
    let comptaCalls = 0;
    const native = financialPorts(f, { afterCredit: () => { comptaCalls++; } });
    const finance = load("cash-day-finance.ts", { "./caisse": native, "./tenant": { withTenant: f.withTenant },
      "./caisse-sync": f.sync, "./cash-day-ledger": f.ledger, "./cash-day-projection": projection, "./partial-refund": refundPolicy });
    const base = input({ actionId: actor, tenantId: tenant, entityKey: sale.id, reason: "Retour synthétique", cashDayId: day.id,
      lines: [{ lineId: tenantB, qty: 1 }], refundMethod: "CASH" });
    for (const [badDay, badSale, badBody] of [
      ["invalid-day", sale.id, base], [day.id, "invalid-sale", base],
      [day.id, sale.id, { ...base, actionId: "invalid-action" }],
      ...(operation === "partial-refund" ? [[day.id, sale.id, { ...base, lines: [{ lineId: "invalid-line", qty: 1 }] }] as const] : []),
    ] as const) {
      await assert.rejects(finance.dayFinancial(badDay, badSale, operation, badBody), (e: Row) => e.status === 400 && e.message === "INVALID_PAYLOAD");
    }
    assert.equal(comptaCalls, 0, "UUID invalides refusés avant Compta");
    const upper = { ...base, tenantId: tenant.toUpperCase(), actionId: actor.toUpperCase(), entityKey: sale.id.toUpperCase(),
      cashDayId: day.id.toUpperCase(), lines: [{ lineId: tenantB.toUpperCase(), qty: 1 }] };
    assert.notEqual(sale.id, sale.id.toUpperCase()); assert.notEqual(day.id, day.id.toUpperCase());
    assert.notEqual(actor, actor.toUpperCase()); assert.notEqual(tenantB, tenantB.toUpperCase());
    const first = await finance.dayFinancial(day.id.toUpperCase(), sale.id.toUpperCase(), operation, upper);
    assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(comptaCalls, 1);
    assert.equal(await expected(f, day.id), 25000n);
    const replay = await finance.dayFinancial(day.id, sale.id, operation, base);
    assert.deepEqual(replay, first); assert.equal(comptaCalls, 1);
    assert.equal(await expected(f, day.id), 25000n);
  });
}


for (const financial of [false, true]) test('empreinte brute : UUID normalises, contenu divergent refuse ' + financial, async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows('cashDay')[0];
  const raw = input({ actionId: actor.toUpperCase(), tenantId: tenant.toUpperCase(), cashDayId: day.id.toUpperCase(),
    kind: 'CASH_OUT', amountXpf: '1000', reason: 'Retrait synthetique' });
  const kind = 'cash-days:' + day.id.toUpperCase() + ':movements';
  const response = financial ? { ok: true, data: { payments: [{ method: 'CARD', amountXpf: '1000' }] } }
    : { status: 200, body: { ok: true, alreadyApplied: false, data: { id: actor } } };
  if (!financial) await f.withTenant(tenant, (tx: Row) => f.sales.dayMovement(tx, day.id, f.sync.normalizeActionInput(raw)));
  await f.tx.caisseSyncAction.create({ data: { tenantId: tenant, actionId: actor, deviceId: 'A', kind, entityKey: raw.entityKey,
    payload: raw, requestHash: require('node:crypto').createHash('sha256').update(projection.canonical({ kind, b: raw })).digest('hex'), state: 'ACK', response } });
  const lower = f.sync.normalizeActionInput(raw);
  for (const b of [lower, raw]) {
    const replay = financial ? await f.sync.financialReservation(kind.toLowerCase(), b)
      : await f.sync.cashAction(kind.toLowerCase(), b, async () => { assert.fail('aucune seconde execution'); });
    sameResponse(replay, response);
  }
  if (financial) await assert.rejects(f.sync.financialReservation(kind, { ...lower, amountXpf: '2000' }), (e: Row) => e.status === 409 && e.message === 'ACTION_ID_CONFLICT');
  else {
    assert.equal((await f.sync.cashAction(kind, { ...lower, amountXpf: '2000' }, async () => null)).status, 409);
    assert.equal(f.rows('cashMovement').length, 1); assert.equal(await expected(f, day.id), 24000n);
  }
});

test('mouvement HTTP : UUID du jour majuscule puis minuscule, reponse identique et conflit reel 409', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input())); const day = f.rows('cashDay')[0];
  const route = api(f, 'cash-days/[id]/movements/route.ts', {});
  const b = input({ actionId: actor, kind: 'CASH_OUT', amountXpf: '1000', reason: 'Retrait synthetique' });
  const send = (id: string, body = b) => route.POST({ json: async () => body, headers: new Headers({ 'Idempotency-Key': actor }) }, { params: Promise.resolve({ id }) });
  const first = await send(day.id.toUpperCase()); assert.equal(first.status, 200);
  sameResponse(await send(day.id), first); sameResponse(await send(day.id.toUpperCase()), first);
  const conflict = await send(day.id, { ...b, amountXpf: '2000' });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'ACTION_ID_CONFLICT');
  assert.equal(f.rows('cashMovement').length, 1); assert.equal(await expected(f, day.id), 24000n);
});

test('trois corrections distinctes CASH CARD CASH CARD : Compta converge, rejeux figes et Z 25000', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input())); const day = f.rows('cashDay')[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, status: 'DRAFT', paidAt: null,
    invoiceId: 'synthetic-invoice', comptaSyncedAt: now, totalXpf: 1000n, lines: [thousandLine()], payments: [] } });
  const compta = new Map<string, number>([['CASH', 0], ['CARD', 0]]), keys = new Set<string>();
  let calls = 0;
  const native = financialPorts(f, { comptaClient: () => ({ receiptUrl: () => 'https://synthetic.invalid/receipt' }), syncLoadedSale: async () => {
    calls++; keys.add('checkout:' + sale.id); compta.set('CASH', 1000);
    return { synced: true, invoiceId: 'synthetic-invoice', stockDecremented: 0 };
  } });
  assert.equal((await native.checkoutSale(tenant, sale.id, [{ method: 'CASH', amountXpf: 1000n }], { sharedActionId: tenant })).ok, true);
  const correct = caisseFunction('corrigerMoyenPaiement', { withTenant: f.withTenant, ...f.ledger, ...f.locks,
    normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference, findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
    comptaClient: () => ({ paymentCorrection: async (args: Row) => {
      calls++; assert.ok(!keys.has(args.correctionKey)); keys.add(args.correctionKey);
      compta.set(args.fromMethod, compta.get(args.fromMethod)! - args.amountXpf);
      compta.set(args.toMethod, compta.get(args.toMethod)! + args.amountXpf); return { ok: true };
    } }) });
  const actions = [actor, tenantB, 'ab000000-0000-0000-0000-000000000009'].map((actionId, i) => ({ actionId, saleId: sale.id,
    fromMethod: i === 1 ? 'CARD' : 'CASH', toMethod: i === 1 ? 'CASH' : 'CARD', amountXpf: 1000 }));
  const results: Row[] = [];
  for (const action of actions) results.push(await correct(tenant, action));
  assert.ok(results.every(r => r.ok)); assert.equal(calls, 4); assert.equal(keys.size, 4);
  assert.equal(compta.get('CASH'), 0); assert.equal(compta.get('CARD'), 1000);
  assert.equal(results[2].payments.find((p: Row) => p.method === 'CARD').amountXpf, 1000);
  // Simulation d'une ancienne cle stockee en majuscules.
  await f.tx.caisseSyncAction.updateMany({ where: { actionId: actor }, data: { actionId: actor.toUpperCase(), entityKey: sale.id.toUpperCase(), requestHash: projection.canonical({ saleId: sale.id.toUpperCase(), fromMethod: 'CASH', toMethod: 'CARD', amountXpf: 1000 }) } });
  for (const i of [0, 1, 2, 0]) {
    const action = actions[i]; sameResponse(await correct(tenant.toUpperCase(), { ...action, actionId: action.actionId.toUpperCase() }), results[i]);
    sameResponse(await correct(tenant, action), results[i]);
  }
  await assert.rejects(correct(tenant, { ...actions[0], amountXpf: 999 }), (e: Row) => e.status === 409 && e.message === 'ACTION_ID_CONFLICT');
  assert.equal(calls, 4); assert.equal(f.rows('sale')[0].payments.length, 7);
  assert.equal(f.rows('cashDayEvent').filter(e => e.kind === 'PAYMENT_CORRECTION').length, 3);
  assert.equal(await expected(f, day.id), 25000n);
  const close = input({ cycle: 0, sourceKey: 'close-corrections', closureMode: 'ONLINE', countedXpf: '25000', localExpectedXpf: '25000', localVarianceXpf: '0' });
  assert.equal((await f.withTenant(tenant, (tx: Row) => f.days.closeCashDay(tx, day.id, close))).report.expectedXpf, 25000);
});

for (const operation of ['partial-refund', 'void']) test('ancienne cle ' + operation + ' en majuscules : aucun second avoir, reponse enregistree', async () => {
  const f = fixture(); let calls = 0;
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, status: 'PAID', paidAt: now, invoiceId: 'synthetic-invoice', totalXpf: 1000n, lines: [thousandLine()], payments: [] } });
  const native = financialPorts(f, { afterCredit: () => { calls++; } });
  const b = { actionId: actor, reason: 'Retour synthetique', refundMethod: 'CARD', lines: [{ lineId: tenantB, qty: 1 }] };
  const run = (body: Row) => operation === 'void' ? native.annulerVente(tenant, sale.id, body) : native.rembourserPartiellement(tenant, sale.id, body);
  const first = await run(b); assert.equal(first.ok, true); assert.equal(calls, 1);
  const model = operation === 'void' ? 'voidAction' : 'partialRefund';
  const old = f.rows(model)[0];
  await f.tx[model].update({ where: { id: old.id }, data: { actionId: actor.toUpperCase(),
    ...(operation === 'partial-refund' ? { input: { ...old.input, actionId: actor.toUpperCase(), lines: [{ lineId: tenantB.toUpperCase(), qty: 1 }] } } : {}) } });
  sameResponse(await run(b), first); sameResponse(await run({ ...b, actionId: actor.toUpperCase() }), first);
  assert.equal(calls, 1); assert.equal(f.rows(model).length, 1);
  if (operation === 'partial-refund') assert.equal((await run({ ...b, reason: 'Contenu different' })).error, 'ACTION_ID_CONFLICT');
});

test('journal : UUID normalises des la creation et snapshots rejoues sans doublon', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input())); const day = f.rows('cashDay')[0];
  const fact = { kind: 'MOVEMENT', sourceRef: actor.toUpperCase(), deviceId: 'A', occurredAt: now, snapshot: { kind: 'CASH_OUT', amountXpf: '1000', actorId: actor.toUpperCase() } };
  await f.ledger.appendDayFact(f.tx, tenant, day.id, fact);
  const old = f.rows('cashDayEvent').find(e => e.kind === 'MOVEMENT')!;
  assert.equal(old.sourceRef, actor);
  assert.equal(old.snapshot.actorId, actor);
  await f.ledger.appendDayFact(f.tx, tenant, day.id, { ...fact, sourceRef: actor, snapshot: { ...fact.snapshot, actorId: actor } });
  assert.equal(f.rows('cashDayEvent').filter(e => e.kind === 'MOVEMENT').length, 1); assert.equal(await expected(f, day.id), 24000n);
});

function sameResponse(actual: unknown, saved: unknown) { assert.equal(projection.canonical(actual), projection.canonical(saved)); }

test('session OPEN : poste libre texte exact, ouvertures concurrentes sans doublon', async () => {
  const f = fixture();
  const old = await f.tx.cashSession.create({ data: { tenantId: tenant, posteId: "caisse-1", openingFloatXpf: 25000n } });
  await f.tx.cashSession.create({ data: { tenantId: tenantB, posteId: actor, openingFloatXpf: 99n } });
  const current = caisseFunction('currentSession', { withTenant: f.withTenant });
  const open = caisseFunction('openSessionTx', {});
  assert.equal((await current(tenant, "caisse-1")).id, old.id);
  assert.equal(await current(tenant, "Caisse-1"), null);
  const results = await Promise.all(["caisse-1", "caisse-1"].map(posteId =>
    f.withTenant(tenant, (tx: Row) => open(tx, tenant, f.sync.normalizeActionInput({ posteId, openedBy: actor, openingFloatXpf: 0n })))));
  for (const result of results) {
    assert.equal(result.ok, false); assert.equal(result.error, 'SESSION_ALREADY_OPEN'); assert.equal(result.sessionId, old.id);
  }
  assert.equal(f.rows('cashSession').length, 2);
  assert.equal(f.rows('cashSession')[0].posteId, "caisse-1");
  assert.equal(f.rows('cashDay').length, 0);
});

test('journal : correction historique corr UUID majuscule rattachée et Z juste', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows('cashDay')[0];
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, cashDayId: day.id, sourceType: 'synthetic', sourceId: 'corr-history', status: 'PAID', paidAt: now,
    totalXpf: 1000n, lines: [thousandLine()], payments: [{ method: 'CASH', amountXpf: 1000n, settleRef: 'initial' }] } });
  const correctionBase = `corr:caisse:${sale.id.toUpperCase()}:legacy`;
  await f.tx.salePayment.create({ data: { saleId: sale.id, method: 'CASH', amountXpf: -100n, settleRef: `${correctionBase}:out` } });
  await f.tx.salePayment.create({ data: { saleId: sale.id, method: 'CARD', amountXpf: 100n, settleRef: `${correctionBase}:in` } });
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, input({ sourceKey: 'attach-uppercase-correction', cycle: 0,
    origins: [{ sourceType: 'synthetic', sourceId: 'corr-history' }] })));
  assert.equal(f.rows('cashDayEvent').filter(e => e.kind === 'PAYMENT_CORRECTION').length, 1);
  assert.equal(await expected(f, day.id), 25900n);
});

test('avoir CASH : poste texte exact retrouvé en préparation et finalisation', async () => {
  const f = fixture();
  const session = await f.tx.cashSession.create({ data: { tenantId: tenant, posteId: 'caisse-1', openingFloatXpf: 25000n } });
  await f.tx.cashSession.create({ data: { tenantId: tenantB, posteId: actor, openingFloatXpf: 99n } });
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, posteId: 'caisse-1', sessionId: session.id, status: 'PAID',
    invoiceId: 'synthetic-invoice', totalXpf: 1000n, lines: [thousandLine()] } });
  let credits = 0;
  const native = financialPorts(f, { afterCredit: () => { credits++; } });
  const request = { actionId: actor, reason: 'Retour synthétique', lines: [{ lineId: tenantB, qty: 1 }], refundMethod: 'CASH' };
  assert.equal((await native.rembourserPartiellement(tenant, sale.id, request)).ok, true);
  assert.equal((await native.rembourserPartiellement(tenant, sale.id, request)).ok, true);
  assert.equal(credits, 1); assert.equal(f.rows('partialRefund').length, 1);
  assert.equal(f.rows('partialRefund')[0].status, 'DONE');
  assert.equal(f.rows('cashMovement').length, 1); assert.equal(f.rows('cashMovement')[0].sessionId, session.id);
  assert.equal(f.rows('cashSession')[0].posteId, 'caisse-1');
  assert.equal(f.rows('cashDay').length, 0);
});

test('session OPEN : P2002 relit le poste historique exact', async () => {
  const f = fixture();
  class ConcurrentOpen extends Error { code = 'P2002'; }
  const open = caisseFunction('openSessionTx', { Prisma: { PrismaClientKnownRequestError: ConcurrentOpen } });
  const create = f.tx.cashSession.create.bind(f.tx.cashSession);
  let winner: Row;
  f.tx.cashSession.create = async ({ data }: Row) => {
    winner = await create({ data: { ...data, posteId: data.posteId } });
    throw new ConcurrentOpen();
  };
  const result = await open(f.tx, tenant, { posteId: actor, openedBy: actor, openingFloatXpf: 0n });
  assert.equal(result.ok, false); assert.equal(result.sessionId, winner!.id);
  assert.equal(f.rows('cashSession').length, 1);
});

test('session OPEN : caisse-1 accepté, Caisse-1 distinct, null conservé', async () => {
  const f = fixture();
  const current = caisseFunction('currentSession', { withTenant: f.withTenant });
  const open = caisseFunction('openSessionTx', {});
  for (const posteId of ['caisse-1', 'Caisse-1', 'ABC', 'abc', actor.toUpperCase(), null]) {
    const result = await open(f.tx, tenant, { posteId, openedBy: actor, openingFloatXpf: 0n });
    assert.equal(result.ok, true);
    assert.equal((await current(tenant, posteId)).id, result.session.id);
  }
  assert.deepEqual(f.rows('cashSession').map(s => s.posteId), ['caisse-1', 'Caisse-1', 'ABC', 'abc', actor.toUpperCase(), null]);
  assert.notEqual((await current(tenant, 'caisse-1')).id, (await current(tenant, 'Caisse-1')).id);
  assert.equal((await current(tenant)).posteId, null);
});

// Sources historiques TEXT : mêmes ports que la production, comparaisons sensibles
// à la casse (contrairement aux colonnes PostgreSQL UUID).
for (const storedSource of [actor.toUpperCase(), 'eF000000-0000-0000-0000-000000000003']) {
  test(`createSale : source historique ${storedSource}, aucun second ticket ni encaissement`, async () => {
    const f = fixture();
    const old = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: 'synthetic', sourceId: storedSource,
      status: 'PAID', paidAt: now, comptaSyncedAt: now, stockSyncedAt: now,
      totalXpf: 1000n, lines: [thousandLine()], payments: [{ method: 'CASH', amountXpf: 1000n }] } });
    await f.tx.sale.create({ data: { tenantId: tenantB, sourceType: 'synthetic', sourceId: actor, totalXpf: 9000n } });
    const create = caisseFunction('createSale', { withTenant: f.withTenant, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed });
    const native = financialPorts(f, { syncLoadedSale: async () => { assert.fail('aucun nouvel encaissement à synchroniser'); } });
    const sources = storedSource === actor.toUpperCase() ? [storedSource, actor] : [storedSource];
    for (const sourceId of sources) {
      const result = await create(tenant, { sourceType: 'synthetic', sourceId, lines: [{ ...thousandLine(), unitXpf: 1000n }] });
      assert.equal(result.alreadyExisted, true); assert.equal(result.saleId, old.id);
      const paid = await native.checkoutSale(tenant, result.saleId, [{ method: 'CASH', amountXpf: 1000n }]);
      assert.equal(paid.ok, true); assert.equal(paid.alreadyPaid, true);
    }
    assert.equal(f.rows('sale').length, 2); assert.equal(f.rows('sale')[0].sourceId, storedSource);
    assert.equal(f.rows('sale')[0].payments.length, 1); assert.equal(f.rows('cashDay').length, 0);
  });
}

test('createSale : ABC et abc distincts, nouvelle source UUID normalisée', async () => {
  const f = fixture();
  const create = caisseFunction('createSale', { withTenant: f.withTenant, assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed });
  for (const sourceId of ['ABC', 'abc', actor.toUpperCase(), actor]) {
    const result = await create(tenant, { sourceType: 'synthetic', sourceId, lines: [{ ...thousandLine(), unitXpf: 1000n }] });
    assert.equal(result.alreadyExisted, sourceId === actor);
  }
  assert.deepEqual(f.rows('sale').map(s => s.sourceId), ['ABC', 'abc', actor]);
});

test('importerCloture : source historique majuscule, rejeux et nouveau Z normalisé', async () => {
  const f = fixture();
  const old = await f.tx.cashSession.create({ data: { tenantId: tenant, sourceType: 'synthetic', sourceId: actor.toUpperCase(),
    status: 'CLOSED', varianceXpf: 42n } });
  await f.tx.cashSession.create({ data: { tenantId: tenantB, sourceType: 'synthetic', sourceId: actor, varianceXpf: 99n } });
  const importer = caisseFunction('importerCloture', { ...importsPolicy, withTenant: f.withTenant,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed });
  const b = { sourceType: 'synthetic', openedBy: actor, openedAt: now.toISOString(), closedAt: now.toISOString(),
    openingFloatXpf: 25000, closingCountedXpf: 25000, expectedXpf: 25000 };
  for (const sourceId of [actor.toUpperCase(), actor]) {
    const result = await importer(tenant, { ...b, sourceId });
    assert.equal(result.alreadyExisted, true); assert.equal(result.sessionId, old.id); assert.equal(result.varianceXpf, 42);
  }
  assert.equal(f.rows('cashSession').length, 2); assert.equal(f.rows('cashSession')[0].sourceId, actor.toUpperCase());
  for (const sourceId of ['ABC', 'abc', ` ${tenant.toUpperCase()} `]) {
    assert.equal((await importer(tenant, { ...b, sourceId })).alreadyExisted, false);
  }
  assert.deepEqual(f.rows('cashSession').slice(2).map(s => s.sourceId), ['ABC', 'abc', tenant]);
});

for (const path of ['attachLegacy', 'createDaySale']) {
  for (const storedSource of [actor.toUpperCase(), 'eF000000-0000-0000-0000-000000000003']) {
    test(`${path} : origine historique ${storedSource} conservée après envelope et normalisations successives`, async () => {
      const f = fixture(true);
      const old = await f.tx.sale.create({ data: { tenantId: tenant, sourceType: 'synthetic', sourceId: storedSource,
        status: 'PAID', paidAt: now, totalXpf: 1000n, lines: [{ ...thousandLine(), productId: null }], payments: [{ method: 'CASH', amountXpf: 1000n }] } });
      await f.tx.sale.create({ data: { tenantId: tenantB, sourceType: 'synthetic', sourceId: actor, totalXpf: 9000n } });
      await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
      const day = f.rows('cashDay')[0];
      const sources = storedSource === actor.toUpperCase() ? [storedSource, actor] : [storedSource, storedSource];
      for (const [i, sourceId] of sources.entries()) {
        const raw = input({ actionId: `historical-${path}-${i}`, cycle: 0, sourceType: 'synthetic', sourceId,
          origins: [{ sourceType: 'synthetic', sourceId }], lines: [{ ...thousandLine(), unitXpf: '1000', lineXpf: '1000' }] });
        const b = f.sync.normalizeActionInput(f.sync.envelope(raw, raw.actionId));
        const result = await f.sync.cashAction(path, b, (tx: Row) => path === 'attachLegacy'
          ? f.days.attachLegacy(tx, day.id, b) : f.sales.createDaySale(tx, day.id, b));
        assert.equal(result.status, 200, JSON.stringify(result));
        if (path === 'createDaySale') assert.equal(result.body.data.alreadyExisted, true);
      }
      assert.equal(f.rows('sale').length, 2); assert.equal(f.rows('sale')[0].id, old.id);
      assert.equal(f.rows('sale')[0].sourceId, storedSource); assert.equal(f.rows('sale')[0].cashDayId, day.id);
      assert.equal(f.rows('sale')[0].payments.length, 1);
      assert.equal(f.rows('cashDayEvent').filter(e => e.kind === 'SALE_PAID').length, 1);
      assert.equal(await expected(f, day.id), 26000n);
    });
  }
}

test('fidélité : visite historique majuscule, références non UUID distinctes et nouvelles écritures normalisées', async () => {
  const f = fixture();
  await f.tx.loyaltyProgram.create({ data: { tenantId: tenant, mode: 'VISITS', visitsPerReward: null, activatedAt: now } });
  await f.tx.loyaltyEntry.create({ data: { tenantId: tenant, kind: 'VISIT', ref: `visit:rdv:${actor.toUpperCase()}`, sourceId: actor.toUpperCase() } });
  await f.tx.loyaltyEntry.create({ data: { tenantId: tenantB, kind: 'VISIT', ref: `visit:rdv:${tenant}` } });
  f.tx.loyaltyAccount.upsert = async ({ create }: Row) => f.tx.loyaltyAccount.findFirst({ where: { tenantId: create.tenantId, clientFicheId: create.clientFicheId } })
    .then((old: Row) => old ?? f.tx.loyaltyAccount.create({ data: create }));
  const db = load('loyalty-db.ts', { './loyalty.ts': loyalty, './log.ts': { log: { warn() {} } } });
  const visit = caisseFunction('creditLoyaltyVisit', { withTenant: f.withTenant, lockLoyaltyAccount: db.lockAccount, creditVisitDb: db.creditVisit });
  const b = { clientFicheId: tenant, displayName: 'Synthétique', occurredAt: now };
  for (const appointmentId of [actor.toUpperCase(), actor]) assert.equal((await visit(tenant, { ...b, appointmentId })).credited, false);
  assert.equal(f.rows('loyaltyEntry').length, 2);
  for (const appointmentId of ['ABC', 'abc', tenant.toUpperCase()]) assert.equal((await visit(tenant, { ...b, appointmentId })).credited, true);
  assert.equal((await visit(tenant, { ...b, appointmentId: tenant })).credited, false);
  assert.deepEqual(f.rows('loyaltyEntry').slice(2).map(e => e.ref), ['visit:rdv:ABC', 'visit:rdv:abc', `visit:rdv:${tenant}`]);
  assert.equal(f.rows('loyaltyEntry')[0].sourceId, actor.toUpperCase());
});

test('normalisation recursive : UUID sous toute cle et dans les tableaux, autres valeurs exactes', () => {
  const f = fixture();
  const value = { sellerId: actor.toUpperCase(), pickupOrderId: tenantB.toUpperCase(),
    inconnu: [{ profond: [actor.toUpperCase(), { encore: tenantB.toUpperCase() }] }],
    ref: 'ABC', sourceRef: 'prefix:' + actor.toUpperCase(), nom: 'Nom Mixte', ticket: 'TICKET-ABC', date: now, montant: 1000n };
  const normalized = f.sync.normalizeActionInput(value);
  assert.equal(normalized.sellerId, actor); assert.equal(normalized.pickupOrderId, tenantB);
  assert.equal(normalized.inconnu[0].profond[0], actor);
  assert.equal(normalized.inconnu[0].profond[1].encore, tenantB);
  for (const key of ['ref', 'sourceRef', 'nom', 'ticket', 'date', 'montant']) assert.equal(normalized[key], value[key as keyof typeof value]);
  assert.equal(value.sellerId, actor.toUpperCase(), 'entree non mutee');
});

test('recherches historiques : variantes exactes bornees, cle libre preservee et casse mixte acceptee en rejeu identique', async () => {
  const f = fixture(), mixed = 'aB000000-0000-0000-0000-000000000001';
  for (const received of [mixed, tenant, tenant.toUpperCase(), 'ABC', 'abc']) {
    const seen: string[] = [];
    await f.sync.findHistoricalKey(received, async (key: string) => { seen.push(key); return null; });
    assert.deepEqual(seen, received === 'ABC' || received === 'abc' ? [received] : [...new Set([received, received.toLowerCase(), received.toUpperCase()])]);
    assert.ok(seen.length <= 3);
  }
  const found = await f.sync.findHistoricalKey(mixed, async (key: string) => key === mixed ? { key } : null);
  assert.equal(found.key, mixed);
  assert.equal(await f.sync.findHistoricalKey(tenant, async (key: string) => key === mixed ? { key } : null), null);
});

test('vente rejouee : sellerId, pickupOrderId et UUID imbriques en majuscules restent idempotents', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows('cashDay')[0];
  const order = await f.tx.pickupOrder.create({ data: { tenantId: tenant, totalXpf: 1000n, claimedByDevice: 'A' } });
  const b = input({ actionId: actor, sourceType: 'synthetic', sourceId: 'SALE-ABC', ticketNumber: 'TICKET-ABC',
    sellerId: actor, sellerName: 'Nom Mixte', pickupOrderId: order.id, lines: [{ ...thousandLine(), unitXpf: '1000', lineXpf: '1000' }],
    autre: [{ nouveauChamp: [actor, { libre: 'ABC', uuidSansNomConnu: tenantB }] }] });
  const run = (body: Row) => f.sync.cashAction('cash-days:' + day.id + ':sales', body as any,
    (tx: Row) => f.sales.createDaySale(tx, day.id, f.sync.normalizeActionInput(body)));
  const first = await run(b); assert.equal(first.status, 200);
  sameResponse(await run({ ...b, sellerId: actor.toUpperCase(), pickupOrderId: order.id.toUpperCase(),
    autre: [{ nouveauChamp: [actor.toUpperCase(), { libre: 'ABC', uuidSansNomConnu: tenantB.toUpperCase() }] }] }), first);
  assert.equal(f.rows('sale').length, 1);
  assert.equal((await run({ ...b, sellerName: 'nom mixte' })).status, 409);
  assert.equal((await run({ ...b, autre: [{ nouveauChamp: [actor, { libre: 'abc', uuidSansNomConnu: tenantB }] }] })).status, 409);
});

test('retraits ABC 500 et abc 700 : deux mouvements et faits distincts, T 23800', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows('cashDay')[0];
  const record = caisseFunction('recordCashMovement', { withTenant: f.withTenant, ...f.ledger,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed });
  for (const [ref, amountXpf] of [['ABC', 500n], ['abc', 700n]] as const) {
    const b = { ref, amountXpf, kind: 'CASH_OUT', reason: 'Retrait synthetique' };
    assert.equal((await record(tenant, b)).alreadyExisted, false);
    assert.equal((await record(tenant, b)).alreadyExisted, true);
  }
  assert.deepEqual(f.rows('cashMovement').map(m => m.ref), ['ABC', 'abc']);
  assert.equal(f.rows('cashDayEvent').filter(e => e.kind === 'MOVEMENT').length, 2);
  assert.equal(await expected(f, day.id), 23800n);
});

test('journal : sourceRef non UUID et UUID incorpore restent exacts', async () => {
  const f = fixture(); await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows('cashDay')[0];
  for (const sourceRef of ['ABC', 'abc', 'prefix:' + actor, 'prefix:' + actor.toUpperCase()]) {
    await f.ledger.appendDayFact(f.tx, tenant, day.id, { kind: 'MOVEMENT', sourceRef, deviceId: 'A', occurredAt: now,
      snapshot: { kind: 'CASH_OUT', amountXpf: '100' } });
  }
  assert.equal(f.rows('cashDayEvent').filter(e => e.kind === 'MOVEMENT').length, 3);
});

test('correction PENDING avant 5d9e72c : cle Compta ancienne conservee, nouveau format par action', async () => {
  const f = fixture();
  const session = await f.tx.cashSession.create({ data: { tenantId: tenant, openingFloatXpf: 25000n } });
  const sale = await f.tx.sale.create({ data: { tenantId: tenant, sessionId: session.id, status: 'PAID', paidAt: now,
    createdAt: now, invoiceId: 'synthetic-invoice', comptaSyncedAt: now, totalXpf: 1000n, lines: [thousandLine()],
    sourceType: 'synthetic', sourceId: 'old-correction', payments: [{ method: 'CASH', amountXpf: 1000n, settleRef: 'initial' }] } });
  const request = { saleId: sale.id, fromMethod: 'CASH', toMethod: 'CARD', amountXpf: 1000 };
  const oldKey = corrections.correctionKeyPour(sale.id, 'CASH', 'CARD', 1000, 0);
  const refs = corrections.refsDeLaCorrection(oldKey);
  const hash = projection.canonical(request);
  const reservation = await f.tx.caisseSyncAction.create({ data: { tenantId: tenant, actionId: 'legacy-correction:' + oldKey,
    deviceId: 'legacy', kind: 'legacy-payment-correction', entityKey: sale.id, requestHash: hash, state: 'PENDING',
    payload: { snapshot: { ...sale, payments: sale.payments.map((p: Row) => ({ ...p, amountXpf: String(p.amountXpf) })) },
      validatedAt: now.toISOString(), ...refs } } });
  const calls: string[] = [], emitted = new Set<string>([oldKey]);
  const net = new Map([['CASH', 0], ['CARD', 1000]]);
  const correct = caisseFunction('corrigerMoyenPaiement', { withTenant: f.withTenant, ...f.ledger, ...f.locks,
    normalizeComposedUuidReference: f.sync.normalizeComposedUuidReference, findHistoricalComposedReference: f.sync.findHistoricalComposedReference,
    assertLegacyWriteAllowed: f.guard.assertLegacyWriteAllowed,
    comptaClient: () => ({ paymentCorrection: async (args: Row) => {
      calls.push(args.correctionKey);
      if (!emitted.has(args.correctionKey)) {
        emitted.add(args.correctionKey); net.set(args.fromMethod, net.get(args.fromMethod)! - args.amountXpf);
        net.set(args.toMethod, net.get(args.toMethod)! + args.amountXpf);
      }
      return { ok: true };
    } }) });
  assert.equal((await correct(tenant, request)).ok, true);
  assert.deepEqual(calls, [oldKey]); assert.equal(emitted.size, 1);
  assert.equal((await correct(tenant, request)).ok, true); assert.equal(calls.length, 1);
  const saved = f.rows('caisseSyncAction').find(a => a.id === reservation.id)!;
  assert.equal(saved.requestHash, hash); sameResponse(saved.payload, reservation.payload);
  assert.equal(f.rows('sale')[0].payments[1].settleRef, refs.sortie);
  assert.equal(f.rows('sale')[0].payments[2].settleRef, refs.entree);
  const back = await correct(tenant, { ...request, actionId: actor, fromMethod: 'CARD', toMethod: 'CASH' });
  assert.equal(back.ok, true);
  const forward = await correct(tenant, { ...request, actionId: tenantB }); assert.equal(forward.ok, true);
  assert.equal(calls.length, 3); assert.equal(emitted.size, 3);
  assert.equal(calls[1], 'corr:caisse:' + sale.id + ':action:' + actor);
  assert.equal(calls[2], 'corr:caisse:' + sale.id + ':action:' + tenantB);
  for (const p of forward.payments) assert.equal(p.amountXpf, net.get(p.method));
  await f.withTenant(tenant, (tx: Row) => f.days.openCashDay(tx, input()));
  const day = f.rows('cashDay')[0];
  await f.withTenant(tenant, (tx: Row) => f.days.attachLegacy(tx, day.id, input({ cycle: 0, sessionIds: [session.id],
    origins: [{ sourceType: 'synthetic', sourceId: 'old-correction' }] })));
  assert.equal(await expected(f, day.id), 25000n);
});
