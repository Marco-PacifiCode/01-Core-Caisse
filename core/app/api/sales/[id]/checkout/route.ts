import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { checkoutSale, type PaymentInput } from "@/lib/caisse";
import type { GiftCardInput } from "@/lib/gift-card";
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
    /** Date ISO de l'encaissement réel (remontée différée d'une caisse hors ligne). */
    paidAt?: string;
    // OPTIONNEL, et c'est structurant : ce moteur est MUTUALISÉ entre marchands, et toutes les
    // surfaces n'émettent pas de bons cadeaux. Celles qui n'en émettent pas ne l'envoient pas,
    // ce bloc reste inerte, et leur requête comme leur réponse sont celles d'avant PC-0064, au
    // champ près. Une évolution du moteur ne doit jamais coûter une vérification à un marchand
    // qui n'a rien demandé.
    giftCards?: GiftCardInput[];
    // Bons cadeaux à CONSOMMER pendant cet encaissement. Aucun montant à encaisser n'y transite :
    // un bon n'est pas un moyen de paiement, son montant est entré dans le CA le jour de son
    // achat. La surface a déjà retiré du ticket ce que le bon couvre (ligne `OTHER` négative) ;
    // il ne reste ici qu'à le brûler, dans la transaction du passage à PAID.
    redeemGiftCards?: { id?: string; redeemedForXpf?: number | null; redeemedBy?: string | null; redeemedByName?: string | null }[];
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

  // `giftCards` n'est PAS validé ici : la validation est dans le moteur (`validateGiftCards`),
  // pour qu'elle tombe AVANT que le moindre franc soit acté et qu'aucun chemin d'appel ne puisse
  // la contourner. La route se contente de transmettre ; elle omet même la clé quand il n'y a
  // rien à transmettre, pour que l'appel soit à l'octet près celui d'avant PC-0064.
  const giftCards = Array.isArray(body.giftCards) && body.giftCards.length > 0 ? body.giftCards : undefined;

  // Idem pour la consommation : la route transmet, elle ne juge pas. Seul l'`id` est exigé ici,
  // parce qu'un `id` manquant n'est pas un refus métier mais une requête malformée.
  let redeemGiftCards: { id: string; redeemedForXpf?: number | null; redeemedBy?: string | null; redeemedByName?: string | null }[] | undefined;
  if (Array.isArray(body.redeemGiftCards) && body.redeemGiftCards.length > 0) {
    redeemGiftCards = [];
    for (const r of body.redeemGiftCards) {
      if (!r?.id || typeof r.id !== "string") {
        return NextResponse.json({ error: "redeemGiftCards : id requis sur chaque bon" }, { status: 400 });
      }
      redeemGiftCards.push({
        id: r.id,
        redeemedForXpf: r.redeemedForXpf ?? null,
        redeemedBy: r.redeemedBy ?? null,
        redeemedByName: r.redeemedByName ?? null,
      });
    }
  }

  // `paidAt` : encaissement rejoué depuis une caisse hors ligne (2026-08-15).
  // Une date illisible est refusée ici plutôt que transformée en « maintenant »
  // sans le dire.
  let paidAt: Date | undefined;
  if (body.paidAt) {
    const d = new Date(body.paidAt);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "paidAt : date ISO invalide" }, { status: 400 });
    }
    paidAt = d;
  }

  // On n'ajoute la clé d'options QUE si elle porte quelque chose : sans
  // `giftCards` ni `paidAt`, l'appel reste à l'octet près celui d'avant.
  const options =
    giftCards || paidAt || redeemGiftCards
      ? {
          ...(giftCards ? { giftCards } : {}),
          ...(paidAt ? { paidAt } : {}),
          ...(redeemGiftCards ? { redeemGiftCards } : {}),
        }
      : undefined;
  const result = await checkoutSale(tenantId, saleId, parsed, options);

  if (!result.ok) {
    const map: Record<string, number> = {
      SALE_NOT_FOUND: 404,
      ALREADY_VOID: 409,
      NO_PAYMENT: 409,
      UNDERPAID: 409,
      OVERPAID: 409,
      // Refus de bon cadeau : ils tombent AVANT tout encaissement, rien n'a été pris.
      GIFT_CARD_INVALID: 409,
      GIFT_CARD_CODE_TAKEN: 409,
      // Bon inconsommable (inconnu, deja brule, annule) : refus AVANT tout encaissement.
      GIFT_CARD_NOT_REDEEMABLE: 409,
    };
    return NextResponse.json(result, { status: map[result.error] ?? 400 });
  }
  return NextResponse.json(result);
}
