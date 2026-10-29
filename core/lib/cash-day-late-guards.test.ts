import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import * as projection from "./cash-day-projection.ts";
import * as sync from "./caisse-sync.ts";
import * as policy from "./cash-shared-policy.ts";
import * as refunds from "./partial-refund.ts";
import { syncBlocksVoid } from "./sync.ts";

type Row = Record<string, any>;
const tenantId = "ab000000-0000-0000-0000-000000000001";
const dayId = "ab000000-0000-0000-0000-000000000002";
const sessionId = "ab000000-0000-0000-0000-000000000003";
const saleId = "ab000000-0000-0000-0000-000000000004";
const actionId = "ab000000-0000-0000-0000-000000000005";
const now = new Date("2026-10-15T01:00:00.000Z");
function load(file: string, names: string[], ports: Row, single = false) {
  let source = readFileSync(new URL(file, import.meta.url), "utf8");
  if (single) {
    const start = source.indexOf(`export async function ${names[0]}(`);
    const end = source.indexOf("\nexport ", start + 10);
    assert.ok(start >= 0);
    source = source.slice(start, end < 0 ? undefined : end);
  }
  const js = stripTypeScriptTypes(source).replace(/^import .*from .*;\r?$/gm, "").replace(/^export /gm, "");
  return vm.runInNewContext(`(function(){${js}\nreturn {${names.join(",")}};})()`, {
    Date, Error, URLSearchParams, ...projection, ...sync, ...policy, ...refunds, syncBlocksVoid, ...ports,
  });
}
const { createDaySale } = load("cash-day-sales.ts", ["createDaySale"], {
  lockDay: async (tx: Row) => tx.cashDay.findFirstOrThrow(), lockSaleRow: async () => true,
});
function salePorts(status: string) {
  const day = { id: dayId, tenantId, businessDay: "2026-10-15", canonicalSessionId: sessionId,
    currentSessionId: sessionId, currentSession: { status } };
  const sales: Row[] = [];
  const tx: Row = { $queryRaw: async () => [{ id: dayId }], cashDay: { findFirstOrThrow: async () => day },
    cashDaySession: { findUnique: async () => null }, sale: {
      findFirst: async ({ where }: Row) => sales.find(s => s.sourceType === where.sourceType && s.sourceId === where.sourceId) ?? null,
      findFirstOrThrow: async ({ where }: Row) => sales.find(s => s.id === where.id),
      create: async ({ data }: Row) => { const row = { id: saleId, ...data }; sales.push(row); return row; },
    }, pickupOrder: { findFirst: async () => null } };
  return { tx, day, all: sales };
}
const saleBody = { tenantId, actionId, entityKey: dayId, deviceId: "device", deviceName: "Recette", ticketNumber: "synthetic-1", occurredAt: now.toISOString(),
  sourceType: "synthetic", sourceId: "source", lines: [{ kind: "OTHER", label: "Test", qty: 1, unitXpf: "100", lineXpf: "100" }] };

test("cashDayGuard : marqueur TO_CLOSE conservé après extinction ; autres commerces isolés", async () => {
  for (const enabled of [false, true]) for (const status of ["OPEN", "TO_CLOSE", "CLOSED"]) for (const hasToClose of [false, true]) {
    const tx = { cashSettings: { findUnique: async () => ({ toCloseEnabled: enabled }) }, cashDay: {
      findFirst: async ({ where }: Row) => where.id && where.id !== dayId || where.currentSession && where.currentSession.status !== status ? null : { id: dayId },
    }, cashDayEvent: { findFirst: async () => hasToClose ? { id: actionId } : null } };
    const { cashDayGuard } = load("cash-day-guard.ts", ["cashDayGuard"], { withTenant: async (_tenant: string, fn: Function) => fn(tx) });
    assert.equal(await cashDayGuard(tenantId, { saleId, refundCashDayId: dayId }), !(enabled || status === "OPEN" || status === "TO_CLOSE" || hasToClose));
    assert.equal(await cashDayGuard(tenantId, { saleId, refundCashDayId: actionId }), true);
  }
});

test("createDaySale accepte OPEN/TO_CLOSE, et CLOSED seulement hors ligne ou import", async () => {
  for (const status of ["OPEN", "TO_CLOSE"] as const) {
    const f = salePorts(status);
    const result = await createDaySale(f.tx, dayId, saleBody as any);
    assert.equal(result.alreadyExisted, false);
  }
  const closed = salePorts("CLOSED");
  await assert.rejects(createDaySale(closed.tx, dayId, saleBody as any), (e: Row) => e.message === "DAY_CLOSED");
  assert.equal((await createDaySale(closed.tx, dayId, { ...saleBody, offlineCompleted: true } as any)).alreadyExisted, false);
});

