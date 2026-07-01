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

import { withTenant } from "./tenant";
import { comptaClient, stockClient, CoreClientError } from "./clients";
import { computeChange, lineTotalXpf } from "./money";
import { Prisma, type LineKind, type PayMethod, type SaleStatus } from "@prisma/client";

// Ré-export du helper pur (rendu monnaie) — testé unitairement via lib/money.ts.
export { computeChange } from "./money";

// sourceType constant utilisé dans les appels sortants (idempotence).
export const CAISSE_SOURCE_TYPE = "caisse";

// ─── Sessions de caisse ──────────────────────────────────────────────────────

export async function openSession(
  tenantId: string,
  input: { openedBy: string; openingFloatXpf: bigint; note?: string },
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
};

/**
 * Clôture Z d'une session : calcule l'attendu (fond + encaissements ESPÈCES des ventes PAID de la
 * session) vs le compté (saisie caissier), enregistre l'écart, passe la session CLOSED.
 * Idempotent : une session déjà CLOSED renvoie son rapport figé.
 */
export async function closeSession(
  tenantId: string,
  input: { sessionId: string; closedBy: string; closingCountedXpf: bigint },
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

    const expected = session.openingFloatXpf + cashSales;

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
  invoiceId: string;
  invoiceNumber: string | null;
  totalXpf: number;
  paidXpf: number;
  changeXpf: number; // rendu monnaie total (Σ tendered - Σ amount, borné à ≥0)
  receiptUrl: string; // URL S2S du ticket PDF (Core-Compta) — à imprimer
  stockDecremented: number; // nb de lignes PRODUCT décrémentées
  alreadyPaid: boolean;
};

export type CheckoutError =
  | { ok: false; error: "SALE_NOT_FOUND" }
  | { ok: false; error: "ALREADY_VOID" }
  | { ok: false; error: "NO_PAYMENT" }
  | { ok: false; error: "UNDERPAID"; totalXpf: number; paidXpf: number }
  | { ok: false; error: "CORE_CALL_FAILED"; core: "compta" | "stock"; op: string; detail: string };

