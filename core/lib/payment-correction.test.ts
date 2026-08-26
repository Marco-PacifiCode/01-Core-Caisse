// Contrat de la correction du moyen de paiement (lib/payment-correction.ts) — même patron que
// void-route.test.ts : logique PURE, dépendances injectées, exécutée réellement sans DB ni réseau.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runPaymentCorrection,
  verifierCorrection,
  correctionKeyPour,
  generationCorrection,
  refsDeLaCorrection,
  repartitionNette,
  MOYENS_ADMIS,
  type SaleSnapshotForCorrection,
  type PaymentCorrectionDeps,
  type ComptaCorrectionArgs,
  type InsertCorrectionPaymentsArgs,
} from "./payment-correction.ts";
import { expectedCashXpf } from "./cash-movement.ts";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const lire = (...p: string[]) => readFileSync(path.join(libDir, ...p), "utf8");

const TENANT = "00000000-0000-4000-8000-000000000001";

function makeSale(overrides: Partial<SaleSnapshotForCorrection> = {}): SaleSnapshotForCorrection {
  return {
    id: "sale-1",
    status: "PAID",
    sessionId: "session-1",
    sessionStatus: "OPEN",
    comptaSyncedAt: new Date("2026-08-20T08:00:00Z"),
    invoiceId: "inv-1",
    payments: [{ method: "CASH", amountXpf: 5000n, settleRef: "caisse:sale-1:0" }],
    ...overrides,
  };
}

const INPUT = { fromMethod: "CASH", toMethod: "CARD", amountXpf: 5000 };

/** Fake deps — état en mémoire, comme void-route.test.ts. */
function makeDeps(opts: {
  sale?: SaleSnapshotForCorrection | null;
  failCompta?: Error;
  alreadyInserted?: boolean;
} = {}) {
  const calls = { loadSale: 0, comptaCorrection: 0, insertCorrectionPayments: 0 };
  const comptaCalls: ComptaCorrectionArgs[] = [];
  const insertCalls: InsertCorrectionPaymentsArgs[] = [];
  let inserted = opts.alreadyInserted ?? false;

  const deps: PaymentCorrectionDeps = {
    async loadSale() {
      calls.loadSale++;
      return opts.sale === undefined ? makeSale() : opts.sale;
    },
    async comptaCorrection(args) {
      calls.comptaCorrection++;
      comptaCalls.push(args);
      if (opts.failCompta) throw opts.failCompta;
      return { ok: true };
    },
    async insertCorrectionPayments(args) {
      calls.insertCorrectionPayments++;
      insertCalls.push(args);
      if (inserted) return { inserted: false };
      inserted = true;
      return { inserted: true };
    },
  };
  return { deps, calls, comptaCalls, insertCalls };
}

// ─── 1. INVARIANT : la somme des paiements ne bouge jamais ────────────────────────────────────

test("INVARIANT : après correction, Σ amountXpf des paiements du ticket est rigoureusement inchangée", async () => {
  const sale = makeSale({ payments: [{ method: "CASH", amountXpf: 8000n, settleRef: null }] });
  const before = sale.payments.reduce((t, p) => t + p.amountXpf, 0n);

  const { deps } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT, amountXpf: 3000 });

  assert.equal(out.ok, true);
  if (!out.ok) return;
  const after = out.payments.reduce((t, p) => t + BigInt(p.amountXpf), 0n);
  assert.equal(after, before, "la contre-écriture ne doit rien ajouter ni retirer au total encaissé");
});

// ─── 2. CASH baisse, CARD monte, et l'attendu du Z baisse d'autant ────────────────────────────

test("la part CASH baisse exactement du montant corrigé, CARD monte d'autant, et l'attendu du Z baisse d'autant", async () => {
  const sale = makeSale({ payments: [{ method: "CASH", amountXpf: 8000n, settleRef: null }] });
  const openingFloatXpf = 10_000n;

  const expectedAvant = expectedCashXpf({
    openingFloatXpf,
    cashSalesXpf: sale.payments.filter((p) => p.method === "CASH").reduce((t, p) => t + p.amountXpf, 0n),
    movements: [],
  });

  const { deps } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT, amountXpf: 3000 });
  assert.equal(out.ok, true);
  if (!out.ok) return;

  const cashApres = out.payments.find((p) => p.method === "CASH")?.amountXpf ?? 0;
  const cardApres = out.payments.find((p) => p.method === "CARD")?.amountXpf ?? 0;
  assert.equal(cashApres, 5000, "CASH baisse exactement du montant corrigé");
  assert.equal(cardApres, 3000, "CARD monte exactement du montant corrigé");

  const expectedApres = expectedCashXpf({
    openingFloatXpf,
    cashSalesXpf: BigInt(cashApres),
    movements: [],
  });
  assert.equal(expectedAvant - expectedApres, 3000n, "l'attendu du Z baisse exactement du montant corrigé");
});

