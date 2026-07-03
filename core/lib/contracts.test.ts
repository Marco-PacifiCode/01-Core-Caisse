// contracts.test.ts — TEST DE CONTRAT INTER-CORES (Caisse → Compta, Caisse → Stock).
//
// POURQUOI : la Caisse ORCHESTRE l'encaissement en poussant 3 requêtes S2S (facture Compta →
// settle → décrément Stock). Ces formats de requêtes/réponses sont un CONTRAT tacite entre repos
// distincts. Rien ne les verrouille : un renommage de champ côté producteur (Compta/Stock) casserait
// la Caisse SILENCIEUSEMENT en prod. Ce test fige le contrat CONSOMMÉ par la Caisse.
//
// COMMENT : on fait tourner le VRAI moteur de synchro (lib/sync.ts runSaleSync) avec les VRAIS clients
// HTTP (lib/clients.ts comptaClient()/stockClient() en mode réel, pas mock), pointés vers des serveurs
// HTTP locaux qui CAPTURENT le corps exact de chaque requête (même patron que lib/clients.test.ts).
// On assert :
//   (a) la FORME EXACTE des requêtes émises (chemin, payload) ;
//   (b) que le consommateur PARSE correctement la forme des réponses documentées.
//
// ─── VÉRIFICATION PRODUCTEURS (lue en frais sur origin/main, 2026-07-03) ───────────────────────────
// Compta POST /api/invoices  — 01-Core-Compta/core/app/api/invoices/route.ts
//   accepte { tenantId, sourceType, sourceId, clientName?, lines:[{label, qty, unitXpf}] }  (l.29-56, 87-92)
//   renvoie { invoiceId, number, totalXpf, alreadyExisted }                                  (l.94-99)
// Compta POST /api/settle    — 01-Core-Compta/core/app/api/settle/route.ts
//   accepte { tenantId, invoiceId, amountXpf, method, paymentRef }                           (l.17-35)
//   renvoie { ok:true, invoiceId, paid, remaining }                                          (l.88-93)
//   idempotence par `paymentRef` (champ Payment.ref)                                         (l.52-60)
// Stock  POST /api/movements — 01-Core-Stock/core/app/api/movements/route.ts
//   accepte { tenantId, productId, type, qty, sourceType?, sourceId?, actorId? }             (l.27-67)
//   renvoie { ok:true, movementId, productId, qtyOnHand, alreadyExisted }                    (l.74 + lib/stock.ts l.54, 166)
//   idempotence SALE par tenantId+sourceType+sourceId                                        (route l.13, lib/stock.ts l.61)
// → AUCUN décalage consommateur/producteur détecté : les 3 contrats coïncident champ pour champ.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { comptaClient, stockClient } from "./clients.ts";
import { runSaleSync, type SyncSaleSnapshot, type SyncPersist } from "./sync.ts";

// Mode RÉEL (pas mock) — on veut la vraie sérialisation HTTP. Timeout court pour des tests rapides.
process.env.CORE_CLIENTS_MOCK = "";
process.env.CORE_CLIENT_TIMEOUT_MS = "2000";

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

type Captured = { path: string; key: string | undefined; body: any };

const TENANT = "00000000-0000-4000-8000-000000000001";

/** Sale de référence : 1 ligne SERVICE + 1 ligne PRODUCT, paiement CASH. */
function makeSale(overrides: Partial<SyncSaleSnapshot> = {}): SyncSaleSnapshot {
  return {
    id: "sale-42",
    tenantId: TENANT,
    clientName: "Client Contrat",
    cashierId: "cashier-7",
    invoiceId: null,
    invoiceNumber: null,
    comptaSyncedAt: null,
    stockSyncedAt: null,
    lines: [
      { id: "l-svc", kind: "SERVICE", label: "Soin", productId: null, qty: 1, unitXpf: 5000n },
      { id: "l-prd", kind: "PRODUCT", label: "Crème", productId: "prod-1", qty: 2, unitXpf: 1500n },
    ],
    payments: [{ id: "pay-0", method: "CASH", amountXpf: 8000n, settleRef: null }],
    ...overrides,
  };
}

/** Persist no-op : ce test verrouille le CONTRAT RÉSEAU, pas la persistance (couverte par sync.test.ts). */
function noopPersist(): SyncPersist {
  return {
    async saveInvoiceRef() {},
    async markComptaSynced() {},
    async markStockSynced() {},
    async recordFailure() {},
    async clearError() {},
  };
}