function refundFixture(enabled = true, initial = "TO_CLOSE", seeded = true, hasToClose = initial === "TO_CLOSE") {
  const day = { id: dayId, businessDay: "2026-10-15", currentSession: { status: initial } };
  const line = { id: tenantId, label: "Recette", qty: 1, unitXpf: 100n, lineXpf: 100n, tgcRatePpm: 0 };
  const sale = { id: saleId, tenantId, cashDayId: dayId, status: "PAID", invoiceId: "synthetic-invoice", totalXpf: 100n,
    sessionId, posteId: null, lines: [line], comptaSyncedAt: now, stockSyncedAt: now, payments: [] };
  const input = { actionId, reason: "Recette", lines: [{ lineId: tenantId, qty: 1 }], refundMethod: "CASH", cashDrawer: "EXTERNAL",
    cashDayId: dayId, drawerBusinessDay: day.businessDay, deviceId: "synthetic", occurredAt: now.toISOString() };
  const plan = { invoiceId: sale.invoiceId, amountXpf: 100, fullyRefunded: true,
    lines: [{ lineId: tenantId, qty: 1, ttcXpf: 100, tgcRatePpm: 0 }], parTaux: [{ tgcRatePpm: 0, ttcXpf: 100, htXpf: 100, tgcXpf: 0 }] };
  let reserved: Row | null = seeded ? { id: actionId, actionId, cashDayId: dayId, saleId, status: "PENDING", input, plan } : null;
  const trace: string[] = [], facts: Row[] = [];
  let calls = 0, badAck = false;
  const tx: Row = {
    cashSettings: { findUnique: async () => ({ toCloseEnabled: enabled }) },
    sale: { findFirst: async () => sale, update: async ({ data }: Row) => Object.assign(sale, data) },
    cashDay: { findFirst: async () => ({ id: dayId }) },
    partialRefund: {
      findFirst: async () => reserved, findUnique: async ({ where }: Row) => where.tenantId_actionId.actionId === reserved?.actionId ? reserved : null,
      findUniqueOrThrow: async () => { assert.ok(reserved); return reserved; }, findMany: async () => reserved ? [reserved] : [],
      create: async ({ data }: Row) => (reserved = { id: actionId, status: "PENDING", ...data }),
      update: async ({ data }: Row) => { assert.ok(reserved); Object.assign(reserved, data); return reserved; },
    },
    cashDayEvent: { findFirst: async () => hasToClose ? { id: actionId } : null },
  };
  const db = load("partial-refund-db.ts", ["partialRefundWithPorts"], {});
  const { rembourserPartiellement } = load("caisse.ts", ["rembourserPartiellement"], {
    ...db, withTenant: async (_tenant: string, fn: Function) => fn(tx),
    lockCashTenant: async () => { trace.push("tenant"); }, lockVoidResource: async () => { trace.push("action"); },
    lockDay: async () => { trace.push("day"); return day; },
    lockSharedSale: async () => { trace.push("shared-sale"); return sale; },
    lockSaleRow: async () => { trace.push("sale-row"); return true; },
    ackFinancial: async (_tx: Row, _tenant: string, _action: string, _data: Row, validateOnly: boolean) => {
      trace.push(validateOnly ? "ack-check" : "ack"); if (badAck) throw new projection.CashContractError("ACTION_ID_CONFLICT", 409);
    },
    appendDayFact: async (_tx: Row, _tenant: string, _day: string, fact: Row) => { facts.push(fact); },
    comptaClient: () => ({
      invoiceDetail: async () => ({ id: sale.invoiceId, sourceType: "caisse", sourceId: saleId, totalXpf: 100, paidXpf: 100,
        tgcRatePpm: 0, lines: [{ ...line, unitXpf: 100 }] }),
      creditNote: async () => { calls++; day.currentSession.status = "CLOSED"; return { creditNoteId: "synthetic-credit", totalXpf: -100 }; },
    }),
  }, true);
  return { day, trace, facts, input, reserved: () => reserved, calls: () => calls, badAck: () => { badAck = true; },
    refund: (overrides = {}) => rembourserPartiellement(tenantId, saleId, { ...input, ...overrides }) };
}