// ─── 3. Session CLOSED → refus, aucune écriture ───────────────────────────────────────────────

test("session CLOSED → refus SESSION_CLOSED, comptaCorrection jamais appelée, aucune écriture", async () => {
  const sale = makeSale({ sessionStatus: "CLOSED" });
  const { deps, calls } = makeDeps({ sale });

  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });

  assert.deepEqual(out, { ok: false, error: "SESSION_CLOSED" });
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

// ─── 4. Vente sans session → NO_SESSION, rien d'appelé ────────────────────────────────────────

test("vente sans session → NO_SESSION, rien d'appelé", async () => {
  const sale = makeSale({ sessionId: null, sessionStatus: null });
  const { deps, calls } = makeDeps({ sale });

  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });

  assert.deepEqual(out, { ok: false, error: "NO_SESSION" });
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

// ─── 5. Un refus chacun, aucune dépendance d'écriture appelée ─────────────────────────────────

test("NOT_PAID → refus, aucune écriture", async () => {
  const sale = makeSale({ status: "DRAFT" });
  const { deps, calls } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });
  assert.deepEqual(out, { ok: false, error: "NOT_PAID" });
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

test("NO_INVOICE → refus, aucune écriture", async () => {
  const sale = makeSale({ invoiceId: null });
  const { deps, calls } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });
  assert.deepEqual(out, { ok: false, error: "NO_INVOICE" });
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

test("NOT_SYNCED → refus, aucune écriture", async () => {
  const sale = makeSale({ comptaSyncedAt: null });
  const { deps, calls } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });
  assert.deepEqual(out, { ok: false, error: "NOT_SYNCED" });
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

test("NOTHING_TO_CORRECT → refus, aucune écriture (montant supérieur au net CASH)", async () => {
  const sale = makeSale({ payments: [{ method: "CASH", amountXpf: 1000n, settleRef: null }] });
  const { deps, calls } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT, amountXpf: 5000 });
  assert.deepEqual(out, { ok: false, error: "NOTHING_TO_CORRECT" });
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

// ─── 6. Échec de comptaCorrection → aucun SalePayment écrit ───────────────────────────────────

test("échec de comptaCorrection → aucun SalePayment écrit, erreur COMPTA_CORRECTION_FAILED", async () => {
  const sale = makeSale();
  const { deps, calls } = makeDeps({ sale, failCompta: new Error("Compta indisponible") });

  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });

  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error, "COMPTA_CORRECTION_FAILED");
  assert.match((out as { detail: string }).detail, /Compta indisponible/);
  assert.equal(calls.insertCorrectionPayments, 0, "la caisse ne doit RIEN écrire si la compta a échoué");
});

// ─── 7. Rejeu : le settleRef de sortie existe déjà → alreadyCorrected:true, aucune écriture de plus

test("rejeu (settleRef de sortie déjà présent) → alreadyCorrected:true, aucune écriture supplémentaire", async () => {
  const sale = makeSale();
  const { deps, calls, comptaCalls } = makeDeps({ sale, alreadyInserted: true });

  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.alreadyCorrected, true);
  assert.equal(calls.insertCorrectionPayments, 1, "insertCorrectionPayments est appelée mais ne réécrit rien (inserted:false)");
  // comptaCorrection PEUT être appelée (idempotente côté Compta) : le rejeu ne doit pas planter.
  assert.equal(calls.comptaCorrection, 1);
  assert.equal(
    comptaCalls[0].correctionKey,
    correctionKeyPour(sale.id, INPUT.fromMethod, INPUT.toMethod, INPUT.amountXpf, generationCorrection(sale.payments)),
  );
});

// ─── DÉFAUT 2 : l'ALLER-RETOUR (une clé sans génération rend la 3ᵉ correction inopérante) ─────
//
// Fake AVEC ÉTAT : contrairement à `makeDeps` (sale figée), ici `loadSale` reflète les écritures
// des appels précédents — exactement ce qu'un vrai `findFirst` ferait entre deux requêtes HTTP
// successives. C'est ce qui rend `generationCorrection` observable d'un appel à l'autre.

