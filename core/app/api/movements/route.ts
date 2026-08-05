import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { recordCashMovement } from "@/lib/caisse";
import {
  isCashMovementKind,
  normalizeMovementAmount,
  normalizeMovementReason,
  normalizeMovementRef,
} from "@/lib/cash-movement";

/**
 * POST /api/movements
 * Enregistre un MOUVEMENT DE TIROIR sur la session de caisse OUVERTE du marchand (S2S, X-Core-Key).
 *
 * POURQUOI LA ROUTE N'EST PAS SOUS /api/sessions/:id/ : l'appelant (une surface qui vient d'émettre
 * un avoir) ne connaît PAS la session ouverte, et ne devrait pas avoir à la chercher — la lui faire
 * choisir, c'est lui offrir de se tromper de session. Le moteur la résout lui-même : une seule
 * session peut être OPEN par marchand.
 *
 * Body : { tenantId, kind, amountXpf, reason, ref?, createdBy?, createdByName? }
 *   · kind      : REFUND (remboursement d'avoir) · CASH_OUT (prélèvement) · CASH_IN (apport)
 *   · amountXpf : TOUJOURS POSITIF, entier. Le sens vient de `kind`, jamais du signe.
 *   · reason    : obligatoire — un écart de caisse sans justification n'est pas expliqué.
 *   · ref       : n° de pièce (ex. « AVO-2026-0001 »). Porte l'IDEMPOTENCE : rejouer le même
 *                 remboursement rend le mouvement existant, il n'en crée pas un second.
 *
 * Réponses :
 *   200 { ok:true, alreadyExisted, movement }
 *   400 validation (montant, kind, motif)
 *   401 clé de service absente
 *   409 { error:"NO_OPEN_SESSION" } — AUCUNE session ouverte. C'est un refus VOULU, pas une
 *       limitation : écrire sans session rendrait le mouvement invisible de tout Z, ce qui
 *       déplacerait l'écart muet au lieu de le supprimer. L'appelant doit dire à l'opératrice
 *       d'ouvrir sa caisse.
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

  if (!isCashMovementKind(body.kind)) {
    return NextResponse.json({ error: "kind invalide (REFUND | CASH_OUT | CASH_IN)" }, { status: 400 });
  }

  const amount = normalizeMovementAmount(body.amountXpf);
  if (!amount.ok) return NextResponse.json({ error: amount.error }, { status: 400 });

  const reason = normalizeMovementReason(body.reason);
  if (!reason) return NextResponse.json({ error: "REASON_REQUIRED" }, { status: 400 });

  const result = await recordCashMovement(tenantId, {
    kind: body.kind,
    amountXpf: amount.amountXpf,
    reason,
    ref: normalizeMovementRef(body.ref),
    createdBy: typeof body.createdBy === "string" ? body.createdBy : null,
    createdByName: typeof body.createdByName === "string" ? body.createdByName : null,
  });

  if (!result.ok) return NextResponse.json(result, { status: 409 });

  // xpf() n'est pas utilisé ici : on sérialise le seul BigInt à la main, explicitement.
  // Un BigInt laissé brut ferait LEVER NextResponse.json (« Do not know how to serialize »).
  return NextResponse.json({
    ok: true,
    alreadyExisted: result.alreadyExisted,
    movement: {
      id: result.movement.id,
      sessionId: result.movement.sessionId,
      kind: result.movement.kind,
      amountXpf: Number(result.movement.amountXpf),
    },
  });
}
