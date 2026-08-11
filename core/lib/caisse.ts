// lib/caisse.ts — logique métier du moteur de caisse (POS).
//
// Responsabilités :
//   1. Sessions de caisse : ouverture (fond de caisse), clôture Z (attendu vs compté, écart).
//   2. Tickets : composition (lignes), calcul des totaux (XPF entier).
//   3. Encaissement : paiements offline (mixtes), rendu monnaie, puis ORCHESTRATION des autres cores.
//
// La caisse ne refait NI la compta NI l'inventaire : à la validation elle POUSSE une facture + un
// paiement à Core-Compta et DÉCRÉMENTE Core-Stock. Tout est idempotent de bout en bout : rejouer un
// checkout ne double NI la facture (idempotence sourceType="caisse"+sourceId=saleId côté Compta) NI le
// stock (idempotence tenantId+sourceType+sourceId côté Stock) NI les paiements (paymentRef déterministe).
//
// FIABILITÉ (2026-07) : la vente passe PAID dès le paiement validé (l'argent est pris), PUIS la synchro
// Compta/Stock converge (moteur lib/sync.ts). Un échec S2S post-encaissement ne bloque plus le ticket :
// il est tracé sur la vente (comptaSyncedAt/stockSyncedAt/syncError) et repris par repairSale
// (endpoint /api/sales/:id/repair + balayage /api/cron/repair-sales).

import { withTenant } from "./tenant";
import { comptaClient, stockClient } from "./clients";
import { log } from "./log";
import { computeChange, lineTotalXpf, normalizePayments } from "./money";
import {
  expectedCashXpf,
  summarizeMovements,
  type CashMovementKind,
  type CashMovementLike,
} from "./cash-movement";
import {
  summarizeRedeemedGiftCards,
  validateGiftCard,
  validateGiftCards,
  type GiftCardCancelRefusal,
  type GiftCardData,
  type GiftCardInput,
  type GiftCardRedeemRefusal,
  type GiftCardRefusal,
} from "./gift-card";
import { runSaleSync, CAISSE_SOURCE_TYPE, type SyncOutcome, type SyncPersist, type SyncSaleSnapshot } from "./sync";
import { Prisma, type LineKind, type PayMethod, type SaleStatus } from "@prisma/client";

// Ré-export du helper pur (rendu monnaie) — testé unitairement via lib/money.ts.
export { computeChange } from "./money";

// sourceType constant utilisé dans les appels sortants (idempotence) — défini dans lib/sync.ts.
export { CAISSE_SOURCE_TYPE } from "./sync";

// ─── Sessions de caisse ──────────────────────────────────────────────────────

export async function openSession(
  tenantId: string,
  input: { openedBy: string; openedByName?: string; openingFloatXpf: bigint; note?: string },
) {
  return withTenant(tenantId, async (tx) => {
    // Une seule session OPEN à la fois par tenant (garde métier simple).
    const existing = await tx.cashSession.findFirst({
      where: { tenantId, status: "OPEN" },
      select: { id: true },
    });
    if (existing) return { ok: false as const, error: "SESSION_ALREADY_OPEN" as const, sessionId: existing.id };

    const session = await tx.cashSession.create({
      data: {
        tenantId,
        openedBy: input.openedBy,
        openedByName: input.openedByName ?? null,
        openingFloatXpf: input.openingFloatXpf,
        note: input.note ?? null,
      },
    });
    return { ok: true as const, session };
  });
}

/** Session OPEN courante du tenant (ou null). */
export async function currentSession(tenantId: string) {
  return withTenant(tenantId, (tx) =>
    tx.cashSession.findFirst({ where: { tenantId, status: "OPEN" }, orderBy: { openedAt: "desc" } }),
  );
}

export type ZReport = {
  sessionId: string;
  openingFloatXpf: number;
  cashSalesXpf: number; // encaissements ESPÈCES rattachés (payés)
  expectedXpf: number; // fond + espèces
  countedXpf: number; // compté à la clôture
  varianceXpf: number; // compté - attendu
  salesCount: number;
  totalSalesXpf: number; // CA total de la session (tous moyens de paiement)
  byMethod: Record<string, number>;
  // ── Mouvements de tiroir (chantier « ecart de caisse », 2026-08-05) ────────────────
  // Trois postes SEPARES et POSITIFS : ils expliquent l'ecart, ils ne le noient pas dans
  // un net opaque. Ils entrent dans `expectedXpf` et n'entrent PAS dans `totalSalesXpf` :
  // un remboursement est de la tresorerie, pas du chiffre d'affaires.
  refundsXpf: number; // remboursements d'avoirs sortis du tiroir
  cashOutXpf: number; // prelevements (depot en banque, achat)
  cashInXpf: number; // apports de fond en cours de journee
  // ── Bons cadeaux consommés (PC-0064, 2026-08-11) ───────────────────────────────────
  // 🔒 DEUX CHAMPS PUREMENT INFORMATIFS. Ils n'entrent NI dans `totalSalesXpf`, NI dans
  // `expectedXpf` — et ce n'est pas une discipline de relecture, c'est une propriete des
  // SIGNATURES : `expectedCashXpf` ne recoit pas de bons, `summarizeRedeemedGiftCards` ne
  // rend rien qui puisse y entrer. Consommer un bon n'a AUCUNE comptabilite : ni facture,
  // ni paiement, ni mouvement de tiroir. Le montant d'un bon est entre dans le CA UNE
  // SEULE FOIS, le jour ou le bon a ete VENDU. Le rappeler ici sert a expliquer pourquoi
  // des prestations ont ete rendues sans qu'un franc entre dans le tiroir — pas a les
  // compter une seconde fois.
  giftCardRedeemedCount: number; // combien de prestations reglees par un bon
  giftCardRedeemedXpf: number; // leur valeur faciale, DEJA encaissee a la vente des bons
};

/**
 * Clôture Z d'une session : calcule l'attendu (fond + encaissements ESPÈCES des ventes PAID de la
 * session) vs le compté (saisie caissier), enregistre l'écart, passe la session CLOSED.
 * Idempotent : une session déjà CLOSED renvoie son rapport figé.
 */
