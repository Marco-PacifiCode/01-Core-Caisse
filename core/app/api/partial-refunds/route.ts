import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { withTenant } from "@/lib/tenant";
import { listRefunds, parseRefundRange } from "@/lib/partial-refund-list";

export const runtime = "nodejs";

/**
 * GET /api/partial-refunds?tenantId=<uuid>&from=<ISO>&to=<ISO>
 * Lecture S2S (X-Core-Key) des avoirs partiels DONE dont la date de confirmation ∈ [from, to[ (92 jours max).
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });
  const range = parseRefundRange(searchParams.get("from"), searchParams.get("to"));
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });
  const rows = await withTenant(tenantId, (tx) => tx.partialRefund.findMany({
    where: { tenantId, status: "DONE", createdAt: { gte: range.sqlFrom, lt: range.to } },
  }));
  return NextResponse.json({ refunds: listRefunds(rows, range) });
}