/**
 * Serveur Compta simulé : capture /api/invoices et /api/settle, répond la forme documentée.
 * Renvoie le port + le tableau des requêtes capturées.
 */
function startComptaCapture(captured: Captured[]): Promise<number> {
  const srv = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url || "").split("?")[0];
    captured.push({ path, key: req.headers["x-core-key"] as string | undefined, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (path === "/api/invoices") {
      // Forme réponse producteur — 01-Core-Compta/core/app/api/invoices/route.ts l.94-99
      res.end(JSON.stringify({ invoiceId: "inv-77", number: "FAC-2026-0077", totalXpf: 8000, alreadyExisted: false }));
    } else if (path === "/api/settle") {
      // Forme réponse producteur — 01-Core-Compta/core/app/api/settle/route.ts l.88-93
      res.end(JSON.stringify({ ok: true, invoiceId: "inv-77", paid: 8000, remaining: 0 }));
    } else {
      res.end(JSON.stringify({ error: "unexpected path", path }));
    }
  });
  return listen(srv);
}

function startStockCapture(captured: Captured[]): Promise<number> {
  const srv = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url || "").split("?")[0];
    captured.push({ path, key: req.headers["x-core-key"] as string | undefined, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    // Forme réponse producteur — 01-Core-Stock/core/app/api/movements/route.ts l.74 (+ lib/stock.ts l.166)
    res.end(JSON.stringify({ ok: true, movementId: "mv-9", productId: body.productId, qtyOnHand: 3, alreadyExisted: false }));
  });
  return listen(srv);
}

// ─── Test 1 : requêtes ÉMISES vers Compta + Stock (forme exacte du payload) ───────────────────────

test("contrat Caisse→Compta/Stock : forme exacte des requêtes émises à l'encaissement", async () => {
  const comptaReqs: Captured[] = [];
  const stockReqs: Captured[] = [];
  const comptaPort = await startComptaCapture(comptaReqs);
  const stockPort = await startStockCapture(stockReqs);
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${comptaPort}`;
  process.env.CORE_STOCK_URL = `http://127.0.0.1:${stockPort}`;

  const out = await runSaleSync(makeSale(), comptaClient(), stockClient(), noopPersist());
  assert.equal(out.synced, true, "la synchro doit converger contre des cibles nominales");

  // ── Compta : 1 facture + 1 settle (un paiement) ──
  const invoiceReq = comptaReqs.find((c) => c.path === "/api/invoices");
  const settleReq = comptaReqs.find((c) => c.path === "/api/settle");
  assert.ok(invoiceReq, "une requête POST /api/invoices doit être émise");
  assert.ok(settleReq, "une requête POST /api/settle doit être émise");

  // Payload facture — DOIT correspondre au producteur Compta /api/invoices (route.ts l.29-56, 87-92).
  assert.deepEqual(invoiceReq!.body, {
    tenantId: TENANT,
    sourceType: "caisse", // CAISSE_SOURCE_TYPE (sync.ts l.23,128)
    sourceId: "sale-42", // = Sale.id → clé d'idempotence facture (Compta findFirst sourceType+sourceId)
    clientName: "Client Contrat",
    lines: [
      { label: "Soin", qty: 1, unitXpf: 5000 }, // unitXpf en number (bigint→Number côté sync.ts l.131)
      { label: "Crème", qty: 2, unitXpf: 1500 },
    ],
  });

  // Payload settle — DOIT correspondre au producteur Compta /api/settle (route.ts l.17-35).
  assert.deepEqual(settleReq!.body, {
    tenantId: TENANT,
    invoiceId: "inv-77", // repris de la réponse /api/invoices → couplage facture→settle vérifié
    amountXpf: 8000,
    method: "CASH",
    // paymentRef déterministe : `caisse:<saleId>:<paymentId>` quand settleRef est absent (sync.ts l.143).
    paymentRef: "caisse:sale-42:pay-0",
  });

  // ── Stock : 1 mouvement SALE pour la SEULE ligne PRODUCT (la ligne SERVICE ne décrémente pas) ──
  const movementReqs = stockReqs.filter((c) => c.path === "/api/movements");
  assert.equal(movementReqs.length, 1, "seule la ligne PRODUCT émet un mouvement stock");

  // Payload mouvement — DOIT correspondre au producteur Stock /api/movements (route.ts l.27-67).
  assert.deepEqual(movementReqs[0].body, {
    tenantId: TENANT,
    productId: "prod-1",
    type: "SALE", // figé côté client (clients.ts l.195)
    qty: 2,
    sourceType: "caisse",
    sourceId: "sale-42:l-prd", // `<saleId>:<lineId>` → clé d'idempotence mouvement (sync.ts l.158)
    actorId: "cashier-7", // = Sale.cashierId
  });
});

