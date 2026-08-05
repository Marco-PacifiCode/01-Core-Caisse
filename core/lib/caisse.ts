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
};

export type CheckoutError =
  | { ok: false; error: "SALE_NOT_FOUND" }
  | { ok: false; error: "ALREADY_VOID" }
  | { ok: false; error: "NO_PAYMENT" }
  | { ok: false; error: "UNDERPAID"; totalXpf: number; paidXpf: number }
  // Excédent sur une méthode qui ne rend pas la monnaie (carte/virement/chèque) : c'est
  // une saisie fausse, pas un rendu. Les espèces en trop, elles, ne sont JAMAIS une
  // erreur — le moteur impute le dû et rend la différence.
  | { ok: false; error: "OVERPAID"; method: string; excessXpf: number; totalXpf: number };

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
): Promise<CheckoutResult | CheckoutError> {
  // 1. Charger le ticket + lignes + paiements déjà enregistrés
  const sale = await getSale(tenantId, saleId);
  if (!sale) return { ok: false, error: "SALE_NOT_FOUND" };
  if (sale.status === "VOID") return { ok: false, error: "ALREADY_VOID" };

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
  await withTenant(tenantId, (tx) =>
    tx.sale.update({ where: { id: saleId }, data: { status: "PAID", paidAt: new Date() } }),
  );

  // 3. SYNCHRO Compta + Stock — un échec ici ne remet PAS l'encaissement en cause (reprise différée).
  const reloaded = await getSale(tenantId, saleId);
  const outcome = await syncLoadedSale(reloaded!);

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
