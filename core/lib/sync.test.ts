// Tests du MOTEUR DE SYNCHRO post-encaissement (lib/sync.ts) — sans DB ni réseau :
// clients + persistance injectés en mémoire. Couvre le contrat fiabilité :
//   échec partiel simulé → état « à reprendre » persisté → repair ne rejoue QUE le manquant → converge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runSaleSync, type SyncSaleSnapshot, type SyncPersist } from "./sync.ts";
import { CoreClientError } from "./clients.ts";
import type { ComptaClient, StockClient, CreateInvoiceResult, SettleResult, MovementResult } from "./clients.ts";

// ─── Fakes ───────────────────────────────────────────────────────────────────

function makeSale(overrides: Partial<SyncSaleSnapshot> = {}): SyncSaleSnapshot {
  return {
    id: "sale-1",
    tenantId: "00000000-0000-4000-8000-000000000001",
    clientName: "Client Test",
    cashierId: null,
    invoiceId: null,
    invoiceNumber: null,
    comptaSyncedAt: null,
    stockSyncedAt: null,
    lines: [
      { id: "l-svc", kind: "SERVICE", label: "Soin", productId: null, qty: 1, unitXpf: 5000n },
      { id: "l-prd", kind: "PRODUCT", label: "Crème", productId: "prod-1", qty: 2, unitXpf: 1500n },
    ],
    payments: [{ id: "p-1", method: "CASH", amountXpf: 8000n, settleRef: "caisse:sale-1:0" }],
    ...overrides,
  };
}

type FakeState = {
  invoiceId: string | null;
  invoiceNumber: string | null;
  comptaSyncedAt: Date | null;
  stockSyncedAt: Date | null;
  syncError: string | null;
  syncAttempts: number;
};

function makePersist(state: FakeState): SyncPersist {
  return {
    async saveInvoiceRef(invoiceId, invoiceNumber) {
      state.invoiceId = invoiceId;
      state.invoiceNumber = invoiceNumber;
    },
    async markComptaSynced() {
      state.comptaSyncedAt = new Date();
    },
    async markStockSynced() {
      state.stockSyncedAt = new Date();
    },
    async recordFailure(detail) {
      state.syncError = detail;
      state.syncAttempts++;
    },
    async clearError() {
      state.syncError = null;
    },
  };
}

function emptyState(): FakeState {
  return { invoiceId: null, invoiceNumber: null, comptaSyncedAt: null, stockSyncedAt: null, syncError: null, syncAttempts: 0 };
}

/** Compta fake : compte les appels ; peut échouer sur commande. */
function makeCompta(opts: { failCreate?: CoreClientError; failSettle?: CoreClientError } = {}) {
  const calls = { createInvoice: 0, settle: 0 };
  const client: ComptaClient = {
    async createInvoice(): Promise<CreateInvoiceResult> {
      calls.createInvoice++;
      if (opts.failCreate) throw opts.failCreate;
      return { invoiceId: "inv-1", number: "FAC-1", totalXpf: 8000, alreadyExisted: false };
    },
    async settle(): Promise<SettleResult> {
      calls.settle++;
      if (opts.failSettle) throw opts.failSettle;
      return { ok: true, invoiceId: "inv-1", paid: 8000, remaining: 0 };
    },
    receiptUrl: (invoiceId) => `http://compta/receipt/${invoiceId}`,
  };
  return { client, calls, opts };
}

/** Stock fake : compte les appels ; peut échouer sur commande. */
function makeStock(opts: { fail?: CoreClientError } = {}) {
  const calls = { recordSale: 0 };
  const client: StockClient = {
    async recordSale(): Promise<MovementResult> {
      calls.recordSale++;
      if (opts.fail) throw opts.fail;
      return { ok: true, movementId: "mv-1", productId: "prod-1", qtyOnHand: 1, alreadyExisted: false };
    },
  };
  return { client, calls, opts };
}

