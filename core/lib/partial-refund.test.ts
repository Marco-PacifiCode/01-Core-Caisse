import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { planPartialRefund, refundFingerprint, validRefundInput, type RefundInput, type RefundPlan, type RefundSale } from "./partial-refund.ts";
import { partialRefundWithPorts } from "./partial-refund-db.ts";
import { runVoidSale } from "./void-sale.ts";
import { expectedCashXpf } from "./cash-movement.ts";
import type { ComptaClient, CreditNoteInput, InvoiceDetail } from "./clients.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const FOREIGN = "00000000-0000-4000-8000-000000000002";
const SALE = "00000000-0000-4000-8000-000000000003";
const LINE = "00000000-0000-4000-8000-000000000004";
const SECOND = "00000000-0000-4000-8000-000000000005";
const A = "00000000-0000-4000-8000-000000000006";
const B = "00000000-0000-4000-8000-000000000007";
const input = (overrides: Partial<RefundInput> = {}): RefundInput => ({ actionId: A, reason: "Retour", lines: [{ lineId: LINE, qty: 1 }], refundMethod: "CARD", ...overrides });
const sale = (): RefundSale => ({ id: SALE, status: "PAID", invoiceId: "invoice", totalXpf: 303n,
  lines: [{ id: LINE, label: "Article test", qty: 3, unitXpf: 101n, lineXpf: 303n, tgcRatePpm: 50_000 }] });
const invoiceFor = (s: RefundSale): InvoiceDetail => ({ id: "invoice", sourceType: "caisse", sourceId: s.id,
  totalXpf: Number(s.totalXpf), paidXpf: Number(s.totalXpf), tgcRatePpm: 50_000,
  lines: s.lines.map(l => ({ ...l, id: `invoice-${l.id}`, unitXpf: Number(l.unitXpf) })) });

