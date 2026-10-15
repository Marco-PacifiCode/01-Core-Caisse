import { test } from "node:test";
import assert from "node:assert/strict";
import { runSaleSync, retryNeutralization, NEUTRALISATION_MARKER, shouldWriteSyncError, type SyncGuard, type SyncPersist, type SyncSaleSnapshot } from "./sync.ts";
import { CoreClientError } from "./clients.ts";
import type { ComptaClient, StockClient } from "./clients.ts";

function fixture() {
  const photo: SyncSaleSnapshot = {
    id: "sale-test", tenantId: "tenant-test", sourceId: null, clientName: null, cashierId: null,
    status: "PAID", voidPreparedAt: null, creditNoteId: null, syncError: null,
    invoiceId: null, invoiceNumber: null, comptaSyncedAt: null, stockSyncedAt: null,
    lines: [{ id: "line-test", kind: "PRODUCT", label: "Produit test", productId: "product-test", qty: 1, unitXpf: 1000n }],
    payments: [{ id: "payment-test", method: "CASH", amountXpf: 1000n, settleRef: null }],
  };
  const db = { sale: structuredClone(photo) as SyncSaleSnapshot | null, syncAttempts: 0 };
  const calls = { createInvoice: 0, settle: 0, recordSale: 0, creditNote: 0, recordFailure: 0, clearError: 0 };
  const hooks: { create?: () => void; saved?: () => void; settle?: () => void; recordSale?: () => void; creditFailure?: CoreClientError } = {};
  const credits: string[] = [];
  const guard: SyncGuard = {
    async reread() { return db.sale ? structuredClone(db.sale) : null; },
    async saveInvoiceRefIfLive(invoiceId, invoiceNumber) {
      const s = db.sale;
      if (!s || s.status !== "PAID" || s.voidPreparedAt || (s.invoiceId && s.invoiceId !== invoiceId)) {
        return { saved: false, fresh: s ? structuredClone(s) : null };
      }
      s.invoiceId = invoiceId;
      s.invoiceNumber = invoiceNumber;
      hooks.saved?.();
      return { saved: true };
    },
    async attachOrphanInvoice(invoiceId, invoiceNumber) {
      const s = db.sale;
      if (!s || s.status !== "VOID" || s.invoiceId) return false;
      Object.assign(s, { invoiceId, invoiceNumber, syncError: NEUTRALISATION_MARKER });
      return true;
    },
    async attachNeutralization(invoiceId, creditNoteId) {
      if (db.sale?.status === "VOID" && db.sale.invoiceId === invoiceId) {
        Object.assign(db.sale, { creditNoteId, syncError: null });
      }
    },
  };
  const persist: SyncPersist = {
    async saveInvoiceRef() { assert.fail("Le chemin gardé doit écrire via le garde"); },
    async markComptaSynced() { db.sale!.comptaSyncedAt = new Date(); },
    async markStockSynced() { db.sale!.stockSyncedAt = new Date(); },
    async recordFailure(detail) {
      calls.recordFailure++;
      db.syncAttempts++;
      if (shouldWriteSyncError(db.sale!.syncError, detail)) db.sale!.syncError = detail;
    },
    async clearError() {
      calls.clearError++;
      if (shouldWriteSyncError(db.sale!.syncError, null)) db.sale!.syncError = null;
    },
  };
  const compta: ComptaClient = {
    async createInvoice() {
      calls.createInvoice++;
      hooks.create?.();
      return { invoiceId: "invoice-test", number: "FAC-TEST", totalXpf: 1000, alreadyExisted: false };
    },
    async settle() { calls.settle++; hooks.settle?.(); return { ok: true, invoiceId: "invoice-test", paid: 1000, remaining: 0 }; },
    async creditNote(input) {
      calls.creditNote++;
      credits.push(input.invoiceId);
      assert.equal(input.reason, "Vente annulée pendant la synchro : facture neutralisée");
      if (hooks.creditFailure) throw hooks.creditFailure;
      return { creditNoteId: "credit-test", number: "AV-TEST", totalXpf: -1000, alreadyExisted: false, origin: { id: input.invoiceId, number: "FAC-TEST" } };
    },
    async paymentCorrection() { assert.fail("Correction non attendue"); },
    async invoiceDetail() { assert.fail("Lecture facture non attendue"); },
    receiptUrl() { return ""; },
  };
  const stock: StockClient = {
    async recordSale() {
      calls.recordSale++;
      hooks.recordSale?.();
      return { ok: true, movementId: "movement-test", productId: "product-test", qtyOnHand: 0, alreadyExisted: false };
    },
  };
  return { photo, db, calls, hooks, guard, persist, compta, stock, credits,
    run: () => runSaleSync(photo, compta, stock, persist, guard) };
}

