"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/guards";
import {
  openSession,
  closeSession,
  createSale,
  checkoutSale,
  type SaleLineInput,
  type PaymentInput,
} from "@/lib/caisse";
import type { LineKind, PayMethod } from "@prisma/client";

// ─── Session ─────────────────────────────────────────────────────────────────

export async function openSessionAction(openingFloatXpf: number, note?: string): Promise<string | undefined> {
  const { user, tenant } = await requireStaff("/caisse");
  const res = await openSession(tenant.id, {
    openedBy: user.id,
    openingFloatXpf: BigInt(Math.round(openingFloatXpf || 0)),
    note: note?.trim() || undefined,
  });
  if (!res.ok) return "Une session est déjà ouverte.";
  revalidatePath("/caisse");
}

export type ZReportResult = {
  ok: boolean;
  error?: string;
  report?: {
    expectedXpf: number;
    countedXpf: number;
    varianceXpf: number;
    cashSalesXpf: number;
    openingFloatXpf: number;
    salesCount: number;
    totalSalesXpf: number;
    byMethod: Record<string, number>;
  };
};

export async function closeSessionAction(sessionId: string, closingCountedXpf: number): Promise<ZReportResult> {
  const { user, tenant } = await requireStaff("/caisse");
  const res = await closeSession(tenant.id, {
    sessionId,
    closedBy: user.id,
    closingCountedXpf: BigInt(Math.round(closingCountedXpf || 0)),
  });
  if (!res.ok) return { ok: false, error: "Session introuvable." };
  revalidatePath("/caisse");
  const r = res.report;
  return {
    ok: true,
    report: {
      expectedXpf: r.expectedXpf,
      countedXpf: r.countedXpf,
      varianceXpf: r.varianceXpf,
      cashSalesXpf: r.cashSalesXpf,
      openingFloatXpf: r.openingFloatXpf,
      salesCount: r.salesCount,
      totalSalesXpf: r.totalSalesXpf,
      byMethod: r.byMethod,
    },
  };
}

// ─── Encaissement (composition + checkout en un geste depuis l'écran caisse) ──

export type UiLine = {
  kind: LineKind;
  label: string;
  productId?: string | null;
  qty: number;
  unitXpf: number;
};

export type UiPayment = {
  method: PayMethod;
  amountXpf: number;
  tenderedXpf?: number;
};

export type CheckoutActionResult =
  | { ok: false; error: string }
  | {
      ok: true;
      saleId: string;
      invoiceNumber: string | null;
      totalXpf: number;
      paidXpf: number;
      changeXpf: number;
      receiptUrl: string;
    };

/**
 * Crée le ticket puis l'encaisse en une action (écran caisse). Le flux sous-jacent reste idempotent
 * et transactionnel (facture Compta → settle → décrément Stock → PAID).
 */
export async function checkoutAction(
  sessionId: string | null,
  lines: UiLine[],
  payments: UiPayment[],
  clientName?: string,
): Promise<CheckoutActionResult> {
  const { user, tenant } = await requireStaff("/caisse");

  if (!lines || lines.length === 0) return { ok: false, error: "Le ticket est vide." };
  if (!payments || payments.length === 0) return { ok: false, error: "Aucun paiement saisi." };

  const saleLines: SaleLineInput[] = lines.map((l) => ({
    kind: l.kind,
    label: l.label,
    productId: l.kind === "PRODUCT" ? l.productId ?? null : null,
    qty: Math.trunc(l.qty),
    unitXpf: BigInt(Math.round(l.unitXpf)),
  }));

  const created = await createSale(tenant.id, {
    cashierId: user.id,
    sessionId: sessionId ?? null,
    clientName: clientName?.trim() || null,
    lines: saleLines,
  });
  if (!created.ok) {
    const msg =
      created.error === "PRODUCT_LINE_WITHOUT_PRODUCT"
        ? "Une ligne produit n'a pas de produit associé."
        : created.error === "INVALID_QTY"
          ? "Quantité invalide."
          : "Ticket vide.";
    return { ok: false, error: msg };
  }

  const pays: PaymentInput[] = payments.map((p) => ({
    method: p.method,
    amountXpf: BigInt(Math.round(p.amountXpf)),
    tenderedXpf: p.tenderedXpf !== undefined ? BigInt(Math.round(p.tenderedXpf)) : undefined,
  }));

  const res = await checkoutSale(tenant.id, created.saleId, pays);
  if (!res.ok) {
    const msg =
      res.error === "UNDERPAID"
        ? `Paiement insuffisant (${res.paidXpf} / ${res.totalXpf} F).`
        : res.error === "CORE_CALL_FAILED"
          ? `Échec d'orchestration (${res.core}). Réessayez — l'opération est rejouable en sûreté.`
          : res.error === "NO_PAYMENT"
            ? "Aucun paiement."
            : "Encaissement impossible.";
    return { ok: false, error: msg };
  }

  revalidatePath("/caisse");
  return {
    ok: true,
    saleId: res.saleId,
    invoiceNumber: res.invoiceNumber,
    totalXpf: res.totalXpf,
    paidXpf: res.paidXpf,
    changeXpf: res.changeXpf,
    receiptUrl: res.receiptUrl,
  };
}
