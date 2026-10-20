import { cashDayGuard, CASHDAY_ROUTE_REQUIRED } from "@/lib/cash-day-guard";
import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { horsPortee } from "@/lib/cles-service";
import { closeSession } from "@/lib/caisse";
import { CashContractError } from "@/lib/cash-day-projection";

/**
 * POST /api/sessions/:id/close
 * CLÔTURE Z d'une session (S2S, X-Core-Key) : calcule l'attendu (fond + encaissements ESPÈCES) vs le
 * compté (saisie caissier), enregistre l'écart, passe la session CLOSED. Idempotent (une session déjà
 * clôturée renvoie son rapport figé).
 *
 * Body : { tenantId, closedBy, closingCountedXpf }
 * Réponse 200 : { ok, alreadyClosed, report } · 404 SESSION_NOT_FOUND
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: sessionId } = await ctx.params;

  let body: { tenantId?: string; closedBy?: string; closedByName?: string; closingCountedXpf?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, closedBy, closingCountedXpf } = body;
  if (!tenantId || !closedBy || closingCountedXpf === undefined || closingCountedXpf === null) {
    return NextResponse.json({ error: "tenantId, closedBy et closingCountedXpf sont requis" }, { status: 400 });
  }
  const refus = horsPortee(req, tenantId); if (refus) return refus;

  let result;
  try {
    if (await cashDayGuard(tenantId, { sessionId })) return NextResponse.json(CASHDAY_ROUTE_REQUIRED, { status: 409 });
    result = await closeSession(tenantId, {
      sessionId,
      closedBy,
      closedByName: body.closedByName?.trim() || undefined,
      closingCountedXpf: BigInt(Math.round(closingCountedXpf)),
    });
  } catch (error) {
    if (error instanceof CashContractError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  if (!result.ok) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