function makeStatefulDeps(initialPayments: SaleSnapshotForCorrection["payments"]) {
  const payments = [...initialPayments];
  const settleRefsConnus = new Set<string>();
  const calls = { comptaCorrection: 0, insertCorrectionPayments: 0 };

  const deps: PaymentCorrectionDeps = {
    async loadSale() {
      return { ...makeSale(), payments: [...payments] };
    },
    async comptaCorrection() {
      calls.comptaCorrection++;
      return { ok: true };
    },
    async insertCorrectionPayments(args) {
      calls.insertCorrectionPayments++;
      if (settleRefsConnus.has(args.sortie)) return { inserted: false };
      settleRefsConnus.add(args.sortie);
      settleRefsConnus.add(args.entree);
      payments.push({ method: args.fromMethod, amountXpf: -BigInt(args.amountXpf), settleRef: args.sortie });
      payments.push({ method: args.toMethod, amountXpf: BigInt(args.amountXpf), settleRef: args.entree });
      return { inserted: true };
    },
  };
  return { deps, calls, payments };
}

test("l'ALLER-RETOUR, en toutes lettres : Espèces→Carte, puis Carte→Espèces, puis à nouveau Espèces→Carte — la 3ᵉ ÉCRIT vraiment", async () => {
  const { deps, payments } = makeStatefulDeps([{ method: "CASH", amountXpf: 5000n, settleRef: null }]);

  // 1) Espèces → Carte
  const r1 = await runPaymentCorrection(deps, { saleId: "sale-1", tenantId: TENANT, fromMethod: "CASH", toMethod: "CARD", amountXpf: 5000 });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.equal(r1.alreadyCorrected, false, "1ère correction : doit écrire");

  // 2) On s'est encore trompé : Carte → Espèces
  const r2 = await runPaymentCorrection(deps, { saleId: "sale-1", tenantId: TENANT, fromMethod: "CARD", toMethod: "CASH", amountXpf: 5000 });
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.equal(r2.alreadyCorrected, false, "2ème correction (sens inverse) : doit écrire");

  // 3) Et de nouveau Espèces → Carte — MÊME COUPLE de moyens que l'étape 1. Sans `generation`
  //    dans la clé, ceci retombe sur les `settleRef` de l'étape 1 (déjà connus) et le moteur
  //    répondrait `alreadyCorrected:true` SANS RIEN ÉCRIRE, alors que la vente est encore fausse.
  const nbAvant = payments.length;
  const r3 = await runPaymentCorrection(deps, { saleId: "sale-1", tenantId: TENANT, fromMethod: "CASH", toMethod: "CARD", amountXpf: 5000 });
  assert.equal(r3.ok, true);
  if (!r3.ok) return;
  assert.equal(r3.alreadyCorrected, false, "3ème correction (même couple que la 1ère) : DOIT écrire vraiment, la génération a changé");
  assert.equal(payments.length, nbAvant + 2, "2 nouvelles lignes SalePayment écrites par la 3ème correction");

  // Répartition finale : le ticket doit être en CARTE (la dernière correction gagne).
  const cash = r3.payments.find((p) => p.method === "CASH")?.amountXpf ?? 0;
  const card = r3.payments.find((p) => p.method === "CARD")?.amountXpf ?? 0;
  assert.equal(cash, 0, "répartition finale : plus rien en CASH");
  assert.equal(card, 5000, "répartition finale : tout en CARD");
});

// ─── DÉFAUT 2 (suite) : le double clic IDENTIQUE reste idempotent, à génération constante ─────

test("double clic identique (même génération) reste idempotent : un seul couple écrit, alreadyCorrected:true au second appel", async () => {
  const sale = makeSale({ payments: [{ method: "CASH", amountXpf: 5000n, settleRef: null }] });
  // `makeDeps` charge la MÊME photo de vente à chaque appel (elle n'est jamais réécrite entre les
  // deux appels) — c'est exactement le double clic : les deux requêtes HTTP lisent le même état
  // AVANT que la première n'ait eu le temps d'écrire, donc calculent la MÊME génération.
  const { deps, calls } = makeDeps({ sale });

  const r1 = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });
  const r2 = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, ...INPUT });

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.alreadyCorrected, false, "premier appel : écrit");
  assert.equal(r2.alreadyCorrected, true, "second appel (même génération) : constate, n'écrit rien de plus");
  assert.equal(calls.insertCorrectionPayments, 2, "les deux appels appellent insertCorrectionPayments");
});

