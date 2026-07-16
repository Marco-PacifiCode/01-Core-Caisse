import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { checkoutSale, type PaymentInput } from "@/lib/caisse";
import type { PayMethod } from "@prisma/client";

export const runtime = "nodejs";

const VALID_METHODS: PayMethod[] = ["CASH", "CARD", "TRANSFER", "CHEQUE", "OTHER"];

/**
 * POST /api/sales/:id/checkout
 * ENCAISSE un ticket (S2S, X-Core-Key) : enregistre le(s) paiement(s) offline, calcule le rendu monnaie,
 * marque la vente PAID (l'argent est pris), puis SYNCHRONISE Compta (facture + settle) et Stock
 * (décrément SALE). Idempotent de bout en bout : rejouer avec le même saleId ne double NI la facture
 * NI le stock NI les paiements.
 *
 * Body : { tenantId, payments: { method, amountXpf, tenderedXpf? }[] }
 *   payments : 1..n (paiement MIXTE supporté). tenderedXpf (espèces) → rendu monnaie.
 *
 * Réponse 200 : { ok, saleId, status, invoiceId, invoiceNumber, totalXpf, paidXpf, changeXpf,
 *                 receiptUrl, stockDecremented, syncPending, syncError, alreadyPaid }
 *   Un échec S2S APRÈS encaissement ne fait PAS échouer la requête : la vente reste PAID,
 *   syncPending=true (invoiceId/receiptUrl éventuellement null), et la convergence est reprise par
 *   POST /api/sales/:id/repair ou le balayage /api/cron/repair-sales.
 * Erreurs : 404 SALE_NOT_FOUND · 409 UNDERPAID/OVERPAID/ALREADY_VOID/NO_PAYMENT (validations AVANT encaissement).
 *
 * `amountXpf` est une DÉCLARATION, pas une consigne : le moteur impute lui-même `min(reçu, dû)`
 * et rend l'excédent en espèces (cf. lib/money.ts normalizePayments). Un excédent en
 * carte/virement/chèque → 409 OVERPAID (rien ne se rend sur une carte).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: saleId } = await ctx.params;

  let body: {
    tenantId?: string;
    payments?: { method?: string; amountXpf?: number; tenderedXpf?: number }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, payments } = body;
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const parsed: PaymentInput[] = [];
  for (const p of payments ?? []) {
    if (!p.method || !VALID_METHODS.includes(p.method as PayMethod)) {
      return NextResponse.json({ error: `method invalide (attendu: ${VALID_METHODS.join(", ")})` }, { status: 400 });
    }
    if (p.amountXpf === undefined || p.amountXpf === null) {
      return NextResponse.json({ error: "amountXpf requis sur chaque paiement" }, { status: 400 });
    }
    parsed.push({
      method: p.method as PayMethod,
      amountXpf: BigInt(Math.round(p.amountXpf)),
      tenderedXpf: p.tenderedXpf !== undefined && p.tenderedXpf !== null ? BigInt(Math.round(p.tenderedXpf)) : undefined,
    });
  }

  const result = await checkoutSale(tenantId, saleId, parsed);

  if (!result.ok) {
    const map: Record<string, number> = {
      SALE_NOT_FOUND: 404,
      ALREADY_VOID: 409,
      NO_PAYMENT: 409,
      UNDERPAID: 409,
      OVERPAID: 409,
    };
    return NextResponse.json(result, { status: map[result.error] ?? 400 });
  }
  return NextResponse.json(result);
}