// ─── Test 2 : idempotence — un settleRef pré-existant est repris tel quel (pas de dérivation) ──────

test("contrat Caisse→Compta : un settleRef persisté est envoyé tel quel (idempotence stable au rejeu)", async () => {
  const comptaReqs: Captured[] = [];
  const stockReqs: Captured[] = [];
  const comptaPort = await startComptaCapture(comptaReqs);
  const stockPort = await startStockCapture(stockReqs);
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${comptaPort}`;
  process.env.CORE_STOCK_URL = `http://127.0.0.1:${stockPort}`;

  const sale = makeSale({
    payments: [{ id: "pay-0", method: "CARD", amountXpf: 8000n, settleRef: "caisse:sale-42:pay-0" }],
  });
  await runSaleSync(sale, comptaClient(), stockClient(), noopPersist());

  const settleReq = comptaReqs.find((c) => c.path === "/api/settle");
  assert.ok(settleReq);
  // Le paymentRef DOIT rester stable entre l'encaissement initial et un éventuel repair (sync.ts l.143) :
  // sinon Compta créerait un doublon de paiement au rejeu (idempotence par Payment.ref cassée).
  assert.equal(settleReq!.body.paymentRef, "caisse:sale-42:pay-0");
  assert.equal(settleReq!.body.method, "CARD");
});

// ─── Test 3 : le consommateur PARSE correctement les réponses documentées ─────────────────────────

test("contrat Caisse : les réponses documentées de Compta/Stock sont correctement parsées", async () => {
  const comptaReqs: Captured[] = [];
  const stockReqs: Captured[] = [];
  const comptaPort = await startComptaCapture(comptaReqs);
  const stockPort = await startStockCapture(stockReqs);
  process.env.CORE_COMPTA_URL = `http://127.0.0.1:${comptaPort}`;
  process.env.CORE_STOCK_URL = `http://127.0.0.1:${stockPort}`;

  // Chemins nominaux directs sur les clients (parse de la réponse) — indépendant du moteur.
  const inv = await comptaClient().createInvoice({
    tenantId: TENANT,
    sourceType: "caisse",
    sourceId: "sale-42",
    clientName: null,
    lines: [{ label: "X", qty: 1, unitXpf: 1000 }],
  });
  // Réponse /api/invoices → { invoiceId, number, totalXpf, alreadyExisted }
  assert.equal(inv.invoiceId, "inv-77");
  assert.equal(inv.number, "FAC-2026-0077");
  assert.equal(inv.totalXpf, 8000);
  assert.equal(inv.alreadyExisted, false);

  const settle = await comptaClient().settle({
    tenantId: TENANT,
    invoiceId: "inv-77",
    amountXpf: 8000,
    method: "CASH",
    paymentRef: "caisse:sale-42:pay-0",
  });
  // Réponse /api/settle → { ok, invoiceId, paid, remaining }
  assert.equal(settle.ok, true);
  assert.equal(settle.invoiceId, "inv-77");
  assert.equal(settle.paid, 8000);
  assert.equal(settle.remaining, 0);

  const mv = await stockClient().recordSale({
    tenantId: TENANT,
    productId: "prod-1",
    qty: 2,
    sourceType: "caisse",
    sourceId: "sale-42:l-prd",
    actorId: "cashier-7",
  });
  // Réponse /api/movements → { ok, movementId, productId, qtyOnHand, alreadyExisted }
  assert.equal(mv.ok, true);
  assert.equal(mv.movementId, "mv-9");
  assert.equal(mv.productId, "prod-1");
  assert.equal(mv.qtyOnHand, 3);
  assert.equal(mv.alreadyExisted, false);
});