export async function closeSession(
  tenantId: string,
  input: { sessionId: string; closedBy: string; closedByName?: string; closingCountedXpf: bigint },
): Promise<{ ok: false; error: "SESSION_NOT_FOUND" } | { ok: true; report: ZReport; alreadyClosed: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const session = await tx.cashSession.findFirst({ where: { id: input.sessionId, tenantId } });
    if (!session) return { ok: false as const, error: "SESSION_NOT_FOUND" as const };

    // Ventes PAID de la session + leurs paiements.
    const sales = await tx.sale.findMany({
      where: { tenantId, sessionId: session.id, status: "PAID" },
      include: { payments: true },
    });

    const byMethod: Record<string, bigint> = {};
    let cashSales = 0n;
    let totalSales = 0n;
    for (const s of sales) {
      totalSales += s.totalXpf;
      for (const p of s.payments) {
        byMethod[p.method] = (byMethod[p.method] ?? 0n) + p.amountXpf;
        if (p.method === "CASH") cashSales += p.amountXpf;
      }
    }

    // Les mouvements de tiroir de la session (remboursements, prelevements, apports).
    // Sans eux, un avoir rendu en especes produisait un ecart MUET au Z.
    const movements: CashMovementLike[] = (
      await tx.cashMovement.findMany({
        where: { tenantId, sessionId: session.id },
        select: { kind: true, amountXpf: true },
      })
    ).map((m) => ({ kind: m.kind as CashMovementKind, amountXpf: m.amountXpf }));

    const mv = summarizeMovements(movements);
    const expected = expectedCashXpf({
      openingFloatXpf: session.openingFloatXpf,
      cashSalesXpf: cashSales,
      movements,
    });

    // Bons cadeaux CONSOMMES pendant la fenetre de la session — information seule.
    // ⚠️ Le rattachement se fait par FENETRE DE TEMPS sur `redeemedAt`, et il n'existe
    // deliberement AUCUNE cle etrangere de `GiftCard` vers `CashSession` : une consommation
    // n'est PAS une operation de caisse, elle n'a aucune comptabilite. Une FK laisserait
    // croire le contraire, et rendrait tentant de l'additionner quelque part.
    // Borne haute = `closedAt` s'il existe (une session deja close doit rendre le MEME
    // rapport a chaque relecture) ; sinon aucune, rien n'est consomme dans le futur.
    const redeemedCards = await tx.giftCard.findMany({
      where: {
        tenantId,
        redeemedAt: session.closedAt
          ? { gte: session.openedAt, lte: session.closedAt }
          : { gte: session.openedAt },
      },
      select: { amountXpf: true },
    });
    const gc = summarizeRedeemedGiftCards(redeemedCards);

    const buildReport = (counted: bigint, variance: bigint): ZReport => ({
      sessionId: session.id,
      openingFloatXpf: Number(session.openingFloatXpf),
      cashSalesXpf: Number(cashSales),
      expectedXpf: Number(expected),
      countedXpf: Number(counted),
      varianceXpf: Number(variance),
      salesCount: sales.length,
      totalSalesXpf: Number(totalSales),
      byMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, Number(v)])),
      refundsXpf: Number(mv.refundsXpf),
      cashOutXpf: Number(mv.cashOutXpf),
      cashInXpf: Number(mv.cashInXpf),
      // Informatifs, et volontairement absents de `expectedXpf` comme de `totalSalesXpf`
      // (les deux lignes ci-dessus, `expected` et `totalSales`, ne les ont jamais vus).
      giftCardRedeemedCount: gc.giftCardRedeemedCount,
      giftCardRedeemedXpf: Number(gc.giftCardRedeemedXpf),
    });

    if (session.status === "CLOSED") {
      // déjà clôturée : renvoyer l'écart figé enregistré
      return {
        ok: true as const,
        alreadyClosed: true,
        report: buildReport(session.closingCountedXpf ?? 0n, session.varianceXpf ?? 0n),
      };
    }

    const variance = input.closingCountedXpf - expected;
    await tx.cashSession.update({
      where: { id: session.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        closedBy: input.closedBy,
        closedByName: input.closedByName ?? null,
        closingCountedXpf: input.closingCountedXpf,
        expectedXpf: expected,
        varianceXpf: variance,
      },
    });

    return { ok: true as const, alreadyClosed: false, report: buildReport(input.closingCountedXpf, variance) };
  });
}

// ─── Tickets ─────────────────────────────────────────────────────────────────

export type SaleLineInput = {
  kind: LineKind;
  label: string;
  productId?: string | null; // requis si kind=PRODUCT
  qty: number;
  unitXpf: bigint;
};

export type CreateSaleInput = {
  cashierId?: string;
  sessionId?: string | null;
  clientName?: string | null;
  lines: SaleLineInput[];
  sourceType?: string | null;
  sourceId?: string | null;
};

/**
 * Crée un ticket (statut DRAFT) avec ses lignes et calcule les totaux (figés).
 * Idempotent sur (sourceType, sourceId) quand fournis (ex : un RDV honoré ne crée qu'un ticket).
 */
export async function createSale(
  tenantId: string,
  input: CreateSaleInput,
): Promise<
  | { ok: false; error: "EMPTY" | "PRODUCT_LINE_WITHOUT_PRODUCT" | "INVALID_QTY" }
  | { ok: true; saleId: string; totalXpf: number; alreadyExisted: boolean }