/** Snapshot rechargé « comme depuis la DB » après un premier passage (reprend l'état persisté). */
function reload(sale: SyncSaleSnapshot, state: FakeState): SyncSaleSnapshot {
  return {
    ...sale,
    invoiceId: state.invoiceId,
    invoiceNumber: state.invoiceNumber,
    comptaSyncedAt: state.comptaSyncedAt,
    stockSyncedAt: state.stockSyncedAt,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("synchro complète : facture + settle + stock, état marqué convergé", async () => {
  const state = emptyState();
  const compta = makeCompta();
  const stock = makeStock();

  const out = await runSaleSync(makeSale(), compta.client, stock.client, makePersist(state));

  assert.equal(out.synced, true);
  assert.equal(out.invoiceId, "inv-1");
  assert.equal(out.stockDecremented, 1); // seule la ligne PRODUCT décrémente
  assert.equal(compta.calls.createInvoice, 1);
  assert.equal(compta.calls.settle, 1);
  assert.equal(stock.calls.recordSale, 1);
  assert.ok(state.comptaSyncedAt);
  assert.ok(state.stockSyncedAt);
  assert.equal(state.syncError, null);
});

test("échec Stock APRÈS Compta OK : trace exploitable, puis repair ne rejoue QUE le stock", async () => {
  const state = emptyState();
  const compta = makeCompta();
  const stock = makeStock({ fail: new CoreClientError("stock", "recordSale", 500, "boom", "http") });
  const sale = makeSale();

  // 1er passage : compta passe, stock casse → vente « à reprendre »
  const out1 = await runSaleSync(sale, compta.client, stock.client, makePersist(state));
  assert.equal(out1.synced, false);
  assert.equal(out1.failure?.core, "stock");
  assert.equal(out1.failure?.kind, "http");
  assert.ok(state.comptaSyncedAt, "l'étape compta doit être marquée faite");
  assert.equal(state.stockSyncedAt, null, "l'étape stock doit rester manquante");
  assert.match(state.syncError!, /stock:recordSale http 500 boom/);
  assert.equal(state.syncAttempts, 1);

  // 2e passage (repair) : stock revenu → converge SANS repasser par Compta
  stock.opts.fail = undefined;
  const out2 = await runSaleSync(reload(sale, state), compta.client, stock.client, makePersist(state));
  assert.equal(out2.synced, true);
  assert.equal(compta.calls.createInvoice, 1, "la facture ne doit PAS être recréée");
  assert.equal(compta.calls.settle, 1, "le settle ne doit PAS être rejoué");
  assert.equal(stock.calls.recordSale, 2, "seul le décrément stock est rejoué");
  assert.ok(state.stockSyncedAt);
  assert.equal(state.syncError, null, "l'erreur est purgée après convergence");
});

test("timeout Compta à la facture : rien de marqué, erreur kind=timeout, repair converge", async () => {
  const state = emptyState();
  const compta = makeCompta({ failCreate: new CoreClientError("compta", "createInvoice", 0, "pas de réponse après 100 ms", "timeout") });
  const stock = makeStock();
  const sale = makeSale();

  const out1 = await runSaleSync(sale, compta.client, stock.client, makePersist(state));
  assert.equal(out1.synced, false);
  assert.equal(out1.failure?.kind, "timeout");
  assert.equal(out1.failure?.status, 0);
  assert.equal(state.invoiceId, null);
  assert.equal(state.comptaSyncedAt, null);
  assert.equal(state.stockSyncedAt, null);
  assert.match(state.syncError!, /compta:createInvoice timeout 0/);

  compta.opts.failCreate = undefined;
  const out2 = await runSaleSync(reload(sale, state), compta.client, stock.client, makePersist(state));
  assert.equal(out2.synced, true);
  assert.equal(compta.calls.createInvoice, 2); // 1 échec + 1 succès — une seule facture créée côté cible
  assert.equal(stock.calls.recordSale, 1);
});

test("échec settle APRÈS facture créée : invoiceId persisté, repair réutilise la même facture", async () => {
  const state = emptyState();
  const compta = makeCompta({ failSettle: new CoreClientError("compta", "settle", 503, "indispo", "http") });
  const stock = makeStock();
  const sale = makeSale();

  const out1 = await runSaleSync(sale, compta.client, stock.client, makePersist(state));
  assert.equal(out1.synced, false);
  assert.equal(state.invoiceId, "inv-1", "la référence facture doit être persistée dès sa création");
  assert.equal(state.comptaSyncedAt, null, "compta pas encore convergée (settle manquant)");

  compta.opts.failSettle = undefined;
  const out2 = await runSaleSync(reload(sale, state), compta.client, stock.client, makePersist(state));
  assert.equal(out2.synced, true);
  assert.equal(compta.calls.createInvoice, 1, "la facture ne doit PAS être recréée (invoiceId connu)");
  assert.equal(compta.calls.settle, 2, "le settle est rejoué (idempotent par paymentRef côté Compta)");
});

test("vente 100 % service : étape stock marquée faite SANS appel Stock", async () => {
  const state = emptyState();
  const compta = makeCompta();
  const stock = makeStock();
  const sale = makeSale({
    lines: [{ id: "l-svc", kind: "SERVICE", label: "Soin", productId: null, qty: 1, unitXpf: 8000n }],
  });

  const out = await runSaleSync(sale, compta.client, stock.client, makePersist(state));
  assert.equal(out.synced, true);
  assert.equal(out.stockDecremented, 0);
  assert.equal(stock.calls.recordSale, 0);
  assert.ok(state.stockSyncedAt, "synchronisée stock par vacuité");
});

test("étapes déjà convergées : aucun appel sortant (no-op idempotent)", async () => {
  const state = emptyState();
  const compta = makeCompta();
  const stock = makeStock();
  const sale = makeSale({
    invoiceId: "inv-1",
    invoiceNumber: "FAC-1",
    comptaSyncedAt: new Date(),
    stockSyncedAt: new Date(),
  });

  const out = await runSaleSync(sale, compta.client, stock.client, makePersist(state));
  assert.equal(out.synced, true);
  assert.equal(compta.calls.createInvoice, 0);
  assert.equal(compta.calls.settle, 0);
  assert.equal(stock.calls.recordSale, 0);
  assert.equal(out.stockDecremented, 1, "le reporting compte les lignes PRODUCT déjà couvertes");
});