// Adaptateur réel, transactions sérialisées et tenant filtré; aucun Prisma/Next runtime.
function fixture(original = sale()) {
  let state = { sale: { ...original, tenantId: TENANT, posteId: null, fullyRefundedAt: null as Date | null },
    refunds: [] as any[], movements: [] as any[], sessions: [{ id: "session", tenantId: TENANT, posteId: null, status: "OPEN" }] };
  let active = 0, tail = Promise.resolve();
  const transactionContext = new AsyncLocalStorage<boolean>();
  const emitted = new Map<string, any>(), calls: CreditNoteInput[] = [];
  let fail = false, afterCredit: (() => void) | undefined, failCommit = false;
  const matches = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
  const refundFor = (where: any) => state.refunds.find(r => matches(r, where.tenantId_actionId ?? where)) ?? null;
  const tx = {
    sale: { findFirst: async ({ where }: any) => matches(state.sale, where) ? structuredClone(state.sale) : null,
      update: async ({ data }: any) => Object.assign(state.sale, data) },
    partialRefund: {
      findUnique: async ({ where }: any) => refundFor(where),
      findUniqueOrThrow: async ({ where }: any) => { const r = refundFor(where); assert.ok(r); return r; },
      findMany: async ({ where }: any) => state.refunds.filter(r => matches(r, where)),
      create: async ({ data }: any) => { const r = { id: `refund-${state.refunds.length}`, status: "PENDING", ...structuredClone(data) }; state.refunds.push(r); return r; },
      update: async ({ where, data }: any) => { const r = refundFor(where); assert.ok(r); Object.assign(r, structuredClone(data)); return r; },
    },
    cashSession: {
      findFirst: async ({ where }: any) => state.sessions.find(r => matches(r, where)) ?? null,
      updateMany: async ({ where, data }: any) => { const r = state.sessions.find(r => matches(r, where)); if (r) Object.assign(r, data); return { count: r ? 1 : 0 }; },
    },
    cashMovement: {
      findFirst: async ({ where }: any) => state.movements.find(r => matches(r, where)) ?? null,
      create: async ({ data }: any) => { state.movements.push({ id: "movement", ...data }); return data; },
    },
  };
  async function transact<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    const before = structuredClone(state);
    active++;
    try {
      assert.equal(active, 1);
      const r = await transactionContext.run(true, () => fn(tx));
      if (failCommit && state.refunds.some(r => r.status === "DONE")) { failCommit = false; throw new Error("commit échoué"); }
      return r;
    } catch (err) { state = before; throw err; }
    finally { active--; unlock(); }
  }
  const compta: ComptaClient = {
    async invoiceDetail() { assert.notEqual(transactionContext.getStore(), true); return invoiceFor(state.sale); },
    async creditNote(value) {
      assert.notEqual(transactionContext.getStore(), true, "aucune transaction pendant Compta"); calls.push(value);
      if (fail) throw new Error("Compta indisponible");
      const key = value.creditKey!;
      let r = emitted.get(key);
      if (!r) {
        const inv = invoiceFor(state.sale);
        const amount = value.amountXpf ?? inv.lines.filter(l => value.lineIds?.includes(l.id)).reduce((s, l) => s + l.qty * l.unitXpf, 0);
        r = { creditNoteId: `cn-${emitted.size}`, totalXpf: -amount, number: "AVO-TEST", alreadyExisted: false, origin: { id: "invoice", number: "TEST" } };
        emitted.set(key, r);
      }
      afterCredit?.();
      return r;
    },
    async createInvoice() { throw new Error("hors périmètre"); }, async settle() { throw new Error("hors périmètre"); },
    async paymentCorrection() { throw new Error("hors périmètre"); }, receiptUrl() { return ""; },
  };
  return { get state() { return state; }, emitted, calls, compta,
    failCompta(value: boolean) { fail = value; }, onCredit(value: () => void) { afterCredit = value; }, failNextCommit() { failCommit = true; },
    run(value = input(), tenantId = TENANT, saleId = SALE) {
      return partialRefundWithPorts(tenantId, saleId, value, { transact, compta,
        async lockAction() {}, async lockSale() { return state.sale.tenantId === tenantId && state.sale.id === saleId; } });
    },
  };
}