> {
  if (!input.lines || input.lines.length === 0) return { ok: false, error: "EMPTY" };
  for (const l of input.lines) {
    if (l.kind === "PRODUCT" && !l.productId) return { ok: false, error: "PRODUCT_LINE_WITHOUT_PRODUCT" };
    if (!Number.isFinite(l.qty) || Math.trunc(l.qty) <= 0) return { ok: false, error: "INVALID_QTY" };
  }

  const linesData = input.lines.map((l) => ({
    tenantId,
    kind: l.kind,
    label: l.label,
    productId: l.kind === "PRODUCT" ? l.productId ?? null : null,
    qty: Math.trunc(l.qty),
    unitXpf: l.unitXpf,
    lineXpf: lineTotalXpf(l.unitXpf, l.qty),
  }));
  const total = linesData.reduce((t, l) => t + l.lineXpf, 0n);

  return withTenant(tenantId, async (tx) => {
    // Idempotence source externe
    if (input.sourceType && input.sourceId) {
      const existing = await tx.sale.findFirst({
        where: { tenantId, sourceType: input.sourceType, sourceId: input.sourceId },
        select: { id: true, totalXpf: true },
      });
      if (existing) {
        return { ok: true as const, saleId: existing.id, totalXpf: Number(existing.totalXpf), alreadyExisted: true };
      }
    }

    try {
      const sale = await tx.sale.create({
        data: {
          tenantId,
          sessionId: input.sessionId ?? null,
          cashierId: input.cashierId ?? null,
          clientName: input.clientName ?? null,
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          subtotalXpf: total,
          totalXpf: total,
          lines: { create: linesData },
        },
        select: { id: true, totalXpf: true },
      });
      return { ok: true as const, saleId: sale.id, totalXpf: Number(sale.totalXpf), alreadyExisted: false };
    } catch (e) {
      // Course sur l'index unique partiel uniq_sale_external_source → retomber sur l'existant.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        input.sourceType &&
        input.sourceId
      ) {
        const existing = await tx.sale.findFirst({
          where: { tenantId, sourceType: input.sourceType, sourceId: input.sourceId },
          select: { id: true, totalXpf: true },
        });
        if (existing) {
          return { ok: true as const, saleId: existing.id, totalXpf: Number(existing.totalXpf), alreadyExisted: true };
        }
      }
      throw e;
    }
  });
}

export async function getSale(tenantId: string, saleId: string) {
  return withTenant(tenantId, (tx) =>
    tx.sale.findFirst({ where: { id: saleId, tenantId }, include: { lines: true, payments: true } }),
  );
}

// ─── Encaissement (le cœur) ──────────────────────────────────────────────────

export type PaymentInput = {
  method: PayMethod;
  amountXpf: bigint; // montant imputé à la vente
  tenderedXpf?: bigint; // remis par le client (espèces) → sert au rendu monnaie
};

/**
 * Options d'encaissement. TOUT y est facultatif, et ce paramètre l'est lui-même : un appel
 * `checkoutSale(tenantId, saleId, payments)` se comporte exactement comme avant PC-0064.
 */
export type CheckoutOptions = {
  /**
   * Bons cadeaux à faire naître DANS la transaction du passage à PAID.
   *
   * Un bon cadeau est une PRESTATION VENDUE À L'AVANCE : son achat est le jumeau d'une vente
   * au comptoir (argent encaissé, Z qui le compte, facture au nom de l'acheteur). Il n'y a
   * donc pas de chemin d'encaissement parallèle — c'est ce même `checkoutSale`, avec ce
   * champ en plus.
   */
  giftCards?: GiftCardInput[];
};

export type CheckoutResult = {
  ok: true;
  saleId: string;
  status: SaleStatus;
  invoiceId: string | null; // null si la facture Compta n'a pas encore pu être créée (syncPending)
  invoiceNumber: string | null;
  totalXpf: number;
  paidXpf: number;
  changeXpf: number; // rendu monnaie total (Σ tendered - Σ amount, borné à ≥0)
  receiptUrl: string | null; // URL S2S du ticket PDF (Core-Compta) — null tant que la facture manque
  stockDecremented: number; // nb de lignes PRODUCT décrémentées
  syncPending: boolean; // true = Compta/Stock pas encore convergés (reprise auto par cron/repair)
  syncError: string | null; // dernière erreur de synchro (trace exploitable)
  alreadyPaid: boolean;
  // Bons cadeaux nés de CETTE vente (PC-0064). ABSENT du résultat quand il n'y en a pas — et
  // c'est délibéré : les surfaces qui n'émettent pas de bons (V-Cut, Ellément) reçoivent une
  // réponse rigoureusement identique à celle d'avant ce chantier, au champ près.
  giftCards?: GiftCardIssued[];
};

/** Un bon tel que la surface a besoin de le voir pour l'imprimer ou l'afficher. */
export type GiftCardIssued = {
  id: string;
  code: string;
  amountXpf: number;
  serviceLabel: string | null;
  expiresAt: string | null;
  beneficiaryName: string | null;
};

export type CheckoutError =
  | { ok: false; error: "SALE_NOT_FOUND" }
  | { ok: false; error: "ALREADY_VOID" }
  | { ok: false; error: "NO_PAYMENT" }
  | { ok: false; error: "UNDERPAID"; totalXpf: number; paidXpf: number }
  // Excédent sur une méthode qui ne rend pas la monnaie (carte/virement/chèque) : c'est
  // une saisie fausse, pas un rendu. Les espèces en trop, elles, ne sont JAMAIS une
  // erreur — le moteur impute le dû et rend la différence.
  | { ok: false; error: "OVERPAID"; method: string; excessXpf: number; totalXpf: number }
  // Bons cadeaux (PC-0064) : les DEUX refus tombent AVANT que le moindre franc soit acté.
  // C'est la seule place tenable — un bon refusé après l'encaissement laisserait une vente
  // payée sans le bon qu'elle a vendu, c'est-à-dire de l'argent pris pour rien.
  | { ok: false; error: "GIFT_CARD_INVALID"; reason: GiftCardRefusal | "DUPLICATE_CODE"; index: number }
  | { ok: false; error: "GIFT_CARD_CODE_TAKEN"; code: string };

// ─── Synchronisation Compta/Stock (moteur lib/sync.ts branché sur Prisma) ───

type LoadedSale = NonNullable<Awaited<ReturnType<typeof getSale>>>;

function toSnapshot(sale: LoadedSale): SyncSaleSnapshot {
  return {
    id: sale.id,
    tenantId: sale.tenantId,
    clientName: sale.clientName,
    cashierId: sale.cashierId,
    invoiceId: sale.invoiceId,
    invoiceNumber: sale.invoiceNumber,
    comptaSyncedAt: sale.comptaSyncedAt,
    stockSyncedAt: sale.stockSyncedAt,
    lines: sale.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      label: l.label,
      productId: l.productId,
      qty: l.qty,
      unitXpf: l.unitXpf,
    })),
    payments: sale.payments.map((p) => ({
      id: p.id,
      method: p.method,
      amountXpf: p.amountXpf,
      settleRef: p.settleRef,
    })),
  };
}

