import { test } from "node:test";
import assert from "node:assert/strict";
import { runSaleSync, retryNeutralization, NEUTRALISATION_MARKER, SYNC_EN_COURS_MARKER, syncClaimFor, claimState, syncBlocksVoid, SYNC_A_REPRENDRE_MARKER, checkoutStatusAfterSync, shouldWriteSyncError, type SyncGuard, type SyncPersist, type SyncSaleSnapshot } from "./sync.ts";
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
  const calls = { createInvoice: 0, settle: 0, recordSale: 0, creditNote: 0, recordFailure: 0, clearError: 0, completeSync: 0 };
  const hooks: { create?: () => void; saved?: () => void; claim?: () => void; settle?: () => void; recordSale?: () => void; creditFailure?: CoreClientError } = {};
  const credits: string[] = [];
  const guard: SyncGuard = {
    async reread() { return db.sale ? structuredClone(db.sale) : null; },
    async claimSync(claim) {
      hooks.claim?.();
      const s = db.sale;
      const fresh = s ? structuredClone(s) : null;
      if (!s || s.status !== "PAID" || s.voidPreparedAt) return { claimed: false, busy: false, fresh };
      if (claimState(s.syncError, new Date()) === "live" && s.syncError !== claim) return { claimed: false, busy: true, fresh };
      s.syncError = claim;
      return { claimed: true, fresh: structuredClone(s) };
    },
    async completeSync(claim, phase) {
      calls.completeSync++;
      if (!db.sale) return;
      db.sale[phase === "compta" ? "comptaSyncedAt" : "stockSyncedAt"] = new Date();
      if (db.sale.syncError === claim) db.sale.syncError = null;
    },
    async failSync(claim, phase, detail) {
      db.syncAttempts++;
      const s = db.sale;
      if (s?.syncError === claim) s.syncError = s[phase === "compta" ? "comptaSyncedAt" : "stockSyncedAt"] ? null : `${SYNC_A_REPRENDRE_MARKER} ${detail}`;
    },
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
    run: (timeoutMs = 8000) => runSaleSync(photo, compta, stock, persist, guard, timeoutMs) };
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

test("n) la revendication couvre tous les règlements et est libérée après l'étape", async () => {
  const f = fixture();
  const timeout = 8000;
  const started = Date.now();
  f.db.sale!.payments.push({ ...f.db.sale!.payments[0], id: "payment-2" });
  f.hooks.settle = () => {
    assert.ok(f.db.sale!.syncError?.startsWith(SYNC_EN_COURS_MARKER));
    const due = Date.parse(f.db.sale!.syncError!.split("jusqu'au ")[1].split(" #")[0]);
    assert.ok(due >= started + 2 * timeout);
  };
  f.hooks.claim = () => {
    if (f.calls.settle > 0) assert.equal(f.calls.completeSync, 1, "la revendication des règlements doit être libérée avant la revendication stock");
  };
  await f.run(timeout);
  assert.equal(f.calls.settle, 2);
  assert.equal(Boolean(f.db.sale!.syncError?.startsWith(SYNC_EN_COURS_MARKER)), false);
});

test("o) la revendication couvre toutes les sorties stock et est libérée après l'étape", async () => {
  const f = fixture();
  const timeout = 8000;
  const started = Date.now();
  f.db.sale!.comptaSyncedAt = new Date();
  f.db.sale!.lines.push({ ...f.db.sale!.lines[0], id: "line-2" });
  f.hooks.recordSale = () => {
    assert.ok(f.db.sale!.syncError?.startsWith(SYNC_EN_COURS_MARKER));
    const due = Date.parse(f.db.sale!.syncError!.split("jusqu'au ")[1].split(" #")[0]);
    assert.ok(due >= started + 2 * timeout);
  };
  await f.run(timeout);
  assert.equal(f.calls.recordSale, 2);
  assert.equal(Boolean(f.db.sale!.syncError?.startsWith(SYNC_EN_COURS_MARKER)), false);
});

test("p) claimState distingue echeance vivante, perimee et illisible", () => {
  const now = new Date("2026-10-15T00:00:00.000Z");
  const claim = syncClaimFor(2, now, 1000, "test-id");
  assert.equal(claim, "SYNC_EN_COURS jusqu'au 2026-10-15T00:00:07.000Z #test-id");
  assert.equal(claimState(claim, now), "live");
  assert.equal(claimState(claim, new Date("2026-10-15T00:00:07.000Z")), "stale");
  assert.equal(claimState(SYNC_EN_COURS_MARKER + " illisible", now), "stale");
  assert.equal(claimState(SYNC_A_REPRENDRE_MARKER, now), "stale");
  assert.equal(claimState(null, now), "none");
  assert.equal(claimState(NEUTRALISATION_MARKER, now), "none");
});