function assertNoExternal(f: ReturnType<typeof fixture>) {
  for (const key of ["createInvoice", "settle", "recordSale", "creditNote"] as const) assert.equal(f.calls[key], 0, key);
}

test("a) photo PAID mais base VOID : aucune facture, aucun paiement, aucun stock", async () => {
  const f = fixture();
  f.db.sale!.status = "VOID";
  const out = await f.run();
  assert.equal(out.synced, false);
  assert.equal(out.stopped, "VOID");
  assertNoExternal(f);
  assert.equal(f.calls.recordFailure, 0);
  assert.equal(f.calls.clearError, 0);
});

test("b) annulation préparée : aucun appel, erreur de suspension", async () => {
  const f = fixture();
  Object.assign(f.db.sale!, { invoiceId: "invoice-test", voidPreparedAt: new Date() });
  const out = await f.run();
  assert.equal(out.stopped, "VOID_IN_PROGRESS");
  assertNoExternal(f);
  assert.equal(f.calls.recordFailure, 1);
  assert.match(f.db.sale!.syncError!, /^VOID_IN_PROGRESS/);
});

test("c) annulation directe pendant createInvoice : facture neutralisée et rattachée", async () => {
  const f = fixture();
  f.hooks.create = () => { f.db.sale!.status = "VOID"; };
  const out = await f.run();
  assert.equal(out.stopped, "VOID");
  assert.equal(out.neutralized, true);
  assert.equal(f.calls.createInvoice, 1);
  assert.deepEqual(f.credits, ["invoice-test"]);
  assert.equal(f.calls.settle, 0);
  assert.equal(f.calls.recordSale, 0);
  assert.equal(f.db.sale!.status, "VOID");
  assert.equal(f.db.sale!.invoiceId, "invoice-test");
  assert.equal(f.db.sale!.creditNoteId, "credit-test");
  assert.equal(f.db.sale!.syncError, null);
});

test("d) facture déjà rattachée et annulation préparée pendant l'appel : aucun avoir", async () => {
  const f = fixture();
  f.hooks.create = () => { Object.assign(f.db.sale!, { invoiceId: "invoice-test", voidPreparedAt: new Date() }); };
  const out = await f.run();
  assert.equal(out.stopped, "VOID_IN_PROGRESS");
  assert.equal(f.calls.createInvoice, 1);
  assert.equal(f.calls.creditNote, 0);
  assert.equal(f.calls.settle, 0);
  assert.equal(f.calls.recordSale, 0);
});

test("e) annulation après facture : son avoir ne doit pas être doublé", async () => {
  const f = fixture();
  f.hooks.saved = () => { Object.assign(f.db.sale!, { status: "VOID", creditNoteId: "credit-void" }); };
  const out = await f.run();
  assert.equal(out.stopped, "VOID");
  assert.equal(f.calls.createInvoice, 1);
  assert.equal(f.calls.creditNote, 0);
  assert.equal(f.calls.settle, 0);
  assert.equal(f.calls.recordSale, 0);
  assert.equal(f.db.sale!.creditNoteId, "credit-void");
});

test("f) chemin nominal gardé : N paiements, M lignes produit", async () => {
  const f = fixture();
  f.db.sale!.payments.push({ ...f.db.sale!.payments[0], id: "payment-2" });
  f.db.sale!.lines.push({ ...f.db.sale!.lines[0], id: "line-2" });
  const out = await f.run();
  assert.equal(out.synced, true);
  assert.equal(f.calls.createInvoice, 1);
  assert.equal(f.calls.settle, 2);
  assert.equal(f.calls.recordSale, 2);
  assert.equal(out.stockDecremented, 2);
  assert.ok(f.db.sale!.comptaSyncedAt);
  assert.ok(f.db.sale!.stockSyncedAt);
  assert.equal(f.calls.creditNote, 0);
});

test("g) échec avoir puis reprise : le marqueur survit et l'avoir est rattaché", async () => {
  const f = fixture();
  f.hooks.create = () => { f.db.sale!.status = "VOID"; };
  f.hooks.creditFailure = new CoreClientError("compta", "creditNote", 500, "panne test", "http");
  const out = await f.run();
  assert.equal(out.stopped, "VOID");
  assert.equal(out.failure?.op, "creditNote");
  assert.equal(f.db.sale!.invoiceId, "invoice-test");
  assert.ok(f.db.sale!.syncError!.startsWith(NEUTRALISATION_MARKER));
  assert.equal(f.calls.settle, 0);
  assert.equal(f.calls.recordSale, 0);
  assert.equal(f.calls.clearError, 0);
  f.hooks.creditFailure = undefined;
  f.calls.creditNote = 0;
  const retry = await retryNeutralization(f.db.sale!, f.compta, f.guard);
  assert.equal(retry.neutralized, true);
  assert.equal(retry.failure, null);
  assert.equal(f.calls.creditNote, 1);
  assert.equal(f.db.sale!.creditNoteId, "credit-test");
  assert.equal(f.db.sale!.syncError, null);
});