function persistFor(tenantId: string, saleId: string): SyncPersist {
  const update = (data: Prisma.SaleUpdateInput) =>
    withTenant(tenantId, (tx) => tx.sale.update({ where: { id: saleId }, data })).then(() => undefined);
  return {
    saveInvoiceRef: (invoiceId, invoiceNumber) => update({ invoiceId, invoiceNumber }),
    markComptaSynced: () => update({ comptaSyncedAt: new Date() }),
    markStockSynced: () => update({ stockSyncedAt: new Date() }),
    recordFailure: (detail) => update({ syncError: detail, syncAttempts: { increment: 1 } }),
    clearError: () => update({ syncError: null }),
  };
}

/**
 * Rejoue les étapes de synchro MANQUANTES d'une vente déjà chargée (PAID attendu).
 * N'échoue jamais sur un échec core : l'issue est retournée + persistée (syncError/syncAttempts).
 */
async function syncLoadedSale(sale: LoadedSale): Promise<SyncOutcome> {
  const outcome = await runSaleSync(toSnapshot(sale), comptaClient(), stockClient(), persistFor(sale.tenantId, sale.id));
  if (!outcome.synced && outcome.failure) {
    const f = outcome.failure;
    // Socle observabilité : pont inter-cores (Compta/Stock) en échec après encaissement → watchdog.
    log.error("caisse.saleSync", new Error(`${f.core}:${f.op} ${f.kind} ${f.status}`), {
      saleId: sale.id,
      tenantId: sale.tenantId,
      detail: f.detail.slice(0, 300),
    });
    console.error(
      `[caisse] synchro incomplète sale=${sale.id} tenant=${sale.tenantId} core=${f.core} op=${f.op} kind=${f.kind} status=${f.status} detail=${f.detail} — reprise via /api/sales/:id/repair ou cron repair-sales`,
    );
  }
  return outcome;
}

export type RepairResult =
  | { ok: false; error: "SALE_NOT_FOUND" | "NOT_PAID" }
  | {
      ok: true;
      saleId: string;
      synced: boolean;
      alreadySynced: boolean;
      invoiceId: string | null;
      invoiceNumber: string | null;
      stockDecremented: number;
      syncError: string | null;
    };

/**
 * REPRISE idempotente d'une vente PAID dont la synchro Compta/Stock est incomplète.
 * Ne rejoue QUE les étapes manquantes ; sans effet (alreadySynced) si tout est déjà convergé.
 */
export async function repairSale(tenantId: string, saleId: string): Promise<RepairResult> {
  const sale = await getSale(tenantId, saleId);
  if (!sale) return { ok: false, error: "SALE_NOT_FOUND" };
  if (sale.status !== "PAID") return { ok: false, error: "NOT_PAID" };

  if (sale.comptaSyncedAt && sale.stockSyncedAt) {
    return {
      ok: true,
      saleId,
      synced: true,
      alreadySynced: true,
      invoiceId: sale.invoiceId,
      invoiceNumber: sale.invoiceNumber,
      stockDecremented: sale.lines.filter((l) => l.kind === "PRODUCT" && l.productId).length,
      syncError: null,
    };
  }

  const outcome = await syncLoadedSale(sale);
  return {
    ok: true,
    saleId,
    synced: outcome.synced,
    alreadySynced: false,
    invoiceId: outcome.invoiceId,
    invoiceNumber: outcome.invoiceNumber,
    stockDecremented: outcome.stockDecremented,
    syncError: outcome.failure ? `${outcome.failure.core}:${outcome.failure.op} ${outcome.failure.kind} ${outcome.failure.status} ${outcome.failure.detail}` : null,
  };
}

/**
 * ENCAISSE un ticket puis le SYNCHRONISE vers Compta + Stock :
 *   (1) valider/persister le(s) paiement(s) (settleRef déterministe "caisse:<saleId>:<i>")
 *   (2) marquer le ticket PAID IMMÉDIATEMENT — l'argent est dans le tiroir
 *   (3) synchro (lib/sync.ts) : facture Compta → settle par paiement → décrément Stock par ligne PRODUCT
 *
 * ÉCHEC PARTIEL APRÈS ENCAISSEMENT : la vente RESTE PAID (le client est servi), l'étape manquante est
 * tracée sur la vente (comptaSyncedAt/stockSyncedAt NULL + syncError) et le résultat porte
 * syncPending=true. La convergence est reprise par repairSale (S2S /api/sales/:id/repair) ou le
 * balayage /api/cron/repair-sales. Toutes les étapes sont idempotentes côté cible (facture par
 * sourceId, settle par paymentRef, mouvement stock par "<saleId>:<lineId>") → rejouable en sûreté.
 * Seules les validations AVANT encaissement (UNDERPAID, NO_PAYMENT…) refusent le checkout.
 */
