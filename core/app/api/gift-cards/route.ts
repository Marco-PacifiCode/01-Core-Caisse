import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { createGiftCardWithoutSale, listGiftCards } from "@/lib/caisse";
import { normalizeCode } from "@/lib/gift-card";

export const runtime = "nodejs";

/**
 * GET /api/gift-cards — les bons cadeaux d'un marchand (S2S, X-Core-Key).
 *
 * Query : ?tenantId=… [&code=…] [&take=…]
 *   · code : recherche EXACTE sur le code normalisé (majuscules, sans séparateur). « bc 4k7q-p2 »
 *     retrouve « BC4K7QP2 » : un code se recopie à la main d'un bon papier, et refuser une graphie
 *     au comptoir n'apporte rien à personne.
 *   · take : borné à 500 par le moteur.
 *
 * 🔒 AUCUN STATUT N'EST RENVOYÉ. « Valide / expiré / consommé / annulé » se DÉRIVE à la lecture,
 *    chez l'appelant, à partir de `expiresAt`, `redeemedAt` et `cancelledAt` (lib/gift-card.ts,
 *    `giftCardStatus`). Un statut calculé ici serait figé à l'instant de la requête, donc faux la
 *    minute d'après — et le stocker imposerait un travail de fond qui fait muter la production
 *    toute seule.
 *
 * Réponses : 200 { ok:true, giftCards:[…] } · 400 tenantId manquant · 401 clé de service absente.
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tenantId = (url.searchParams.get("tenantId") ?? "").trim();
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const rawCode = url.searchParams.get("code");
  const code = rawCode ? normalizeCode(rawCode) : undefined;
  const rawTake = Number(url.searchParams.get("take") ?? "");
  const take = Number.isFinite(rawTake) && rawTake > 0 ? Math.min(rawTake, 500) : undefined;

  const giftCards = await listGiftCards(tenantId, { code: code || undefined, take });
  return NextResponse.json({ ok: true, giftCards });
}

/**
 * POST /api/gift-cards — fait naître un bon SANS AUCUN ENCAISSEMENT (S2S, X-Core-Key).
 *
 * ⚠️ CE N'EST PAS LE CHEMIN D'ACHAT, ET IL NE FAUT PAS S'EN SERVIR COMME TEL.
 *
 * Un bon ACHETÉ est le jumeau d'une vente au comptoir : l'argent est encaissé, le Z le compte,
 * une facture part au nom de l'ACHETEUR. Il naît donc DANS la transaction du passage à PAID de
 * `POST /api/sales/:id/checkout`, via le champ optionnel `giftCards[]` — c'est ce qui garantit
 * qu'il n'existe aucune fenêtre entre « l'argent est pris » et « le bon existe ».
 *
 * Cette route-ci ne sert qu'au bon ÉMIS SANS CONTREPARTIE (geste commercial, remplacement d'un
 * bon papier abîmé, reprise d'un historique). Elle n'écrit AUCUNE comptabilité et n'en écrira
 * jamais : rien n'a été payé, donc rien n'entre dans le chiffre d'affaires. C'est cohérent avec
 * l'invariant du module — le montant d'un bon entre dans le CA une seule fois, LE JOUR DE SON
 * ACHAT — et ici, il n'y a pas eu d'achat.
 *
 * Body : { tenantId, code, amountXpf, serviceLabel?, serviceId?, buyer*?, beneficiary*?, expiresAt?,
 *          reason? }
 *
 * Réponses :
 *   200 { ok:true, giftCard }
 *   400 { error:<refus nommé> } — validation (montant, code, bénéficiaire, date)
 *   401 clé de service absente
 *   409 { error:"CODE_TAKEN" } — le code existe déjà chez ce marchand (garanti EN BASE par
 *       @@unique(tenantId, code) : ce n'est pas une vérification applicative qu'une course
 *       pourrait doubler).
 */
export async function POST(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const result = await createGiftCardWithoutSale(tenantId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "CODE_TAKEN" ? 409 : 400 });
  }
  return NextResponse.json({ ok: true, giftCard: result.card });
}
