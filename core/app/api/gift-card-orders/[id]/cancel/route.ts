import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { UUID_RE, normalizeText } from "@/lib/gift-card";
import { serializeGiftCardOrder } from "@/lib/gift-card-order";
import { cancelGiftCardOrder } from "@/lib/gift-card-orders-db";

export const runtime = "nodejs";

/**
 * POST /api/gift-card-orders/:id/cancel — annule une commande EN ATTENTE (S2S, X-Core-Key).
 *
 * 🔴 Seule une commande PENDING s'annule : la condition est dans le `WHERE` de l'`UPDATE`, pas
 *    dans un `if` applicatif — une annulation concurrente d'un encaissement ne peut pas passer.
 *    Rien n'a été encaissé : annuler n'écrit aucune comptabilité.
 *
 * Body : { tenantId, reason?, by?, byName? }
 *
 * Réponses :
 *   200 { ok:true, order }
 *   400 tenantId manquant
 *   401 clé de service absente
 *   404 { ok:false, error:"NOT_FOUND" }
 *   409 { ok:false, error:"NOT_PENDING" } — déjà payée ou déjà annulée
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return NextResponse.json({ ok: false, error: "tenantId requis" }, { status: 400 });
  }
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

  const result = await cancelGiftCardOrder(tenantId, id, {
    reason: normalizeText(body.reason, 200),
    by: typeof body.by === "string" ? body.by : null,
    byName: typeof body.byName === "string" ? body.byName : null,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.error === "NOT_FOUND" ? 404 : 409 });
  }
  return NextResponse.json({ ok: true, order: serializeGiftCardOrder(result.order) });
}
