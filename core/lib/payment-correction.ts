// lib/payment-correction.ts — CORRECTION DU MOYEN DE PAIEMENT d'un ticket déjà encaissé (pur, sans
// DB) — même schéma que lib/void-sale.ts : dépendances injectées (client Compta + persistance) →
// testable sans DB ni HTTP.
//
// CONTEXTE : la gérante s'est trompée de moyen de paiement en encaissant (« espèces » au lieu de
// « carte »). `SalePayment` n'est JAMAIS modifié : on écrit une CONTRE-ÉCRITURE, un paiement négatif
// sur l'ancien moyen et un positif sur le nouveau. INVARIANT : la somme des paiements du ticket ne
// bouge pas — seule la répartition par moyen change. `Sale.totalXpf` et le CA sont donc intacts, et
// l'attendu du Z d'une session encore OUVERTE (openingFloat + Σ CASH, cf. closeSession) se corrige
// TOUT SEUL, par construction, à sa prochaine clôture.
//
// ORDRE DES ÉCRITURES (même raison que void-sale.ts) : LA COMPTABILITÉ D'ABORD, LA CAISSE ENSUITE.
// Une caisse qui dit « carte » pendant que la comptabilité dit encore « espèces » est le pire des
// deux états. Si l'écriture comptable échoue, on n'écrit rien côté caisse.

import type { ComptaClient } from "./clients";
import { estDansLaFenetre } from "./fenetre-correction.ts";

export type CorrectionMethod = "CASH" | "CARD" | "TRANSFER" | "CHEQUE" | "OTHER";

/**
 * Moyens admis pour une correction — DOIT rester aligné sur l'enum Prisma `PayMethod`
 * (`prisma/schema.prisma` ~l.45). Un désalignement est couvert par un test structurel dans
 * `payment-correction.test.ts` qui relit `schema.prisma` en texte (même patron que `postes.test.ts`).
 */
export const MOYENS_ADMIS = ["CASH", "CARD", "TRANSFER", "CHEQUE", "OTHER"] as const;

export function estMoyenAdmis(m: string): m is CorrectionMethod {
  return (MOYENS_ADMIS as readonly string[]).includes(m);
}

/** Photo de la vente nécessaire à la correction (chargée sous withTenant par l'appelant). */
export type SaleSnapshotForCorrection = {
  id: string;
  status: "DRAFT" | "PAID" | "VOID";
  sessionId: string | null;
  sessionStatus: "OPEN" | "CLOSED" | null; // null = la vente n'est rattachée à aucune session
  comptaSyncedAt: Date | null;
  invoiceId: string | null;
  /** Date RÉELLE de l'encaissement — sert de point de départ à la fenêtre de correction (1 mois
   *  calendaire, cf. lib/fenetre-correction.ts). `paidAt` peut être `null` sur une très vieille
   *  vente antérieure à l'ajout du champ : `loadSale` retombe alors sur `createdAt`. */
  paidAt: Date | null;
  createdAt: Date;
  payments: { method: string; amountXpf: bigint; settleRef: string | null }[];
};

export type CorrectionRefusal =
  | "SALE_NOT_FOUND"
  | "NOT_PAID"
  | "NO_INVOICE"
  | "NOT_SYNCED"
  | "TOO_OLD"
  | "NOTHING_TO_CORRECT"
  | "INVALID";

/**
 * Clé DÉTERMINISTE de la correction — jamais `Date.now()`, jamais d'aléatoire : c'est ce qui rend
 * le rejeu sûr (deux appels identiques produisent la même clé, donc les mêmes `settleRef`).
 *
 * `generation` DISTINGUE un aller-retour du même couple de moyens sur le même ticket. Sans elle,
 * l'enchaînement réel Espèces→Carte, puis Carte→Espèces (erreur), puis à nouveau Espèces→Carte
 * retombe à la 3ᵉ correction sur la MÊME clé que la 1ʳᵉ : les `settleRef` existent déjà,
 * `insertCorrectionPayments` répond `inserted:false`, et l'écran annonce un succès sans avoir rien
 * écrit — le ticket reste faux. Avec `generation`, chaque correction SÉQUENTIELLE voit une clé
 * différente (cf. `runPaymentCorrection`, qui la dérive du nombre de `settleRef` de correction déjà
 * présents sur la vente).
 *
 * SÛRETÉ EN CONCURRENCE : deux appels VRAIMENT simultanés sur le même couple de moyens lisent la
 * MÊME photo de la vente (même snapshot chargé par `loadSale`) donc calculent la MÊME `generation`
 * et produisent donc la MÊME clé — c'est l'index unique `(invoiceId, ref)` de Core-Compta (et le
 * verrou de ligne côté caisse, cf. lib/sale-lock.ts) qui les départage ensuite, exactement comme
 * avant l'ajout de `generation`. Ce qui change de génération, ce sont deux corrections
 * SÉQUENTIELLES (l'aller-retour) : chacune relit la vente et voit l'écriture de la précédente.
 */