export async function checkoutSale(
  tenantId: string,
  saleId: string,
  payments: PaymentInput[],
  options?: CheckoutOptions,
): Promise<CheckoutResult | CheckoutError> {
  // 1. Charger le ticket + lignes + paiements déjà enregistrés
  const sale = await getSale(tenantId, saleId);
  if (!sale) return { ok: false, error: "SALE_NOT_FOUND" };
  if (sale.status === "VOID") return { ok: false, error: "ALREADY_VOID" };

  // ── Bons cadeaux : validation de FORME, avant tout le reste ────────────────────────────
  // Un panier absent ou vide laisse ce bloc entièrement inerte : `giftCardsToIssue` reste
  // vide et pas une seule requête n'est faite. C'est ce qui garantit aux surfaces qui
  // n'émettent pas de bons un comportement rigoureusement inchangé.
  const giftCardInputs = options?.giftCards ?? [];
  let giftCardsToIssue: GiftCardData[] = [];
  if (giftCardInputs.length > 0) {
    const validated = validateGiftCards(giftCardInputs);
    if (!validated.ok) {
      return { ok: false, error: "GIFT_CARD_INVALID", reason: validated.error, index: validated.index };
    }
    giftCardsToIssue = validated.data;
  }

  const compta = comptaClient();

  // Idempotence : si déjà PAID, ne pas ré-encaisser — mais retenter la synchro si elle est incomplète.
  if (sale.status === "PAID") {
    const paid = sale.payments.reduce((t, p) => t + p.amountXpf, 0n);
    const pending = !sale.comptaSyncedAt || !sale.stockSyncedAt;
    const outcome = pending ? await syncLoadedSale(sale) : null;
    const invoiceId = outcome ? outcome.invoiceId : sale.invoiceId;
    return {
      ok: true,
      saleId: sale.id,
      status: "PAID",
      invoiceId,
      invoiceNumber: outcome ? outcome.invoiceNumber : sale.invoiceNumber,
      totalXpf: Number(sale.totalXpf),
      paidXpf: Number(paid),
      changeXpf: 0,
      receiptUrl: invoiceId ? compta.receiptUrl(invoiceId, tenantId) : null,
      stockDecremented: outcome
        ? outcome.stockDecremented
        : sale.lines.filter((l) => l.kind === "PRODUCT" && l.productId).length,
      syncPending: outcome ? !outcome.synced : false,
      syncError: outcome?.failure ? `${outcome.failure.core}:${outcome.failure.op} ${outcome.failure.detail}` : null,
      alreadyPaid: true,
    };
  }

  // Paiements : soit fournis maintenant, soit déjà persistés (rejeu). On persiste ceux fournis d'abord.
  if ((!payments || payments.length === 0) && sale.payments.length === 0) {
    return { ok: false, error: "NO_PAYMENT" };
  }

  // ── Bons cadeaux : le code est-il libre ? ──────────────────────────────────────────────
  // Cette lecture est faite AVANT de persister le moindre paiement, et elle n'est pas
  // redondante avec l'index unique : l'index protège la base, ce contrôle protège la
  // CLIENTE. Sans lui, un code déjà pris ferait échouer la transaction du passage à PAID
  // APRÈS que les paiements sont enregistrés — l'argent serait pris et la vente resterait
  // en attente. L'index reste le dernier mot (deux comptoirs à la même seconde) ; il ne
  // devrait jamais avoir à parler.
  if (giftCardsToIssue.length > 0) {
    const codes = giftCardsToIssue.map((g) => g.code);
    const taken = await withTenant(tenantId, (tx) =>
      tx.giftCard.findFirst({ where: { tenantId, code: { in: codes } }, select: { code: true } }),
    );
    if (taken) return { ok: false, error: "GIFT_CARD_CODE_TAKEN", code: taken.code };
  }

  // « J'encaisse, puis je rends » : c'est LE moteur qui impute, pas l'appelant. On ne
  // persiste JAMAIS une imputation supérieure au dû — sinon la vente est soldée en trop
  // en Compta et le rendu part en recette (bug vécu V'Cut : 3000 encaissés sur un ticket
  // à 2500). Un excédent en carte/virement/chèque est une saisie fausse → refus.
  let toPersist: PaymentInput[] = payments ?? [];
  if (payments && payments.length > 0) {
    const norm = normalizePayments(sale.totalXpf, payments);
    if (!norm.ok) {
      return {
        ok: false,
        error: "OVERPAID",
        method: norm.method,
        excessXpf: Number(norm.excessXpf),
        totalXpf: Number(sale.totalXpf),
      };
    }
    toPersist = norm.payments as PaymentInput[];
  }

  // Persiste les nouveaux paiements (avec settleRef déterministe) s'il y en a.
  if (toPersist.length > 0) {
    await withTenant(tenantId, async (tx) => {
      // On (re)crée les paiements uniquement si aucun n'est encore enregistré (évite les doublons au rejeu).
      const already = await tx.salePayment.count({ where: { tenantId, saleId } });
      if (already === 0) {
        for (let i = 0; i < toPersist.length; i++) {
          const p = toPersist[i];
          await tx.salePayment.create({
            data: {
              tenantId,
              saleId,
              method: p.method,
              amountXpf: p.amountXpf,
              tenderedXpf: p.tenderedXpf ?? null,
              settleRef: `${CAISSE_SOURCE_TYPE}:${saleId}:${i}`,
            },
          });
        }
      }
    });
  }

  // Relire les paiements persistés (source de vérité pour le montant à solder).
  const persisted = await withTenant(tenantId, (tx) =>
    tx.salePayment.findMany({ where: { tenantId, saleId }, orderBy: { createdAt: "asc" } }),
  );
  const paidTotal = persisted.reduce((t, p) => t + p.amountXpf, 0n);
  if (paidTotal < sale.totalXpf) {
    return { ok: false, error: "UNDERPAID", totalXpf: Number(sale.totalXpf), paidXpf: Number(paidTotal) };
  }
  const change = Number(computeChange(persisted.map((p) => ({
    method: p.method,
    amountXpf: p.amountXpf,
    tenderedXpf: p.tenderedXpf ?? undefined,
  }))));

  // 2. ENCAISSEMENT ACTÉ : le ticket passe PAID AVANT la synchro (l'argent est dans le tiroir).
  //
  // 🔴 LES BONS NAISSENT ICI, DANS LA MÊME TRANSACTION QUE LE PASSAGE À PAID. Il n'existe
  //    donc AUCUNE fenêtre entre « l'argent est pris » et « le bon existe » : soit les deux,
  //    soit ni l'un ni l'autre. Un bon créé après coup, dans un second appel, c'est la
  //    cliente qui repart les mains vides parce qu'un réseau a coupé entre deux requêtes.
  //    ⚠️ Ne PAS déplacer ces créations hors de ce `withTenant`, et ne PAS leur donner un
  //    `skipDuplicates` : perdre silencieusement un bon vendu serait pire que l'échec.
  const issued = await withTenant(tenantId, async (tx) => {
    await tx.sale.update({ where: { id: saleId }, data: { status: "PAID", paidAt: new Date() } });
    if (giftCardsToIssue.length === 0) return [] as GiftCardIssued[];
    const rows: GiftCardIssued[] = [];
    for (const g of giftCardsToIssue) {
      const row = await tx.giftCard.create({
        data: { tenantId, saleId, ...g },
        select: { id: true, code: true, amountXpf: true, serviceLabel: true, expiresAt: true, beneficiaryName: true },
      });
      rows.push({
        id: row.id,
        code: row.code,
        amountXpf: Number(row.amountXpf),
        serviceLabel: row.serviceLabel,
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
        beneficiaryName: row.beneficiaryName,
      });
    }
    return rows;
  });

  // 3. SYNCHRO Compta + Stock — un échec ici ne remet PAS l'encaissement en cause (reprise différée).
  const reloaded = await getSale(tenantId, saleId);
  const outcome = await syncLoadedSale(reloaded!);

  // Numéro de la facture d'ACHAT (au nom de l'acheteur) reporté sur les bons : simple
  // annotation de rapprochement, faite APRÈS la synchro parce que le numéro n'existe pas
  // avant. BEST-EFFORT ASSUMÉ : un échec ici ne remet en cause ni l'encaissement ni les
  // bons, qui sont déjà l'un et l'autre acquis. Un bon sans numéro de facture reste un bon
  // parfaitement valable — il est juste moins commode à rapprocher.
  if (issued.length > 0 && outcome.invoiceNumber) {
    try {
      await withTenant(tenantId, (tx) =>
        tx.giftCard.updateMany({
          where: { tenantId, id: { in: issued.map((g) => g.id) } },
          data: { invoiceNumber: outcome.invoiceNumber },
        }),
      );
    } catch (e) {
      log.error("giftCard.invoiceNumber", e, { saleId, count: issued.length });
    }
  }

  return {
    ok: true,
    saleId,
    status: "PAID",
    invoiceId: outcome.invoiceId,
    invoiceNumber: outcome.invoiceNumber,
    totalXpf: Number(sale.totalXpf),
    paidXpf: Number(paidTotal),
    changeXpf: change,
    receiptUrl: outcome.invoiceId ? compta.receiptUrl(outcome.invoiceId, tenantId) : null,
    stockDecremented: outcome.stockDecremented,
    syncPending: !outcome.synced,
    syncError: outcome.failure ? `${outcome.failure.core}:${outcome.failure.op} ${outcome.failure.detail}` : null,
    alreadyPaid: false,
    // Absent quand il n'y a pas de bon : réponse inchangée pour les surfaces qui n'en émettent pas.
    ...(issued.length > 0 ? { giftCards: issued } : {}),
  };
}