test("réservation PENDING après clôture : verrou vente et ACK, DONE rejoué sans deuxième remboursement", async () => {
  const f = refundFixture(true, "CLOSED");
  const result = await f.refund();
  assert.equal(result.ok, true); assert.equal(f.reserved()!.status, "DONE");
  assert.equal(f.facts.length, 1); assert.equal(f.calls(), 1);
  assert.ok(f.trace.indexOf("day") < f.trace.indexOf("sale-row"));
  assert.ok(f.trace.includes("ack-check")); assert.ok(f.trace.includes("ack"));
  assert.deepEqual(await f.refund(), result); assert.equal(f.calls(), 1); assert.equal(f.facts.length, 1);
  const collision = refundFixture(true, "CLOSED"); collision.badAck();
  await assert.rejects(collision.refund(), /ACTION_ID_CONFLICT/);
  assert.equal(collision.calls(), 0); assert.equal(collision.facts.length, 0);
});

test("remboursement TO_CLOSE toléré flag éteint ; CLOSED refuse les nouveaux et reprend une réservation marquée", async () => {
  for (const enabled of [false, true]) {
    const late = refundFixture(enabled, "TO_CLOSE", false);
    assert.equal((await late.refund()).ok, true); assert.equal(late.facts.length, 1);
  }
  for (const enabled of [false, true]) {
    const closed = refundFixture(enabled, "CLOSED", false);
    await assert.rejects(closed.refund(), /CASHDAY_ROUTE_REQUIRED/); assert.equal(closed.reserved(), null);
  }
  const resumed = refundFixture(false, "CLOSED", true, true);
  assert.equal((await resumed.refund()).ok, true); assert.equal(resumed.reserved()!.status, "DONE");
  assert.equal(resumed.calls(), 1);
  const offNoMarker = refundFixture(false, "CLOSED");
  await assert.rejects(offNoMarker.refund(), /REFUND_DAY_CLOSED_REOPEN_REQUIRED/); assert.equal(offNoMarker.calls(), 0);
  const wrong = refundFixture(false, "CLOSED", true, true); wrong.reserved()!.cashDayId = saleId;
  await assert.rejects(wrong.refund(), /CASHDAY_ROUTE_REQUIRED/); assert.equal(wrong.calls(), 0);
});

test("lecture et remplacement historiques restent identiques en présence d'un CashDay fermé", async () => {
  const native = { id: sessionId, tenantId, status: "OPEN", posteId: null };
  for (const enabled of [false, true]) {
    const tx = { cashSettings: { findUnique: async () => ({ toCloseEnabled: enabled }) }, cashDay: {
      findFirst: async ({ where }: Row) => where.currentSession ? null : { id: dayId },
    }, cashSession: { findFirst: async ({ where }: Row) => where.id === saleId ? { status: "CLOSED", posteId: null } : native } };
    const ports = { withTenant: async (_tenant: string, fn: Function) => fn(tx) };
    const { currentSession } = load("caisse.ts", ["currentSession"], ports, true);
    const { openSaleSession } = load("caisse.ts", ["openSaleSession"], ports, true);
    assert.equal(await currentSession(tenantId), native);
    assert.equal(await openSaleSession(tx, tenantId, saleId), sessionId);
  }
});

test("espèces : OPEN du jour serveur ; TO_CLOSE et ancienne OPEN exclus, éteint conserve l'ancienne sélection", async () => {
  class Clock extends Date { constructor(value?: string | number) { super(value ?? now.getTime()); } static now() { return now.getTime(); } }
  for (const [enabled, status, businessDay, accepted] of [
    [true, "OPEN", "2026-10-15", true], [true, "TO_CLOSE", "2026-10-15", false],
    [true, "OPEN", "2026-10-14", false], [false, "OPEN", "2026-10-14", true],
  ] as const) {
    const day = { id: dayId, businessDay, currentSessionId: sessionId, currentSession: { status } };
    const tx: Row = { cashSettings: { findUnique: async () => ({ toCloseEnabled: enabled }) },
      cashDay: { findFirst: async ({ where, orderBy }: Row) => {
        if (!where.currentSession) return day;
        if (enabled) assert.equal(orderBy.businessDay, "desc");
        return status === "OPEN" && (!where.businessDay || where.businessDay === businessDay) ? day : null;
      } }, cashSession: { findFirst: async () => ({ id: sessionId, status }) },
      cashMovement: { create: async ({ data }: Row) => ({ id: actionId, createdAt: now, ...data }) } };
    const { recordCashMovement } = load("caisse.ts", ["recordCashMovement"], {
      Date: Clock, withTenant: async (_tenant: string, fn: Function) => fn(tx), lockCashTenant: async () => {},
      lockDay: async () => day, appendDayFact: async () => {},
    }, true);
    const result = await recordCashMovement(tenantId, { kind: "CASH_IN", amountXpf: 100n, reason: "Recette" });
    assert.equal(result.ok, accepted);
    if (accepted) assert.equal(result.movement.sessionId, sessionId);
    else assert.equal(result.error, "NO_OPEN_SESSION");
  }
});