export function correctionKeyPour(
  saleId: string,
  fromMethod: string,
  toMethod: string,
  amountXpf: number,
  generation: number,
): string {
  return `caisse:${saleId}:${fromMethod}-${toMethod}:${amountXpf}:g${generation}`;
}

/**
 * Génération de la correction — le nombre de `SalePayment` de la vente dont le `settleRef` porte
 * déjà le préfixe `corr:` (cf. `refsDeLaCorrection`). 0 avant toute correction, 2 après la
 * première (une sortie + une entrée), 4 après la deuxième, etc. Lue depuis le snapshot déjà chargé
 * par `loadSale` — AUCUNE requête supplémentaire.
 */
export function generationCorrection(payments: { settleRef: string | null }[]): number {
  return payments.filter((p) => p.settleRef?.startsWith("corr:")).length;
}

/**
 * Dérive les deux références de règlement à partir de la clé de correction.
 *
 * ⚠️ CES CHAÎNES SONT EXACTEMENT CELLES QUE CORE-COMPTA UTILISERA COMME `Payment.ref` (index unique
 * `(invoiceId, ref)`), et on les réutilise TELLES QUELLES comme `SalePayment.settleRef`. C'est voulu
 * et load-bearing : si le cron `repair-sales` rejouait un jour `runSaleSync` sur cette vente, le
 * `settle` du montant négatif retomberait sur une `ref` déjà connue de Compta et serait absorbé en
 * « déjà payé » au lieu d'écrire un doublon.
 */
export function refsDeLaCorrection(correctionKey: string): { sortie: string; entree: string } {
  return { sortie: `corr:${correctionKey}:out`, entree: `corr:${correctionKey}:in` };
}

/** Répartition NETTE (Σ amountXpf) par moyen de paiement — les contre-écritures s'y résorbent. */
export function repartitionNette(payments: { method: string; amountXpf: bigint }[]): { method: string; amountXpf: number }[] {
  const net = new Map<string, bigint>();
  for (const p of payments) {
    net.set(p.method, (net.get(p.method) ?? 0n) + p.amountXpf);
  }
  return Array.from(net.entries()).map(([method, amountXpf]) => ({ method, amountXpf: Number(amountXpf) }));
}

/**
 * Valide une demande de correction contre l'état chargé de la vente, DANS CET ORDRE — l'ordre décide
 * du message que la gérante lira.
 */
export function verifierCorrection(
  sale: SaleSnapshotForCorrection | null,
  input: { fromMethod: string; toMethod: string; amountXpf: number },
  maintenant: Date = new Date(),
): { ok: false; error: CorrectionRefusal; detail?: string } | { ok: true } {
  if (sale == null) return { ok: false, error: "SALE_NOT_FOUND" };

  if (
    !input.fromMethod ||
    !input.toMethod ||
    input.fromMethod === input.toMethod ||
    !Number.isInteger(input.amountXpf) ||
    input.amountXpf <= 0
  ) {
    return { ok: false, error: "INVALID" };
  }

  if (!estMoyenAdmis(input.fromMethod)) {
    return { ok: false, error: "INVALID", detail: `moyen de paiement inconnu : ${input.fromMethod}` };
  }
  if (!estMoyenAdmis(input.toMethod)) {
    return { ok: false, error: "INVALID", detail: `moyen de paiement inconnu : ${input.toMethod}` };
  }

  if (sale.status !== "PAID") return { ok: false, error: "NOT_PAID" };
  if (sale.invoiceId == null) return { ok: false, error: "NO_INVOICE" };
  // La vente n'est pas encore remontée en comptabilité : le cron de reprise doit finir son travail
  // avant qu'on corrige quoi que ce soit (sinon la correction partirait sur une facture qui n'existe
  // pas encore côté Compta).
  if (sale.comptaSyncedAt == null) return { ok: false, error: "NOT_SYNCED" };

  // 🔓 LA CAISSE CLÔTURÉE NE BLOQUE PLUS LA CORRECTION (décision Marco, 2026-08-26, verbatim) :
  // « le moyen de paiement n'est pas très important. tant que le montant ne change pas. corrections
  // jusqu'à 1 mois plus tard. ça se voit au recomptage de la caisse de toute façon. »
  //
  // Le Z d'une journée close N'EST PAS RÉÉCRIT : il reste tel qu'il a été arrêté (`closingCountedXpf`
  // et `varianceXpf` figés à la clôture, `expectedXpf` figé lui aussi depuis ce chantier — cf.
  // lib/z-report.ts#expectedXpfPourRapport) ; un écart révélé par une correction tardive se CONSTATE
  // au recomptage suivant, il ne se corrige pas rétroactivement sur un Z déjà arrêté. Une session
  // encore OUVERTE, elle, voit son attendu se recalculer normalement à sa prochaine clôture
  // (`closeSession` resomme les `SalePayment` de méthode CASH) : ce comportement ne change pas.
  //
  // Ce qui remplace la garde de prudence retirée ici : la fenêtre de temps ci-dessous (TOO_OLD).

  // FENÊTRE DE CORRECTION — 1 mois calendaire depuis l'encaissement (lib/fenetre-correction.ts).
  // `paidAt` peut être `null` sur une très vieille vente (antérieure au champ) : `createdAt` sert
  // alors de repère, comme point de départ le plus proche disponible de l'encaissement réel.
  const origineCorrection = sale.paidAt ?? sale.createdAt;
  if (!estDansLaFenetre(origineCorrection, maintenant)) return { ok: false, error: "TOO_OLD" };

  const net = repartitionNette(sale.payments);
  const fromNet = net.find((p) => p.method === input.fromMethod)?.amountXpf ?? 0;
  if (fromNet < input.amountXpf) return { ok: false, error: "NOTHING_TO_CORRECT" };

  return { ok: true };
}

