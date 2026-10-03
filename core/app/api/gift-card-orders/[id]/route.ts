import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { UUID_RE } from "@/lib/gift-card";
import { serializeGiftCardOrder } from "@/lib/gift-card-order";
import { getGiftCardOrder } from "@/lib/gift-card-orders-db";

export const runtime = "nodejs";

/**
 * GET /api/gift-card-orders/:id — une commande de bon en ligne (S2S, X-Core-Key).
 *
 * Query : ?tenantId=…
 *
 * Réponses : 200 { ok:true, order } · 400 tenantId manquant · 401 clé absente ·
 *            404 { ok:false, error:"NOT_FOUND" } (inconnue OU d'un autre marchand).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const url = new URL(req.url);
  const tenantId = (url.searchParams.get("tenantId") ?? "").trim();
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return NextResponse.json({ ok: false, error: "tenantId requis" }, { status: 400 });
  }
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

  const order = await getGiftCardOrder(tenantId, id);
  if (!order) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ ok: true, order: serializeGiftCardOrder(order) });
}