test("q) un échec core pendant settle remplace la revendication", async () => {
  const f = fixture();
  f.hooks.settle = () => { throw new CoreClientError("compta", "settle", 500, "panne", "http"); };
  const out = await f.run();
  assert.equal(out.synced, false);
  assert.equal(f.db.sale!.syncError?.startsWith(SYNC_EN_COURS_MARKER), false);
  assert.equal(syncBlocksVoid(f.db.sale!), true);
  assert.equal(claimState(f.db.sale!.syncError, new Date()), "stale");
  assert.equal(f.db.syncAttempts, 1);
  assert.match(f.db.sale!.syncError!, /compta:settle/);
});

test("r) runSaleSync arrête au retour de claimSync si la vente devient VOID ou préparée", async () => {
  for (const stage of ["settle", "recordSale"] as const) {
    for (const change of ["VOID", "PREPARED"] as const) {
      const f = fixture();
      if (stage === "recordSale") f.db.sale!.comptaSyncedAt = new Date();
      f.db.sale!.invoiceId = "invoice-test";
      f.hooks.claim = () => {
        if (change === "VOID") f.db.sale!.status = "VOID";
        else f.db.sale!.voidPreparedAt = new Date();
      };
      const out = await f.run();
      assert.equal(out.stopped, change === "VOID" ? "VOID" : "VOID_IN_PROGRESS");
      assert.equal(f.calls.settle, 0);
      assert.equal(f.calls.recordSale, 0);
      assert.equal(Boolean(f.db.sale!.syncError?.startsWith(SYNC_EN_COURS_MARKER)), false);
    }
  }
});

test("s) checkoutStatusAfterSync traduit les arrets sans effet concurrent", () => {
  assert.equal(checkoutStatusAfterSync({ stopped: "VOID" } as any), "VOID");
  assert.equal(checkoutStatusAfterSync(null), "PAID");
  assert.equal(checkoutStatusAfterSync({ synced: true } as any), "PAID");
  assert.equal(checkoutStatusAfterSync({ stopped: "NOT_FOUND" } as any), "PAID");
  assert.equal(checkoutStatusAfterSync({ stopped: "VOID_IN_PROGRESS" } as any), "PAID");
  assert.equal(checkoutStatusAfterSync({ stopped: "LOCKED" } as any), "PAID");
});


test("u) A vivant exclut B ; echec puis reprise de B", async () => {
  const f = fixture();
  f.db.sale!.invoiceId = "invoice-test";
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.compta.settle = async () => {
    f.calls.settle++;
    entered();
    await waiting;
    throw new CoreClientError("compta", "settle", 0, "timeout test", "timeout");
  };
  const a = f.run();
  await started;
  const claimA = f.db.sale!.syncError;
  const b = await f.guard.claimSync(syncClaimFor(1, new Date(), 8000, "B"));
  assert.equal(b.claimed, false);
  assert.ok(!b.claimed && b.busy);
  assert.equal((await f.run()).stopped, "LOCKED");
  assert.equal(f.calls.settle, 1);
  assert.equal(f.calls.recordSale, 0);
  assert.equal(f.db.sale!.syncError, claimA);
  release();
  assert.equal((await a).synced, false);
  assert.match(f.db.sale!.syncError!, /^SYNC_A_REPRENDRE/);
  assert.equal(syncBlocksVoid(f.db.sale!), true);
  f.compta.settle = async () => ({ ok: true, invoiceId: "invoice-test", paid: 1000, remaining: 0 });
  assert.equal((await f.run()).synced, true);
  assert.equal(f.db.sale!.syncError, null);
  assert.equal(syncBlocksVoid(f.db.sale!), false);
});

test("v) stock partiel puis timeout : blocage jusqua reprise confirmee", async () => {
  const f = fixture();
  f.db.sale!.comptaSyncedAt = new Date();
  f.db.sale!.lines.push({ ...f.db.sale!.lines[0], id: "line-2" });
  f.hooks.recordSale = () => {
    if (f.calls.recordSale === 2) throw new CoreClientError("stock", "recordSale", 0, "timeout test", "timeout");
  };
  const out = await f.run();
  assert.equal(out.synced, false);
  assert.equal(out.stockDecremented, 1);
  assert.equal(f.db.sale!.stockSyncedAt, null);
  assert.match(f.db.sale!.syncError!, /^SYNC_A_REPRENDRE/);
  assert.equal(syncBlocksVoid(f.db.sale!), true);
  f.hooks.recordSale = undefined;
  assert.equal((await f.run()).synced, true);
  assert.ok(f.db.sale!.stockSyncedAt);
  assert.equal(f.db.sale!.syncError, null);
  assert.equal(syncBlocksVoid(f.db.sale!), false);
});