export type CorrectionResult =
  | { ok: false; error: CorrectionRefusal; detail?: string }
  | { ok: false; error: "COMPTA_CORRECTION_FAILED"; detail: string }
  | { ok: true; alreadyCorrected: boolean; payments: { method: string; amountXpf: number }[] };

export type ComptaCorrectionArgs = {
  tenantId: string;
  invoiceId: string;
  fromMethod: string;
  toMethod: string;
  amountXpf: number;
  correctionKey: string;
};

export type InsertCorrectionPaymentsArgs = {
  saleId: string;
  fromMethod: string;
  toMethod: string;
  amountXpf: number;
  sortie: string;
  entree: string;
};

export type PaymentCorrectionDeps = {
  loadSale(saleId: string): Promise<SaleSnapshotForCorrection | null>;
  comptaCorrection(args: ComptaCorrectionArgs): Promise<unknown>;
  /** Rend `true` si les deux `SalePayment` ont été créés, `false` si déjà présents (rejeu). */
  insertCorrectionPayments(args: InsertCorrectionPaymentsArgs): Promise<{ inserted: boolean }>;
};

export type PaymentCorrectionInput = {
  saleId: string;
  tenantId: string;
  fromMethod: string;
  toMethod: string;
  amountXpf: number;
  /** Injecté (défaut `new Date()`) — sert la fenêtre de correction (TOO_OLD, cf. verifierCorrection). */
  maintenant?: Date;
};

/**
 * Exécute une correction de moyen de paiement par contre-écriture. N'écrit RIEN si `verifierCorrection`
 * refuse. La comptabilité est corrigée AVANT la caisse (cf. en-tête du fichier) ; si elle échoue,
 * rien n'est écrit côté caisse. Rejeu sûr : si le `settleRef` de sortie existe déjà, rend
 * `alreadyCorrected:true` sans réécrire (`comptaCorrection` peut être rappelée, elle est idempotente
 * côté Compta).
 */
export async function runPaymentCorrection(
  deps: PaymentCorrectionDeps,
  input: PaymentCorrectionInput,
): Promise<CorrectionResult> {
  const sale = await deps.loadSale(input.saleId);
  const verif = verifierCorrection(sale, input, input.maintenant ?? new Date());
  if (!verif.ok) return verif;

  const generation = generationCorrection(sale!.payments);
  const correctionKey = correctionKeyPour(input.saleId, input.fromMethod, input.toMethod, input.amountXpf, generation);
  const { sortie, entree } = refsDeLaCorrection(correctionKey);

  // LA COMPTABILITÉ D'ABORD (cf. en-tête). `sale.invoiceId` est non-null ici : `verifierCorrection`
  // a déjà refusé NO_INVOICE.
  try {
    await deps.comptaCorrection({
      tenantId: input.tenantId,
      invoiceId: sale!.invoiceId as string,
      fromMethod: input.fromMethod,
      toMethod: input.toMethod,
      amountXpf: input.amountXpf,
      correctionKey,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "COMPTA_CORRECTION_FAILED", detail };
  }

  const { inserted } = await deps.insertCorrectionPayments({
    saleId: input.saleId,
    fromMethod: input.fromMethod,
    toMethod: input.toMethod,
    amountXpf: input.amountXpf,
    sortie,
    entree,
  });

  // Répartition rendue : nette AVANT la contre-écriture si elle n'a pas eu lieu (rejeu), sinon après.
  // `sale.payments` est la photo chargée AVANT correction : quand `inserted` est vrai on projette la
  // contre-écriture par-dessus pour rendre l'état réel post-écriture sans recharger la vente.
  const payments = inserted
    ? repartitionNette([
        ...sale!.payments,
        { method: input.fromMethod, amountXpf: -BigInt(input.amountXpf) },
        { method: input.toMethod, amountXpf: BigInt(input.amountXpf) },
      ])
    : repartitionNette(sale!.payments);

  return { ok: true, alreadyCorrected: !inserted, payments };
}