// ─── 8. correctionKeyPour est déterministe et distingue les sens ──────────────────────────────

test("correctionKeyPour est déterministe (deux appels identiques, même génération → même clé)", () => {
  const k1 = correctionKeyPour("sale-1", "CASH", "CARD", 3000, 0);
  const k2 = correctionKeyPour("sale-1", "CASH", "CARD", 3000, 0);
  assert.equal(k1, k2);
});

test("correctionKeyPour distingue les sens (CASH→CARD ≠ CARD→CASH)", () => {
  const k1 = correctionKeyPour("sale-1", "CASH", "CARD", 3000, 0);
  const k2 = correctionKeyPour("sale-1", "CARD", "CASH", 3000, 0);
  assert.notEqual(k1, k2);
});

test("correctionKeyPour distingue les générations (l'aller-retour ne retombe pas sur la même clé)", () => {
  const k0 = correctionKeyPour("sale-1", "CASH", "CARD", 3000, 0);
  const k1 = correctionKeyPour("sale-1", "CASH", "CARD", 3000, 2);
  assert.notEqual(k0, k1, "générations différentes ⇒ clés différentes");
});

test("refsDeLaCorrection dérive deux références distinctes et stables à partir de la clé", () => {
  const key = correctionKeyPour("sale-1", "CASH", "CARD", 3000, 0);
  const refs = refsDeLaCorrection(key);
  assert.equal(refs.sortie, `corr:${key}:out`);
  assert.equal(refs.entree, `corr:${key}:in`);
  assert.notEqual(refs.sortie, refs.entree);
});

// ─── generationCorrection : compte les settleRef `corr:*` déjà présents ───────────────────────

test("generationCorrection : 0 avant toute correction, 2 après une, 4 après deux", () => {
  assert.equal(generationCorrection([{ settleRef: "caisse:sale-1:0" }, { settleRef: null }]), 0);
  assert.equal(
    generationCorrection([
      { settleRef: "caisse:sale-1:0" },
      { settleRef: "corr:caisse:sale-1:CASH-CARD:3000:g0:out" },
      { settleRef: "corr:caisse:sale-1:CASH-CARD:3000:g0:in" },
    ]),
    2,
  );
  assert.equal(
    generationCorrection([
      { settleRef: "corr:k1:out" },
      { settleRef: "corr:k1:in" },
      { settleRef: "corr:k2:out" },
      { settleRef: "corr:k2:in" },
    ]),
    4,
  );
});

// ─── Compléments : verifierCorrection (ordre des refus) et repartitionNette ───────────────────

test("verifierCorrection : SALE_NOT_FOUND en tête, avant toute autre règle", () => {
  const out = verifierCorrection(null, INPUT);
  assert.deepEqual(out, { ok: false, error: "SALE_NOT_FOUND" });
});

test("verifierCorrection : INVALID sur méthodes identiques ou montant non entier/≤0", () => {
  const sale = makeSale();
  assert.equal(verifierCorrection(sale, { fromMethod: "CASH", toMethod: "CASH", amountXpf: 100 }).error, "INVALID");
  assert.equal(verifierCorrection(sale, { fromMethod: "CASH", toMethod: "CARD", amountXpf: 0 }).error, "INVALID");
  assert.equal(verifierCorrection(sale, { fromMethod: "CASH", toMethod: "CARD", amountXpf: -100 }).error, "INVALID");
  assert.equal(verifierCorrection(sale, { fromMethod: "CASH", toMethod: "CARD", amountXpf: 100.5 }).error, "INVALID");
});

test("repartitionNette agrège les contre-écritures (un moyen à 0 net disparaît si absent en amont, sinon reste à 0)", () => {
  const net = repartitionNette([
    { method: "CASH", amountXpf: 8000n },
    { method: "CASH", amountXpf: -3000n },
    { method: "CARD", amountXpf: 3000n },
  ]);
  assert.deepEqual(
    net.sort((a, b) => a.method.localeCompare(b.method)),
    [
      { method: "CARD", amountXpf: 3000 },
      { method: "CASH", amountXpf: 5000 },
    ],
  );
});

// ─── 9. Moyen de paiement hors énumération → INVALID nommé, aucune écriture ───────────────────

test("verifierCorrection : fromMethod hors énumération → INVALID avec le moyen nommé dans le detail", () => {
  const sale = makeSale();
  const out = verifierCorrection(sale, { fromMethod: "BITCOIN", toMethod: "CARD", amountXpf: 100 });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error, "INVALID");
  assert.match(out.detail ?? "", /BITCOIN/);
});