test("w) A echu termine apres reprise par B : le marqueur de B survit", async () => {
  for (const phase of ["compta", "stock"] as const) {
    const f = fixture();
    const a = syncClaimFor(1, new Date(0), 1000, "A");
    f.db.sale!.syncError = a;
    const b = syncClaimFor(1, new Date(), 8000, "B");
    assert.equal((await f.guard.claimSync(b)).claimed, true);
    await f.guard.completeSync(a, phase);
    assert.equal(f.db.sale!.syncError, b);
    await f.guard.failSync(a, phase, "ancien echec");
    assert.equal(f.db.sale!.syncError, b);
    await f.persist.clearError();
    assert.equal(f.db.sale!.syncError, b);
    await f.guard.completeSync(b, phase);
    assert.equal(f.db.sale!.syncError, null);
  }
});

test("x) plantage : une revendication echue bloque toujours l'annulation", () => {
  const f = fixture();
  for (const marker of [syncClaimFor(1, new Date(0), 1000, "mort"), SYNC_EN_COURS_MARKER + " illisible"]) {
    f.db.sale!.syncError = marker;
    assert.equal(claimState(marker, new Date()), "stale");
    assert.equal(syncBlocksVoid(f.db.sale!), true);
  }
});

test("y) marqueur residuel entierement synchronise : annulation non bloquee", () => {
  const f = fixture();
  for (const marker of [SYNC_EN_COURS_MARKER, SYNC_A_REPRENDRE_MARKER]) {
    Object.assign(f.db.sale!, { syncError: marker, comptaSyncedAt: new Date(), stockSyncedAt: new Date() });
    assert.equal(syncBlocksVoid(f.db.sale!), false);
    f.db.sale!.stockSyncedAt = null;
    assert.equal(syncBlocksVoid(f.db.sale!), true);
    f.db.sale!.status = "VOID";
    assert.equal(syncBlocksVoid(f.db.sale!), false);
    f.db.sale!.status = "PAID";
    f.db.sale!.lines = [];
    assert.equal(syncBlocksVoid(f.db.sale!), false);
    f.db.sale!.lines = structuredClone(f.photo.lines);
  }
});

test("z) checkout : course reglements ou stock implique VOID", () => {
  assert.equal(checkoutStatusAfterSync({ settledOnVoidingSale: true } as any), "VOID");
  assert.equal(checkoutStatusAfterSync({ stockOnVoidingSale: true } as any), "VOID");
});

test("aa) les deux marqueurs protegent contre echec et effacement ordinaires", async () => {
  for (const marker of [SYNC_EN_COURS_MARKER, SYNC_A_REPRENDRE_MARKER]) {
    const f = fixture();
    f.db.sale!.syncError = marker;
    assert.equal(shouldWriteSyncError(marker, "panne ordinaire"), false);
    assert.equal(shouldWriteSyncError(marker, null), false);
    for (const detail of [NEUTRALISATION_MARKER, SYNC_EN_COURS_MARKER, SYNC_A_REPRENDRE_MARKER]) {
      assert.equal(shouldWriteSyncError(marker, detail), true);
    }
    await f.persist.recordFailure("panne ordinaire");
    await f.persist.clearError();
    assert.equal(f.db.sale!.syncError, marker);
    assert.equal(f.db.syncAttempts, 1);
  }
});

test("erreur inattendue : marqueur a reprendre et erreur originale preservee", async () => {
  for (const phase of ["compta", "stock"] as const) {
    for (const failPersistence of [false, true]) {
      const f = fixture();
      const original = new Error("plantage test");
      if (phase === "stock") f.db.sale!.comptaSyncedAt = new Date();
      f.hooks[phase === "compta" ? "settle" : "recordSale"] = () => { throw original; };
      if (failPersistence) f.guard.failSync = async () => { throw new Error("persistance en panne"); };
      await assert.rejects(f.run(), e => e === original);
      if (!failPersistence) {
        assert.match(f.db.sale!.syncError!, /^SYNC_A_REPRENDRE/);
        assert.equal(f.db.syncAttempts, 1);
      }
      assert.equal(syncBlocksVoid(f.db.sale!), true);
    }
  }
});
