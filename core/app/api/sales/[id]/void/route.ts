import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { annulerVente } from "@/lib/caisse";

export const runtime = "nodejs";

/**
 * POST /api/sales/:id/void
 * ANNULE une vente (S2S, X-Core-Key), quel que soit son état :
 *   DRAFT → VOID direct, aucun appel externe.
 *   PAID  → émet un AVOIR côté Compta (si une facture existe) PUIS passe VOID. Refuse si du stock a
 *           déjà été décrémenté (409 STOCK_DECREMENTED — remettre du stock n'est pas fait ici).
 *   VOID  → idempotent, rejouer ne fait jamais échouer (`alreadyVoid:true`).
 *
 * Body : { tenantId, reason?, actionId? } ; Idempotency-Key accepte le même UUID.
 * Réponse 200 : { ok:true, alreadyVoid?, creditNoteId? }
 * Erreurs : 404 SALE_NOT_FOUND · 409 STOCK_DECREMENTED · 502 CREDIT_NOTE_FAILED.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: saleId } = await ctx.params;

  let body: { tenantId?: string; reason?: string; actionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, reason } = body;
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const headerActionId = req.headers.get("Idempotency-Key") ?? undefined;
  if (body.actionId !== undefined && (typeof body.actionId !== "string" || body.actionId.length === 0)) {
    return NextResponse.json({ error: "actionId invalide" }, { status: 400 });
  }
  const normalizedHeaderActionId = headerActionId?.toLowerCase();
  const normalizedBodyActionId = body.actionId?.toLowerCase();
  if (normalizedHeaderActionId && normalizedBodyActionId && normalizedHeaderActionId !== normalizedBodyActionId) {
    return NextResponse.json({ error: "ACTION_ID_CONFLICT" }, { status: 400 });
  }
  const rawActionId = normalizedHeaderActionId ?? normalizedBodyActionId;
  if (rawActionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawActionId)) {
    return NextResponse.json({ error: "actionId doit être un UUID" }, { status: 400 });
  }
  const actionId = rawActionId;

  let result;
  try {
    result = await annulerVente(tenantId, saleId, { ...(reason ? { reason } : {}), ...(actionId ? { actionId } : {}) });
  } catch {
    return NextResponse.json({ ok: false, error: "VOID_FAILED" }, { status: 502 });
  }

  if (!result.ok) {
    const map: Record<string, number> = {
      SALE_NOT_FOUND: 404,
      STOCK_DECREMENTED: 409,
      CREDIT_NOTE_FAILED: 502,
      ACTION_ID_CONFLICT: 409,
      VOID_RETRY_INVOICE_CHANGED: 409,
      VOID_RETRY_STATUS_CHANGED: 409,
    };
    return NextResponse.json(result, { status: map[result.error] ?? 400 });
  }
  return NextResponse.json(result);
}
