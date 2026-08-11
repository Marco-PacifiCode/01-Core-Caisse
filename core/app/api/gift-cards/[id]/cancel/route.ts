import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { cancelGiftCard } from "@/lib/caisse";
import { normalizeText } from "@/lib/gift-card";

export const runtime = "nodejs";

/**
 * POST /api/gift-cards/:id/cancel — ANNULE un bon cadeau (S2S, X-Core-Key).
 *
 * ⚖️ DROIT : annuler est réservé à l'ADMINISTRATRICE — pas au comptoir. Le contrôle est fait par
 *    la SURFACE : le moteur ne connaît ni rôles ni sessions, il ne connaît qu'une clé de service.
 *    Une surface qui appellerait cette route depuis un écran de caisse ouvrirait le droit à
 *    tout le monde ; c'est le seul endroit où ça peut se perdre, et c'est écrit ici pour ça.
 *
 * 🔒 ANNULER NE REMBOURSE RIEN et n'écrit AUCUNE comptabilité. L'argent du bon est entré dans le
 *    chiffre d'affaires le jour de l'achat. S'il doit ressortir, c'est un AVOIR : une autre
 *    pièce, un autre geste, et une décision qui appartient au commerce — pas à ce moteur.
 *
 * 🔴 Un bon DÉJÀ CONSOMMÉ ne s'annule pas : la condition est dans le `WHERE` de l'`UPDATE`, pas
 *    dans un `if` applicatif. Sans elle, une annulation lancée pendant qu'une consommation
 *    aboutit effacerait la trace d'une prestation réellement rendue.
 *
 * Body : { tenantId, reason?, cancelledBy?, cancelledByName? }
 *
 * Réponses :
 *   200 { ok:true, giftCard }
 *   400 tenantId manquant
 *   401 clé de service absente
 *   404 { error:"NOT_FOUND" }
 *   409 { error:"ALREADY_REDEEMED" } · { error:"ALREADY_CANCELLED" }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const result = await cancelGiftCard(tenantId, id, {
    reason: normalizeText(body.reason, 200),
    cancelledBy: typeof body.cancelledBy === "string" ? body.cancelledBy : null,
    cancelledByName: typeof body.cancelledByName === "string" ? body.cancelledByName : null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "NOT_FOUND" ? 404 : 409 });
  }
  return NextResponse.json({ ok: true, giftCard: result.card });
}
