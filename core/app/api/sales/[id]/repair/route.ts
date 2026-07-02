import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { repairSale } from "@/lib/caisse";

export const runtime = "nodejs";

/**
 * POST /api/sales/:id/repair — REPRISE ciblée de la synchro d'une vente (S2S, X-Core-Key).
 * Rejoue UNIQUEMENT les étapes Compta/Stock manquantes d'une vente PAID (idempotent : toutes les
 * cibles dédupliquent — facture par sourceId, settle par paymentRef, mouvement stock par ligne).
 * Sans effet si la vente est déjà convergée (alreadySynced=true).
 *
 * Body : { tenantId }
 * Réponse 200 : { ok, saleId, synced, alreadySynced, invoiceId, invoiceNumber, stockDecremented, syncError }
 *   synced=false → l'étape manquante a ENCORE échoué (détail dans syncError) ; rejouable.
 * Erreurs : 404 SALE_NOT_FOUND · 409 NOT_PAID (une vente non encaissée n'a rien à réparer).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: saleId } = await ctx.params;

  let body: { tenantId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const result = await repairSale(body.tenantId, saleId);
  if (!result.ok) {
    const status = result.error === "SALE_NOT_FOUND" ? 404 : 409;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
