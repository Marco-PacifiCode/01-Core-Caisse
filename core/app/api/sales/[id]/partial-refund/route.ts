import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { rembourserPartiellement } from "@/lib/caisse";
import { validRefundInput } from "@/lib/partial-refund";

export const runtime = "nodejs";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** POST /api/sales/:id/partial-refund — S2S, montants calculés depuis la vente. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const tenantId = (body as { tenantId?: unknown } | null)?.tenantId;
  if (typeof tenantId !== "string" || !uuid.test(tenantId) || !uuid.test(id) || !validRefundInput(body)) {
    return NextResponse.json({ error: "INVALID_REFUND_INPUT" }, { status: 400 });
  }
  // tenantId n'appartient pas à l'empreinte métier ni au JSON de réservation.
  const { actionId, reason, lines, refundMethod, createdBy, createdByName } = body;
  try {
    const result = await rembourserPartiellement(tenantId, id, { actionId, reason, lines, refundMethod,
      ...(createdBy !== undefined ? { createdBy } : {}), ...(createdByName !== undefined ? { createdByName } : {}) });
    return NextResponse.json(result, { status: result.ok ? 200 : result.status ?? 409 });
  } catch {
    return NextResponse.json({ ok: false, error: "REFUND_RETRY_REQUIRED" }, { status: 502 });
  }
}