test("une quantité partielle, montants Core et ventilation HT + TGC = TTC", async () => {
  const f = fixture(); const r = await f.run(); assert.ok(r.ok);
  assert.equal(r.plan.amountXpf, 101); assert.equal(r.plan.lines[0].qty, 1);
  assert.equal(r.plan.parTaux[0].htXpf + r.plan.parTaux[0].tgcXpf, 101);
  assert.equal(f.calls[0].amountXpf, 101); assert.equal(f.calls[0].creditKey, `caisse:${SALE}:${A}`);
  assert.equal(f.state.movements.length, 0);
});
test("deux avoirs avec remise jusqu'au solde exact et marque entièrement remboursée", async () => {
  const s = sale(); s.lines.push({ id: SECOND, label: "Remise test", qty: 1, unitXpf: -1n, lineXpf: -1n, tgcRatePpm: 50_000 }); s.totalXpf = 302n;
  const f = fixture(s); const first = await f.run(); assert.ok(first.ok); assert.equal(first.plan.amountXpf, 100);
  const second = await f.run(input({ actionId: B, lines: [{ lineId: LINE, qty: 2 }] })); assert.ok(second.ok);
  assert.equal(second.plan.amountXpf, 202); assert.equal(first.plan.amountXpf + second.plan.amountXpf, 302);
  assert.equal(second.plan.fullyRefunded, true); assert.ok(f.state.sale.fullyRefundedAt); assert.equal(f.state.sale.status, "PAID");
});
test("dépassement de quantité refusé sans deuxième avoir", async () => {
  const f = fixture(); await f.run(); const r = await f.run(input({ actionId: B, lines: [{ lineId: LINE, qty: 3 }] }));
  assert.deepEqual(r, { ok: false, error: "EXCEEDS_SOLD_QTY", status: 409 }); assert.equal(f.emitted.size, 1);
});
test("rejeu actionId: réponse identique, aucun nouvel appel ni écriture", async () => {
  const f = fixture(); const first = await f.run(); assert.deepEqual(await f.run(), first);
  assert.equal(f.calls.length, 1); assert.equal(f.state.refunds.length, 1);
  const conflict = await f.run(input({ reason: "Autre raison" })); assert.ok(!conflict.ok); assert.equal(conflict.error, "ACTION_ID_CONFLICT");
});
test("CASH crée un REFUND idempotent et diminue l'attendu du Z", async () => {
  const f = fixture(); const value = input({ refundMethod: "CASH" }); const r = await f.run(value); assert.ok(r.ok);
  assert.deepEqual(await f.run(value), r); assert.equal(f.state.movements.length, 1);
  const m = f.state.movements[0]; assert.equal(m.kind, "REFUND"); assert.equal(m.ref, "avoir-partiel:" + A); assert.equal(m.amountXpf, 101n);
  assert.equal(expectedCashXpf({ openingFloatXpf: 1000n, cashSalesXpf: 303n, movements: f.state.movements }), 1202n);
});
for (const refundMethod of ["CARD", "TRANSFER", "OTHER"] as const) test(`${refundMethod}: pas de mouvement de tiroir`, async () => {
  const f = fixture(); assert.ok((await f.run(input({ refundMethod }))).ok); assert.equal(f.state.movements.length, 0);
});
test("CASH: session fermée refuse avant émission; CARD reste possible", async () => {
  const f = fixture(); f.state.sessions[0].status = "CLOSED";
  assert.deepEqual(await f.run(input({ refundMethod: "CASH" })), { ok: false, error: "NO_OPEN_SESSION", status: 409 });
  assert.equal(f.emitted.size, 0); assert.equal(f.state.refunds.length, 0); assert.ok((await f.run()).ok);
});
test("clôture pendant Compta: aucun REFUND, même action rejouable sur une session ouverte", async () => {
  const f = fixture(); f.onCredit(() => { f.state.sessions[0].status = "CLOSED"; }); const value = input({ refundMethod: "CASH" });
  const r = await f.run(value); assert.ok(!r.ok); assert.equal(r.error, "NO_OPEN_SESSION");
  assert.equal(f.state.movements.length, 0); assert.equal(f.state.refunds[0].status, "PENDING");
  f.onCredit(() => {}); f.state.sessions[0].status = "OPEN";
  assert.ok((await f.run(value)).ok); assert.equal(f.emitted.size, 1); assert.equal(f.state.movements.length, 1);
});
test("tenant étranger refuse sans lecture Compta ni réservation", async () => {
  const f = fixture(); assert.deepEqual(await f.run(input(), FOREIGN), { ok: false, error: "SALE_NOT_FOUND", status: 404 });
  assert.equal(f.calls.length, 0); assert.equal(f.state.refunds.length, 0);
});
test("échec Compta: seulement PENDING; même clé reprend; autre action bloquée", async () => {
  const f = fixture(); f.failCompta(true); assert.ok(!(await f.run()).ok);
  assert.equal(f.state.movements.length, 0); assert.equal(f.state.refunds[0].status, "PENDING");
  const blocked = await f.run(input({ actionId: B })); assert.ok(!blocked.ok); assert.equal(blocked.error, "REFUND_IN_PROGRESS");
  f.failCompta(false); assert.ok((await f.run()).ok); assert.equal(f.emitted.size, 1);
});
test("échec commit après avoir: transaction annulée, aucun REFUND doublé au rejeu", async () => {
  const f = fixture(); f.failNextCommit(); const value = input({ refundMethod: "CASH" });
  await assert.rejects(f.run(value), /commit échoué/); assert.equal(f.state.movements.length, 0);
  assert.equal(f.state.refunds[0].status, "PENDING"); assert.ok((await f.run(value)).ok);
  assert.equal(f.emitted.size, 1); assert.equal(f.state.movements.length, 1);
});
test("deux appels simultanés de même action convergent vers une seule écriture", async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.run(), f.run()]); assert.deepEqual(a, b);
  assert.equal(f.state.refunds.length, 1); assert.equal(f.emitted.size, 1);
});
test("lignes entières multi-taux: correspondance sûre, pas de montant", async () => {
  const s = sale(); s.lines.push({ id: SECOND, label: "Autre article", qty: 1, unitXpf: 100n, lineXpf: 100n, tgcRatePpm: 110_000 }); s.totalXpf = 403n;
  const f = fixture(s); const r = await f.run(input({ lines: [{ lineId: LINE, qty: 3 }] })); assert.ok(r.ok);
  assert.deepEqual(f.calls[0].lineIds, [`invoice-${LINE}`]); assert.equal(f.calls[0].amountXpf, undefined);
  const second = await f.run(input({ actionId: B, lines: [{ lineId: SECOND, qty: 1 }] })); assert.ok(second.ok); assert.ok(f.state.sale.fullyRefundedAt);
});
test("quantité partielle multi-taux: refus clair sans émission", async () => {
  const s = sale(); s.lines.push({ id: SECOND, label: "Autre article", qty: 1, unitXpf: 100n, lineXpf: 100n, tgcRatePpm: 110_000 }); s.totalXpf = 403n;
  const f = fixture(s); const r = await f.run(); assert.ok(!r.ok); assert.equal(r.error, "PARTIAL_QTY_MULTI_RATE"); assert.equal(f.emitted.size, 0);
});
test("correspondance ambiguë: montant au taux unique, refus multi-taux", () => {
  const s = sale(); s.lines.push({ ...s.lines[0], id: SECOND }); s.totalXpf = 606n;
  const inv = invoiceFor(s); const plan = planPartialRefund(s, inv, input({ lines: [{ lineId: LINE, qty: 3 }] }), []);
  assert.ok(!("ok" in plan)); assert.equal(plan.lineIds, undefined); assert.equal(plan.amountXpf, 303);
});
test("cumul TTC supérieur à la vente refuse", () => {
  const s = sale(); const prior = [{ amountXpf: 303, lines: [] }] as unknown as RefundPlan[];
  const r = planPartialRefund(s, invoiceFor(s), input(), prior); assert.ok("ok" in r); assert.equal(r.error, "EXCEEDS_SALE_TOTAL");
});
test("vente DRAFT/VOID et facture impayée refusées", async () => {
  for (const status of ["DRAFT", "VOID"]) { const s = sale(); s.status = status; const f = fixture(s); assert.ok(!(await f.run()).ok); assert.equal(f.emitted.size, 0); }
  const s = sale(); const inv = invoiceFor(s); inv.paidXpf = 0; const r = planPartialRefund(s, inv, input(), []);
  assert.ok("ok" in r); assert.equal(r.error, "INVOICE_NOT_PAID");
});
test("void après partiel refusé avant Compta; void réservé bloque un partiel", async () => {
  const f = fixture(); await f.run(); const r = await runVoidSale({ id: SALE, status: "PAID", invoiceId: "invoice", stockSyncedAt: null, lines: [], partialRefunds: f.state.refunds }, TENANT, f.compta, { async markVoid() { assert.fail("void interdit"); } });
  assert.ok(!r.ok); assert.equal(r.error, "PARTIAL_REFUND_EXISTS"); assert.equal(f.calls.length, 1);
  const s = sale(); s.voidPreparedAt = new Date(); const blocked = planPartialRefund(s, invoiceFor(s), input(), []);
  assert.ok("ok" in blocked); assert.equal(blocked.error, "VOID_IN_PROGRESS");
});
test("validation: quantités fractionnaires, doublons, moyens et UUID invalides refusés", () => {
  assert.ok(validRefundInput(input()));
  for (const bad of [input({ lines: [{ lineId: LINE, qty: 0 }] }), input({ lines: [{ lineId: LINE, qty: 1.5 }] }), input({ lines: [{ lineId: LINE, qty: 1 }, { lineId: LINE, qty: 1 }] }), input({ reason: " " }), { ...input(), refundMethod: "CHEQUE" }, { ...input(), actionId: "bad" }, null]) assert.equal(validRefundInput(bad), false);
});
test("CASH + tiroir EXTERNAL: sans session, avoir émis, aucun mouvement, rejeu idempotent", async () => {
  const f = fixture(); f.state.sessions[0].status = "CLOSED";
  const value = input({ refundMethod: "CASH", cashDrawer: "EXTERNAL" }); const r = await f.run(value); assert.ok(r.ok);
  assert.equal(r.cashDrawer, "EXTERNAL"); assert.equal(f.emitted.size, 1); assert.equal(f.state.movements.length, 0);
  assert.equal(f.state.refunds[0].sessionId ?? null, null); assert.equal(f.state.refunds[0].input.cashDrawer, "EXTERNAL");
  assert.deepEqual(await f.run(value), r); assert.equal(f.calls.length, 1); assert.equal(f.state.refunds.length, 1);
  const conflict = await f.run(input({ refundMethod: "CASH" })); assert.ok(!conflict.ok); assert.equal(conflict.error, "ACTION_ID_CONFLICT");
});
test("CASH sans cashDrawer et sans session: NO_OPEN_SESSION inchangé", async () => {
  const f = fixture(); f.state.sessions[0].status = "CLOSED";
  assert.deepEqual(await f.run(input({ refundMethod: "CASH" })), { ok: false, error: "NO_OPEN_SESSION", status: 409 });
});
test("validation cashDrawer: EXTERNAL seulement, et seulement avec CASH", () => {
  assert.ok(validRefundInput(input({ refundMethod: "CASH", cashDrawer: "EXTERNAL" })));
  for (const bad of [{ ...input(), refundMethod: "CARD", cashDrawer: "EXTERNAL" }, { ...input(), refundMethod: "CASH", cashDrawer: "CORE" }, { ...input(), refundMethod: "CASH", cashDrawer: null }]) assert.equal(validRefundInput(bad), false);
  assert.equal(refundFingerprint(input()).includes("cashDrawer"), false);
});
test("empreinte idempotente stable après réordonnancement des clés JSONB", () => {
  const original = input();
  const jsonb: RefundInput = { refundMethod: original.refundMethod, reason: original.reason,
    lines: [{ qty: 1, lineId: LINE }], actionId: original.actionId };
  assert.equal(refundFingerprint(original), refundFingerprint(jsonb));
});
test("contrat RLS, gardes sous verrou, migration additive et détail S2S", () => {
  const sql = readFileSync(new URL("../prisma/migrations/20261001140000_avoir_partiel/migration.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /drop|alter column|truncate|delete from/i);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/); assert.match(sql, /WITH CHECK.*current_setting/);
  assert.match(sql, /USING.*current_setting/); assert.match(sql, /one_pending_sale/);
  const caisse = readFileSync(new URL("./caisse.ts", import.meta.url), "utf8");
  assert.match(caisse, /transact: fn => withTenant\(safeTenantId, fn\)/);
  assert.match(caisse, /if \(!await lockSaleRow[\s\S]*?partialRefund.count/);
  assert.match(caisse, /FOR UPDATE[\s\S]*?const session = await tx.cashSession.findFirst/);
  const route = readFileSync(new URL("../app/api/sales/[id]/partial-refund/route.ts", import.meta.url), "utf8");
  assert.match(route, /hasServiceKey\(req\)/);
  const detail = readFileSync(new URL("../app/api/sales/[id]/route.ts", import.meta.url), "utf8");
  assert.match(detail, /partialRefunds: sale.partialRefunds.map/); assert.match(detail, /fullyRefundedAt: sale.fullyRefundedAt/);
});