/** Annule un ticket non encaissé (DRAFT → VOID). */
export async function voidSale(tenantId: string, saleId: string) {
  return withTenant(tenantId, async (tx) => {
    const sale = await tx.sale.findFirst({ where: { id: saleId, tenantId }, select: { id: true, status: true } });
    if (!sale) return { ok: false as const, error: "SALE_NOT_FOUND" as const };
    if (sale.status === "PAID") return { ok: false as const, error: "ALREADY_PAID" as const };
    await tx.sale.update({ where: { id: saleId }, data: { status: "VOID" } });
    return { ok: true as const };
  });
}

// ── MOUVEMENTS DE TIROIR ─────────────────────────────────────────────────────────────────────
// Chantier « écart de caisse » (décision Marco 2026-08-05) : rendre le Z juste TOUT SEUL quand
// un salon rembourse un avoir en espèces, sans toucher au chiffre d'affaires.

export type RecordMovementInput = {
  kind: CashMovementKind;
  amountXpf: bigint; // TOUJOURS positif — le sens vient de `kind` (cf. lib/cash-movement.ts)
  reason: string;
  ref?: string | null; // n° d'avoir quand kind = REFUND ; porte l'unicité anti-double-remboursement
  createdBy?: string | null;
  createdByName?: string | null;
};

export type RecordMovementResult =
  | { ok: false; error: "NO_OPEN_SESSION" }
  | { ok: false; error: "SESSION_CLOSED" }
  | { ok: true; alreadyExisted: boolean; movement: { id: string; sessionId: string; amountXpf: bigint; kind: CashMovementKind } };

/**
 * Enregistre un mouvement d'espèces sur la session de caisse OUVERTE du marchand.
 *
 * DEUX REFUS QUI SONT LE CŒUR DU DISPOSITIF, et non des détails d'implémentation :
 *
 * 1. `NO_OPEN_SESSION` — pas de session ouverte, pas de mouvement. Écrire quand même le rendrait
 *    invisible de tout Z (celui-ci n'existe pas, et une session future ne le verrait pas) : on
 *    aurait déplacé l'écart muet, pas supprimé. Le refus force le bon geste (« ouvrez une session
 *    de caisse pour rembourser en espèces ») — c'est LUI qui fait que le Z se ferme juste seul.
 *
 * 2. `SESSION_CLOSED` — une session close a son `varianceXpf` FIGÉ et ne le recalcule jamais
 *    (cf. closeSession). Y rattacher un mouvement produirait un Z dont l'écart affiché ne
 *    correspondrait plus à ses propres lignes.
 *
 * IDEMPOTENT par `ref` : rejouer le même remboursement (double-clic, reprise réseau) rend le
 * mouvement existant au lieu d'en créer un second. La garantie est EN BASE
 * (`@@unique([tenantId, ref])`), pas seulement dans ce test applicatif : deux appels simultanés
 * ne peuvent pas produire deux lignes — le second lève P2002 et on rend l'existant.
 */
export async function recordCashMovement(
  tenantId: string,
  input: RecordMovementInput,
): Promise<RecordMovementResult> {
  return withTenant(tenantId, async (tx) => {
    const session = await tx.cashSession.findFirst({
      where: { tenantId, status: "OPEN" },
      orderBy: { openedAt: "desc" },
    });
    if (!session) return { ok: false as const, error: "NO_OPEN_SESSION" as const };

    const ref = input.ref ?? null;
    if (ref) {
      const existing = await tx.cashMovement.findFirst({
        where: { tenantId, ref },
        select: { id: true, sessionId: true, amountXpf: true, kind: true },
      });
      if (existing) {
        return {
          ok: true as const,
          alreadyExisted: true,
          movement: { ...existing, kind: existing.kind as CashMovementKind },
        };
      }
    }

    try {
      const created = await tx.cashMovement.create({
        data: {
          tenantId,
          sessionId: session.id,
          kind: input.kind,
          amountXpf: input.amountXpf,
          reason: input.reason,
          ref,
          createdBy: input.createdBy ?? null,
          createdByName: input.createdByName ?? null,
        },
        select: { id: true, sessionId: true, amountXpf: true, kind: true },
      });
      return {
        ok: true as const,
        alreadyExisted: false,
        movement: { ...created, kind: created.kind as CashMovementKind },
      };
    } catch (e) {
      // P2002 = l'unique (tenantId, ref) a mordu : une course a créé le mouvement entre notre
      // lecture et notre écriture. C'est le cas que la vérification applicative ci-dessus ne
      // peut PAS couvrir, et c'est précisément pour lui que l'index existe.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && ref) {
        const raced = await tx.cashMovement.findFirst({
          where: { tenantId, ref },
          select: { id: true, sessionId: true, amountXpf: true, kind: true },
        });
        if (raced) {
          return {
            ok: true as const,
            alreadyExisted: true,
            movement: { ...raced, kind: raced.kind as CashMovementKind },
          };
        }
      }
      throw e;
    }
  });
}