test("verifierCorrection : toMethod hors énumération → INVALID avec le moyen nommé dans le detail", () => {
  const sale = makeSale();
  const out = verifierCorrection(sale, { fromMethod: "CASH", toMethod: "BITCOIN", amountXpf: 100 });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error, "INVALID");
  assert.match(out.detail ?? "", /BITCOIN/);
});

test("runPaymentCorrection : fromMethod inconnu → INVALID, aucune dépendance d'écriture appelée", async () => {
  const sale = makeSale();
  const { deps, calls } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, fromMethod: "BITCOIN", toMethod: "CARD", amountXpf: 5000 });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error, "INVALID");
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

test("runPaymentCorrection : toMethod inconnu → INVALID, aucune dépendance d'écriture appelée", async () => {
  const sale = makeSale();
  const { deps, calls } = makeDeps({ sale });
  const out = await runPaymentCorrection(deps, { saleId: sale.id, tenantId: TENANT, fromMethod: "CASH", toMethod: "BITCOIN", amountXpf: 5000 });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error, "INVALID");
  assert.equal(calls.comptaCorrection, 0);
  assert.equal(calls.insertCorrectionPayments, 0);
});

// ─── 10. Test STRUCTUREL : MOYENS_ADMIS reste aligné sur l'enum Prisma PayMethod ──────────────

test("MOYENS_ADMIS est exactement l'enum Prisma PayMethod (même patron que postes.test.ts)", () => {
  const schema = lire("..", "prisma", "schema.prisma");
  const match = schema.match(/enum PayMethod \{([^}]*)\}/);
  assert.ok(match, "enum PayMethod introuvable dans schema.prisma");
  const valeursSchema = match[1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
  const valeursCode = [...MOYENS_ADMIS].sort();
  assert.deepEqual(
    valeursCode,
    valeursSchema,
    "MOYENS_ADMIS (payment-correction.ts) a divergé de l'enum PayMethod (schema.prisma) — aligne les deux",
  );
});

// =============================================================================
// DÉFAUT 1 : LA COURSE — deux appels concurrents de `insertCorrectionPayments` (lib/caisse.ts)
// =============================================================================
// `SalePayment` n'a AUCUNE contrainte d'unicité sur `settleRef` (contrairement à `CashMovement.ref`
// ou au `Payment.ref` de Core-Compta) : sans verrou, rien en base n'empêche deux transactions
// concurrentes de lire le même `count = 0` en READ COMMITTED et d'écrire chacune son couple — le
// ticket porte alors la correction deux fois, sans qu'aucune erreur ne le signale.
//
// MÊME PATRON QUE `01-Core-Compta/core/lib/settle.test.ts`, test « (d)/(d bis) » : le faux modélise
// un verrou de ligne bloquant (`SELECT … FOR UPDATE`, ici sur `Sale`, cf. lib/sale-lock.ts) qui fait
// attendre la seconde transaction jusqu'à la FIN (commit) de la première — elle relit alors un
// `count` à jour au lieu d'un instantané périmé. `serialize:false` ≡ le verrou retiré : c'est
// exactement ce qu'on obtiendrait en supprimant l'appel à `lockSaleRow` dans
// `insertCorrectionPayments` (lib/caisse.ts).
//
// Mutation figée dans la suite : si un jour le test « SANS verrou » ci-dessous passe à 1 couple, ou
// si le test « AVEC verrou » se met à en écrire 2, c'est que le faux ne modélise plus la course —
// et que ni l'un ni l'autre ne prouve plus rien.
// =============================================================================

type FakeSalePayment = { method: string; amountXpf: bigint; settleRef: string | null };

/**
 * Modélise EXACTEMENT l'algorithme de `insertCorrectionPayments` (lib/caisse.ts) : verrou de ligne
 * `Sale` (si `serialize`) PUIS `count(settleRef)` PUIS deux `create`, avec la sémantique READ
 * COMMITTED (une transaction ne voit pas les écritures NON COMMITÉES d'une autre).
 */
