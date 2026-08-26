import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { corrigerMoyenPaiement } from "@/lib/caisse";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * POST /api/sales/:id/payment-correction
 * CORRIGE le moyen de paiement d'un ticket déjà encaissé (S2S, X-Core-Key), par contre-écriture :
 * un `SalePayment` négatif sur l'ancien moyen, un positif sur le nouveau. `SalePayment` n'est
 * JAMAIS modifié, et `Sale.totalXpf` ne bouge pas — seule la répartition par moyen change.
 *
 * Body : { tenantId, fromMethod, toMethod, amountXpf, correctedBy?, correctedByName?, reason? }
 * (les trois derniers ne servent QUE le log ci-dessous — aucun champ en base pour eux.)
 * Réponse 200 : { ok:true, alreadyCorrected, payments }
 * Erreurs : 400 champs manquants/INVALID · 404 SALE_NOT_FOUND ·
 *           409 NOT_PAID/NO_INVOICE/NOT_SYNCED/TOO_OLD/NOTHING_TO_CORRECT ·
 *           502 COMPTA_CORRECTION_FAILED.
 *
 * ⚠️ Une session CLOTURÉE ne bloque PLUS la correction (décision Marco, 2026-08-26) : le Z d'une
 * journée close n'est pas réécrit, l'écart se constate au recomptage. Seule l'ANCIENNETÉ du
 * paiement (>1 mois calendaire, cf. lib/fenetre-correction.ts) refuse désormais — TOO_OLD.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: saleId } = await ctx.params;

  let body: {
    tenantId?: string;
    fromMethod?: string;
    toMethod?: string;
    amountXpf?: number;
    correctedBy?: string;
    correctedByName?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, fromMethod, toMethod, amountXpf, correctedBy, correctedByName, reason } = body;
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });
  if (!fromMethod || !toMethod) {
    return NextResponse.json({ error: "fromMethod et toMethod requis" }, { status: 400 });
  }
  if (typeof amountXpf !== "number") {
    return NextResponse.json({ error: "amountXpf requis" }, { status: 400 });
  }

  const result = await corrigerMoyenPaiement(tenantId, { saleId, fromMethod, toMethod, amountXpf });

  if (!result.ok) {
    const map: Record<string, number> = {
      INVALID: 400,
      SALE_NOT_FOUND: 404,
      NOT_PAID: 409,
      NO_INVOICE: 409,
      NOT_SYNCED: 409,
      TOO_OLD: 409,
      NOTHING_TO_CORRECT: 409,
      COMPTA_CORRECTION_FAILED: 502,
    };
    return NextResponse.json(result, { status: map[result.error] ?? 400 });
  }

  log.info("sale.payment_correction", {
    saleId,
    tenantId,
    fromMethod,
    toMethod,
    amountXpf,
    correctedBy: correctedBy ?? null,
    correctedByName: correctedByName ?? null,
    reason: reason ?? null,
    alreadyCorrected: result.alreadyCorrected,
  });

  return NextResponse.json(result);
}