/** Les mouvements d'une session, pour l'écran de caisse et le Z. */
export async function listCashMovements(tenantId: string, sessionId: string) {
  return withTenant(tenantId, (tx) =>
    tx.cashMovement.findMany({
      where: { tenantId, sessionId },
      orderBy: { createdAt: "asc" },
    }),
  );
}

// ─── Bons cadeaux (PC-0064) ──────────────────────────────────────────────────
//
// 🔒 RAPPEL DE L'INVARIANT, parce que c'est ici qu'on serait tenté de l'oublier :
//    LE MONTANT D'UN BON ENTRE DANS LE CA UNE SEULE FOIS, LE JOUR DE SON ACHAT.
//    L'achat passe par `checkoutSale` (au-dessus). La CONSOMMATION, elle, n'écrit
//    RIEN d'autre que la date sur le bon : pas de Sale, pas de SalePayment, pas de
//    CashMovement, pas de facture. Si un jour une de ces trois écritures apparaît
//    dans `redeemGiftCard`, l'argent du salon est compté deux fois.

/** Un bon tel que le lit une surface. Montants en `number` (le JSON ne porte pas de BigInt). */
export type GiftCardView = {
  id: string;
  code: string;
  amountXpf: number;
  serviceLabel: string | null;
  serviceId: string | null;
  buyerName: string | null;
  beneficiaryName: string | null;
  beneficiaryPhone: string | null;
  beneficiaryEmail: string | null;
  issuedAt: string;
  expiresAt: string | null;
  saleId: string | null;
  invoiceNumber: string | null;
  redeemedAt: string | null;
  redeemedByName: string | null;
  redeemedForXpf: number | null;
  cancelledAt: string | null;
  cancelReason: string | null;
};

type GiftCardRow = {
  id: string;
  code: string;
  amountXpf: bigint;
  serviceLabel: string | null;
  serviceId: string | null;
  buyerName: string | null;
  beneficiaryName: string | null;
  beneficiaryPhone: string | null;
  beneficiaryEmail: string | null;
  issuedAt: Date;
  expiresAt: Date | null;
  saleId: string | null;
  invoiceNumber: string | null;
  redeemedAt: Date | null;
  redeemedByName: string | null;
  redeemedForXpf: bigint | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
};

const GIFT_CARD_SELECT = {
  id: true,
  code: true,
  amountXpf: true,
  serviceLabel: true,
  serviceId: true,
  buyerName: true,
  beneficiaryName: true,
  beneficiaryPhone: true,
  beneficiaryEmail: true,
  issuedAt: true,
  expiresAt: true,
  saleId: true,
  invoiceNumber: true,
  redeemedAt: true,
  redeemedByName: true,
  redeemedForXpf: true,
  cancelledAt: true,
  cancelReason: true,
} as const;

/**
 * ⚠️ AUCUN statut n'est calculé ici, et c'est voulu : « expiré » se DÉRIVE à la lecture, par
 * `giftCardStatus` (lib/gift-card.ts), à partir de `expiresAt`. Un statut renvoyé par le moteur
 * serait figé à l'instant de la requête, donc faux la minute d'après.
 */
function toGiftCardView(row: GiftCardRow): GiftCardView {
  return {
    id: row.id,
    code: row.code,
    amountXpf: Number(row.amountXpf),
    serviceLabel: row.serviceLabel,
    serviceId: row.serviceId,
    buyerName: row.buyerName,
    beneficiaryName: row.beneficiaryName,
    beneficiaryPhone: row.beneficiaryPhone,
    beneficiaryEmail: row.beneficiaryEmail,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    saleId: row.saleId,
    invoiceNumber: row.invoiceNumber,
    redeemedAt: row.redeemedAt ? row.redeemedAt.toISOString() : null,
    redeemedByName: row.redeemedByName,
    redeemedForXpf: row.redeemedForXpf === null ? null : Number(row.redeemedForXpf),
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    cancelReason: row.cancelReason,
  };
}

/**
 * Liste les bons d'un marchand. `code` fourni → recherche exacte sur le code NORMALISÉ (majuscules,
 * sans séparateur) : « bc 4k7q-p2 » retrouve « BC4K7QP2 », parce qu'un code se recopie à la main.
 * La limite est bornée côté route.
 */
export async function listGiftCards(
  tenantId: string,
  filter: { code?: string; take?: number } = {},
): Promise<GiftCardView[]> {
  const take = Math.min(Math.max(filter.take ?? 200, 1), 500);
  const rows = await withTenant(tenantId, (tx) =>
    tx.giftCard.findMany({
      where: { tenantId, ...(filter.code ? { code: filter.code } : {}) },
      orderBy: { issuedAt: "desc" },
      take,
      select: GIFT_CARD_SELECT,
    }),
  );
  return rows.map(toGiftCardView);
}

/**
 * Fait naître un bon SANS ENCAISSEMENT — geste commercial, remplacement d'un bon papier abîmé,
 * reprise d'un historique.
 *
 * ⚠️ CE N'EST PAS LE CHEMIN D'ACHAT. Un bon acheté naît dans la transaction du passage à PAID de
 * `checkoutSale` (champ `options.giftCards`), pour qu'il n'existe aucune fenêtre entre « l'argent
 * est pris » et « le bon existe ». Ici, rien n'est encaissé : `saleId` et `invoiceNumber` restent
 * vides, aucune écriture comptable n'est faite, et le montant du bon n'entre dans AUCUN chiffre
 * d'affaires — ce qui est juste, puisque personne ne l'a payé.
 */