function makeSaleWriteDb(opts: { serialize?: boolean } = {}) {
  const serialize = opts.serialize ?? true;
  const committed: FakeSalePayment[] = [];
  let lockQueue: Promise<void> | null = null;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function insertCorrectionPayments(args: InsertCorrectionPaymentsArgs): Promise<{ inserted: boolean }> {
    // 1. VERROU DE LIGNE — PREMIÈRE opération, comme dans lib/caisse.ts. `lockSaleRow` fait
    //    attendre la transaction courante jusqu'au COMMIT de celle qui détient déjà le verrou.
    let releaseLock: (() => void) | null = null;
    if (serialize) {
      const previous = lockQueue;
      let signal!: () => void;
      lockQueue = new Promise<void>((resolve) => (signal = resolve));
      releaseLock = signal;
      if (previous) await previous; // FOR UPDATE : attend la fin (commit) du détenteur précédent.
    } else {
      // Sans verrou, les deux appels sont réellement entrelacés avant leur lecture — c'est la
      // course de production (Promise.all + `tick()` pour garantir l'entrelacement).
      await tick();
    }

    // 2. LECTURE (count) — l'instantané visible à CET instant. Avec le verrou, cette lecture a
    //    lieu APRÈS le commit du précédent détenteur : elle est donc à jour. Sans verrou, elle
    //    peut avoir lieu AVANT que l'autre appel n'ait rien commité : instantané périmé.
    const deja = committed.filter((p) => p.settleRef === args.sortie).length;
    // Gap `count` → `create` (deux allers-retours réseau réels vers Postgres) : c'est PENDANT ce
    // gap qu'une transaction concurrente non bloquée s'intercale en READ COMMITTED. Sans ce point
    // d'`await`, le faux ne modéliserait qu'une opération atomique et ne prouverait rien.
    await tick();

    if (deja > 0) {
      releaseLock?.();
      return { inserted: false };
    }

    // 3. ÉCRITURE — les deux `create`, commités immédiatement (pas de rollback à modéliser ici :
    //    `insertCorrectionPayments` ne peut pas échouer côté logique, contrairement au `Payment` de
    //    Compta qui a un index unique à violer).
    committed.push({ method: args.fromMethod, amountXpf: -BigInt(args.amountXpf), settleRef: args.sortie });
    committed.push({ method: args.toMethod, amountXpf: BigInt(args.amountXpf), settleRef: args.entree });
    releaseLock?.();
    return { inserted: true };
  }

  return { insertCorrectionPayments, payments: committed };
}

test("LA COURSE, avec verrou de ligne : deux exécutions CONCURRENTES de insertCorrectionPayments n'écrivent qu'UN couple", async () => {
  const db = makeSaleWriteDb();
  const args: InsertCorrectionPaymentsArgs = {
    saleId: "sale-1",
    fromMethod: "CASH",
    toMethod: "CARD",
    amountXpf: 5000,
    sortie: "corr:caisse:sale-1:CASH-CARD:5000:g0:out",
    entree: "corr:caisse:sale-1:CASH-CARD:5000:g0:in",
  };

  // Promise.all : les deux appels sont réellement entrelacés, comme deux requêtes HTTP simultanées
  // sur la même correction (double-clic, retry réseau, deux caissières sur le même ticket).
  const [r1, r2] = await Promise.all([db.insertCorrectionPayments(args), db.insertCorrectionPayments(args)]);

  assert.equal(db.payments.length, 2, "un SEUL couple (2 SalePayment) doit exister — pas 4");
  const inserted = [r1, r2].filter((r) => r.inserted);
  assert.equal(inserted.length, 1, "un et un seul appel doit avoir écrit");
});

test("(preuve de mutation) LA MÊME COURSE, SANS le verrou de ligne : insertCorrectionPayments écrit DEUX couples", async () => {
  // Mutation figée : `serialize:false` ≡ retirer l'appel à `lockSaleRow` dans lib/caisse.ts. Si ce
  // test se met à ne voir qu'un couple, c'est que le faux ne modélise plus la course, et que le
  // test précédent (avec verrou) ne prouve plus rien.
  const db = makeSaleWriteDb({ serialize: false });
  const args: InsertCorrectionPaymentsArgs = {
    saleId: "sale-1",
    fromMethod: "CASH",
    toMethod: "CARD",
    amountXpf: 5000,
    sortie: "corr:caisse:sale-1:CASH-CARD:5000:g0:out",
    entree: "corr:caisse:sale-1:CASH-CARD:5000:g0:in",
  };

  const [r1, r2] = await Promise.all([db.insertCorrectionPayments(args), db.insertCorrectionPayments(args)]);

  assert.equal(db.payments.length, 4, "SANS verrou : DEUX couples écrits (4 lignes) — le ticket porte la correction deux fois");
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, true, "les deux appels se croient chacun le premier : aucune erreur ne le signale");
});