test("h) ancienne vente VOID sans marqueur : aucun avoir de réparation", async () => {
  const f = fixture();
  Object.assign(f.db.sale!, { status: "VOID", invoiceId: "invoice-old" });
  const out = await retryNeutralization(f.db.sale!, f.compta, f.guard);
  assert.equal(out.neutralized, false);
  assertNoExternal(f);
});

test("i) vente introuvable : aucun appel ni écriture", async () => {
  const f = fixture();
  f.db.sale = null;
  const out = await f.run();
  assert.equal(out.stopped, "NOT_FOUND");
  assertNoExternal(f);
  assert.equal(f.calls.recordFailure, 0);
  assert.equal(f.calls.clearError, 0);
});

test("j) facture concurrente différente : arrêt et trace, aucun avoir/règlement/stock", async () => {
  const f = fixture();
  f.hooks.create = () => { f.db.sale!.invoiceId = "invoice-other"; };
  const out = await f.run();
  assert.equal(out.stopped, "INVOICE_CONFLICT");
  assert.equal(out.synced, false);
  assert.equal(f.calls.createInvoice, 1);
  assert.equal(f.calls.creditNote, 0);
  assert.equal(f.calls.settle, 0);
  assert.equal(f.calls.recordSale, 0);
  assert.equal(f.calls.recordFailure, 1);
  assert.match(f.db.sale!.syncError!, /INVOICE_CONFLICT.*invoice-test.*invoice-other/);
});

test("k) annulation pendant settle : effet comptable marqué et course signalée", async () => {
  const f = fixture();
  f.hooks.settle = () => { f.db.sale!.status = "VOID"; };
  const out = await f.run();
  assert.equal(f.calls.settle, 1);
  assert.equal(out.settledOnVoidingSale, true);
  assert.ok(f.db.sale!.comptaSyncedAt);
  assert.equal(out.synced, false);
  assert.equal(out.stopped, "VOID");
  assert.equal(f.calls.recordSale, 0);
  assert.equal(f.calls.creditNote, 0);
});

test("l) annulation pendant recordSale : effet stock marqué et course signalée", async () => {
  const f = fixture();
  f.hooks.recordSale = () => { f.db.sale!.status = "VOID"; };
  const out = await f.run();
  assert.equal(f.calls.recordSale, 1);
  assert.equal(out.stockOnVoidingSale, true);
  assert.ok(f.db.sale!.stockSyncedAt);
  assert.equal(out.stockDecremented, 1);
  assert.equal(out.synced, true);
  assert.equal(f.calls.creditNote, 0);
});

test("m) persistance : marqueur protégé et tentatives toujours incrémentées", async () => {
  const f = fixture();
  const marker = `${NEUTRALISATION_MARKER} avoir en échec`;
  f.db.sale!.syncError = marker;
  await f.persist.recordFailure("compta:settle http 500 panne test");
  assert.equal(f.db.sale!.syncError, marker);
  assert.equal(f.db.syncAttempts, 1);
  await f.persist.clearError();
  assert.equal(f.db.sale!.syncError, marker);
  assert.equal(f.db.syncAttempts, 1);
  const detail = `${NEUTRALISATION_MARKER} nouvel échec`;
  await f.persist.recordFailure(detail);
  assert.equal(f.db.sale!.syncError, detail);
  assert.equal(f.db.syncAttempts, 2);
  assert.equal(shouldWriteSyncError(null, "compta:échec"), true);
  assert.equal(shouldWriteSyncError(null, null), true);
  assert.equal(shouldWriteSyncError("compta:échec", null), true);
  assert.equal(shouldWriteSyncError("compta:échec", "stock:échec"), true);
});

test("annulation préparée pendant les appels : les deux fenêtres sont signalées", async () => {
  for (const stage of ["settle", "recordSale"] as const) {
    const f = fixture();
    f.hooks[stage] = () => { f.db.sale!.voidPreparedAt = new Date(); };
    const out = await f.run();
    assert.equal(out[stage === "settle" ? "settledOnVoidingSale" : "stockOnVoidingSale"], true);
    assert.ok(stage === "settle" ? f.db.sale!.comptaSyncedAt : f.db.sale!.stockSyncedAt);
    assert.equal(f.calls.creditNote, 0);
  }
});