export async function createGiftCardWithoutSale(
  tenantId: string,
  input: GiftCardInput,
): Promise<{ ok: true; card: GiftCardView } | { ok: false; error: GiftCardRefusal | "CODE_TAKEN" }> {
  const validated = validateGiftCard(input);
  if (!validated.ok) return { ok: false, error: validated.error };
  try {
    const row = await withTenant(tenantId, (tx) =>
      tx.giftCard.create({ data: { tenantId, ...validated.data }, select: GIFT_CARD_SELECT }),
    );
    return { ok: true, card: toGiftCardView(row) };
  } catch (e) {
    // P2002 = violation de @@unique(tenantId, code). L'unicité est garantie EN BASE : deux
    // créations simultanées du même code ne peuvent pas passer toutes les deux.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "CODE_TAKEN" };
    }
    throw e;
  }
}

export type RedeemGiftCardInput = {
  redeemedBy?: string | null;
  redeemedByName?: string | null;
  redeemedForXpf?: bigint | null;
};

export type RedeemGiftCardResult =
  | { ok: true; card: GiftCardView }
  | { ok: false; error: GiftCardRedeemRefusal };

/**
 * CONSOMME un bon. C'est la seule opération de ce module qui doive être irréprochable en base.
 *
 * 🔴 UN SEUL `UPDATE`, CONDITIONNÉ. La condition `redeemedAt: null` est DANS la clause `WHERE`
 *    de l'ordre SQL, pas dans un `if` applicatif : `updateMany` produit
 *        UPDATE "GiftCard" SET "redeemedAt" = … WHERE … AND "redeemedAt" IS NULL
 *    et PostgreSQL sérialise les écritures concurrentes sur une même ligne. Deux comptoirs qui
 *    scannent le même bon à la même seconde : le premier affecte 1 ligne, le second en affecte 0.
 *
 * ⛔ CE QU'IL NE FAUT JAMAIS FAIRE ICI : un `findFirst` pour vérifier que le bon est libre, puis
 *    un `update`. Entre les deux lectures il y a un intervalle, et dans cet intervalle le bon
 *    part deux fois — c'est-à-dire deux prestations rendues pour un seul encaissement. La forme
 *    « lire puis écrire » est exactement le bug que cette fonction existe pour ne pas avoir.
 *
 * La relecture ci-dessous n'intervient qu'APRÈS un échec, et uniquement pour NOMMER le refus
 * (introuvable ? annulé ? déjà consommé ?). Elle ne décide de rien : la décision est déjà prise,
 * par la base, au moment où elle a répondu « 0 ligne ».
 *
 * 🔒 ET SURTOUT : aucune écriture comptable. Pas de vente, pas de paiement, pas de mouvement de
 *    tiroir, pas de facture. Les francs de ce bon sont entrés dans le CA le jour de son achat.
 */
export async function redeemGiftCard(
  tenantId: string,
  giftCardId: string,
  input: RedeemGiftCardInput = {},
): Promise<RedeemGiftCardResult> {
  return withTenant(tenantId, async (tx) => {
    const { count } = await tx.giftCard.updateMany({
      where: { id: giftCardId, tenantId, redeemedAt: null, cancelledAt: null },
      data: {
        redeemedAt: new Date(),
        redeemedBy: input.redeemedBy ?? null,
        redeemedByName: input.redeemedByName ?? null,
        redeemedForXpf: input.redeemedForXpf ?? null,
      },
    });

    if (count === 0) {
      // La base a tranché. On relit seulement pour DIRE POURQUOI — au comptoir, « refusé » sans
      // motif est inutilisable : l'employée doit pouvoir répondre à la cliente qui est en face.
      const existing = await tx.giftCard.findFirst({
        where: { id: giftCardId, tenantId },
        select: { redeemedAt: true, cancelledAt: true },
      });
      if (!existing) return { ok: false as const, error: "NOT_FOUND" as const };
      if (existing.cancelledAt) return { ok: false as const, error: "CANCELLED" as const };
      return { ok: false as const, error: "ALREADY_REDEEMED" as const };
    }

    const card = await tx.giftCard.findFirstOrThrow({
      where: { id: giftCardId, tenantId },
      select: GIFT_CARD_SELECT,
    });
    return { ok: true as const, card: toGiftCardView(card) };
  });
}

export type CancelGiftCardResult =
  | { ok: true; card: GiftCardView }
  | { ok: false; error: GiftCardCancelRefusal };

/**
 * ANNULE un bon. Réservé à l'ADMIN — le contrôle du droit est à la charge de la surface, comme
 * pour toutes les routes S2S de ce moteur (le moteur ne connaît ni rôles ni sessions).
 *
 * Même forme atomique que la consommation, et pour la même raison : un bon DÉJÀ CONSOMMÉ ne
 * s'annule pas. Sans la condition `redeemedAt IS NULL` dans le `WHERE`, une annulation lancée
 * pendant qu'une consommation aboutit effacerait la trace de la prestation rendue.
 *
 * ⚠️ Annuler ne rembourse RIEN et n'écrit AUCUNE comptabilité. L'argent du bon est entré dans le
 *    CA le jour de l'achat ; s'il doit ressortir, c'est un avoir — une décision du commerce, une
 *    autre pièce, un autre geste.
 */
export async function cancelGiftCard(
  tenantId: string,
  giftCardId: string,
  input: { reason?: string | null; cancelledBy?: string | null; cancelledByName?: string | null } = {},
): Promise<CancelGiftCardResult> {
  return withTenant(tenantId, async (tx) => {
    const { count } = await tx.giftCard.updateMany({
      where: { id: giftCardId, tenantId, redeemedAt: null, cancelledAt: null },
      data: {
        cancelledAt: new Date(),
        cancelReason: input.reason ?? null,
        cancelledBy: input.cancelledBy ?? null,
        cancelledByName: input.cancelledByName ?? null,
      },
    });

    if (count === 0) {
      const existing = await tx.giftCard.findFirst({
        where: { id: giftCardId, tenantId },
        select: { redeemedAt: true, cancelledAt: true },
      });
      if (!existing) return { ok: false as const, error: "NOT_FOUND" as const };
      if (existing.redeemedAt) return { ok: false as const, error: "ALREADY_REDEEMED" as const };
      return { ok: false as const, error: "ALREADY_CANCELLED" as const };
    }

    const card = await tx.giftCard.findFirstOrThrow({
      where: { id: giftCardId, tenantId },
      select: GIFT_CARD_SELECT,
    });
    return { ok: true as const, card: toGiftCardView(card) };
  });
}