/**
 * ENCAISSE un ticket et l'ORCHESTRE vers Compta + Stock, dans l'ordre robuste :
 *   (a) créer la facture Compta (idempotent sourceType="caisse"+sourceId=saleId)
 *   (b) enregistrer le(s) paiement(s) Compta (POST /api/settle, paymentRef déterministe)
 *   (c) décrémenter Stock pour chaque ligne PRODUCT (idempotent tenantId+sourceType+sourceId)
 *   (d) marquer le ticket PAID + stocker invoiceId/number
 *
 * STRATÉGIE IDEMPOTENCE / ÉCHEC PARTIEL :
 * Chaque étape est idempotente côté cible. En cas d'échec APRÈS une étape réussie (ex : Stock KO après
 * facture+settle OK), l'appelant peut simplement REJOUER checkoutSale(saleId, payments) : les étapes
 * déjà faites sont détectées (alreadyExisted / paymentRef connu) et NON rejouées, et la suite reprend.
 * On persiste invoiceId dès (a) réussi (via une petite MAJ) pour que le rejeu réutilise la même facture.
 * Les paiements portent un paymentRef DÉTERMINISTE "caisse:<saleId>:<index>" → /api/settle ne double pas.
 * Le décrément Stock utilise sourceId="<saleId>:<lineId>" → dédupe par ligne.
 * Le ticket ne passe PAID qu'une fois (d) atteint ; tout échec intermédiaire est loggué et remonté.
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
  const stock = stockClient();

  // Idempotence : si déjà PAID, on renvoie l'état existant sans rien rejouer.
  if (sale.status === "PAID" && sale.invoiceId) {
    const paid = sale.payments.reduce((t, p) => t + p.amountXpf, 0n);
    return {
      ok: true,
      saleId: sale.id,
      status: "PAID",
      invoiceId: sale.invoiceId,
      invoiceNumber: sale.invoiceNumber,
      totalXpf: Number(sale.totalXpf),
      paidXpf: Number(paid),
      changeXpf: 0,
      receiptUrl: compta.receiptUrl(sale.invoiceId, tenantId),
      stockDecremented: sale.lines.filter((l) => l.kind === "PRODUCT").length,
      alreadyPaid: true,
    };
  }

  // Paiements : soit fournis maintenant, soit déjà persistés (rejeu). On persiste ceux fournis d'abord.
  if ((!payments || payments.length === 0) && sale.payments.length === 0) {
    return { ok: false, error: "NO_PAYMENT" };
  }

  // Persiste les nouveaux paiements (avec settleRef déterministe) s'il y en a.
  if (payments && payments.length > 0) {
    await withTenant(tenantId, async (tx) => {
      // On (re)crée les paiements uniquement si aucun n'est encore enregistré (évite les doublons au rejeu).
      const already = await tx.salePayment.count({ where: { tenantId, saleId } });
      if (already === 0) {
        for (let i = 0; i < payments.length; i++) {
          const p = payments[i];
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

  try {
    // (a) FACTURE Compta — idempotent sur sourceType="caisse"+sourceId=saleId
    let invoiceId = sale.invoiceId;
    let invoiceNumber = sale.invoiceNumber;
    if (!invoiceId) {
      const inv = await compta.createInvoice({
        tenantId,
        sourceType: CAISSE_SOURCE_TYPE,
        sourceId: saleId,
        clientName: sale.clientName,
        lines: sale.lines.map((l) => ({ label: l.label, qty: l.qty, unitXpf: Number(l.unitXpf) })),
      });
      invoiceId = inv.invoiceId;
      invoiceNumber = inv.number;
      // Persister DÈS que la facture existe → un rejeu réutilise la même facture (pas de doublon).
      await withTenant(tenantId, (tx) =>
        tx.sale.update({ where: { id: saleId }, data: { invoiceId, invoiceNumber } }),
      );
    }

    // (b) PAIEMENT(S) Compta — settle par paiement, paymentRef déterministe (idempotent)
    for (const p of persisted) {
      await compta.settle({
        tenantId,
        invoiceId,
        amountXpf: Number(p.amountXpf),
        method: p.method,
        paymentRef: p.settleRef ?? `${CAISSE_SOURCE_TYPE}:${saleId}:${p.id}`,
      });
    }

    // (c) STOCK — décrément SALE par ligne PRODUCT, idempotent (sourceId = "<saleId>:<lineId>")
    let stockDecremented = 0;
    for (const l of sale.lines) {
      if (l.kind !== "PRODUCT" || !l.productId) continue;
      await stock.recordSale({
        tenantId,
        productId: l.productId,
        qty: l.qty,
        sourceType: CAISSE_SOURCE_TYPE,
        sourceId: `${saleId}:${l.id}`,
        actorId: sale.cashierId ?? undefined,
      });
      stockDecremented++;
    }

    // (d) Ticket PAID
    await withTenant(tenantId, (tx) =>
      tx.sale.update({ where: { id: saleId }, data: { status: "PAID", paidAt: new Date() } }),
    );

    return {
      ok: true,
      saleId,
      status: "PAID",
      invoiceId: invoiceId!,
      invoiceNumber: invoiceNumber ?? null,
      totalXpf: Number(sale.totalXpf),
      paidXpf: Number(paidTotal),
      changeXpf: change,
      receiptUrl: compta.receiptUrl(invoiceId!, tenantId),
      stockDecremented,
      alreadyPaid: false,
    };
  } catch (e) {
    // Échec partiel : on LOGGUE et on remonte. L'état persisté (paiements + invoiceId éventuel) permet
    // de REJOUER checkoutSale en sûreté (idempotence de bout en bout) — aucune donnée dupliquée.
    if (e instanceof CoreClientError) {
      console.error(
        `[caisse] checkout échec partiel sale=${saleId} tenant=${tenantId} core=${e.core} op=${e.op} status=${e.status} detail=${e.detail} — REJOUABLE`,
      );
      return { ok: false, error: "CORE_CALL_FAILED", core: e.core, op: e.op, detail: e.detail };
    }
    console.error(`[caisse] checkout erreur inattendue sale=${saleId} tenant=${tenantId}:`, e);
    throw e;
  }
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
