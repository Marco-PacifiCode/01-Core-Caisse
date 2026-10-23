import { cashDayGuard, CASHDAY_ROUTE_REQUIRED } from "@/lib/cash-day-guard";
import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { horsPortee } from "@/lib/cles-service";
import { reopenSession } from "@/lib/caisse";
import { CashContractError } from "@/lib/cash-day-projection";

/**
 * POST /api/sessions/:id/reopen
 * RÉOUVERTURE de la DERNIÈRE session clôturée de sa portée (poste, ou marchand sans poste).
 * La fermeture annulée est tracée (CashSessionReopen) ; la session repasse OPEN.
 *
 * Body : { tenantId, by? }
 * Réponse 200 : { ok, sessionId, reopenId } · 404 SESSION_NOT_FOUND
 * · 409 { ok:false, error: SESSION_NOT_CLOSED | SESSION_ALREADY_OPEN | NOT_LAST_SESSION, message }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: sessionId } = await ctx.params;

  let body: { tenantId?: string; by?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId } = body;
  if (!tenantId) return NextResponse.json({ error: "tenantId est requis" }, { status: 400 });
  const refus = horsPortee(req, tenantId); if (refus) return refus;

  let result;
  try {
    if (await cashDayGuard(tenantId, { sessionId })) return NextResponse.json(CASHDAY_ROUTE_REQUIRED, { status: 409 });
    result = await reopenSession(tenantId, { sessionId, by: body.by?.trim() || null });
  } catch (error) {
    if (error instanceof CashContractError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  if (!result.ok) return NextResponse.json(result, { status: result.error === "SESSION_NOT_FOUND" ? 404 : 409 });
  return NextResponse.json(result);
}
