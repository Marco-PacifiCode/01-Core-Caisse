import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { redeemGiftCard } from "@/lib/caisse";
import { normalizeRedeemedFor } from "@/lib/gift-card";

export const runtime = "nodejs";

/**
 * POST /api/gift-cards/:id/redeem — CONSOMME un bon cadeau (S2S, X-Core-Key).
 *
 * 🔒 CETTE ROUTE N'ÉCRIT AUCUNE COMPTABILITÉ, ET C'EST TOUT SON SUJET.
 *    Aucune vente, aucun paiement, aucun mouvement de tiroir, aucune facture, aucun total du Z.
 *    Le montant du bon est entré dans le chiffre d'affaires LE JOUR DE SON ACHAT ; l'encaisser
 *    une seconde fois le jour où la cliente le présente compterait le même argent deux fois.
 *    Si un jour cette route se met à appeler Compta ou à créer une `Sale`, le CA du salon est
 *    faux — c'est la seule façon de se tromper vraiment gravement ici.
 *
 * 🔴 L'UNICITÉ EST GARANTIE PAR LA BASE, PAS PAR CETTE ROUTE. `redeemGiftCard` écrit un unique
 *    `UPDATE … WHERE "redeemedAt" IS NULL`, jamais un `SELECT` suivi d'un `UPDATE` : deux
 *    comptoirs qui présentent le même bon à la même seconde ne peuvent pas le passer deux fois.
 *    Zéro ligne affectée ⇒ 409 ALREADY_REDEEMED.
 *
 * ⚖️ DROIT : consommer un bon est un geste de comptoir → droit `caisse`. Le contrôle est fait par
 *    la SURFACE (le moteur ne connaît ni rôles ni sessions, il ne connaît qu'une clé de service).
 *
 * 📅 UN BON PÉRIMÉ N'EST PAS REFUSÉ ICI. Accepter ou non un bon dont la date est passée est une
 *    décision du COMMERCE, pas du moteur : la cliente est au comptoir, le salon tranche. L'écran
 *    affiche la date de validité en clair, le moteur ne refuse que ce qui est objectivement
 *    impossible (déjà consommé, annulé).
 *
 * Body : { tenantId, redeemedBy?, redeemedByName?, redeemedForXpf? }
 *   · redeemedForXpf : prix affiché de la prestation le jour de l'échange. FACULTATIF, et il ne
 *     calcule AUCUN solde — le bon est BINAIRE, il n'y a pas de solde. Il ne sert qu'à recouper
 *     la caisse après coup.
 *
 * Réponses :
 *   200 { ok:true, giftCard }
 *   400 REDEEMED_FOR_NOT_INTEGER · REDEEMED_FOR_NEGATIVE · tenantId manquant
 *   401 clé de service absente
 *   404 { error:"NOT_FOUND" }
 *   409 { error:"ALREADY_REDEEMED" } · { error:"CANCELLED" }
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

  const forXpf = normalizeRedeemedFor(body.redeemedForXpf);
  if (!forXpf.ok) return NextResponse.json({ error: forXpf.error }, { status: 400 });

  const result = await redeemGiftCard(tenantId, id, {
    redeemedBy: typeof body.redeemedBy === "string" ? body.redeemedBy : null,
    redeemedByName: typeof body.redeemedByName === "string" ? body.redeemedByName : null,
    redeemedForXpf: forXpf.redeemedForXpf,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "NOT_FOUND" ? 404 : 409 });
  }
  return NextResponse.json({ ok: true, giftCard: result.card });
}
