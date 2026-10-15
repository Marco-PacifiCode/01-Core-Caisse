import { NextRequest } from "next/server";
import { cashRead, cashWrite } from "@/lib/cash-shared-http";
import { createPickup } from "@/lib/cash-shared-data";
import { page, pageQuery } from "@/lib/caisse-sync";
import { validDay } from "@/lib/cash-day-projection";
export function GET(req: NextRequest) {
  return cashRead(req, async (tx, tenantId, q) => {
    const { cursor, take } = pageQuery(q);
    const rows = await tx.pickupOrder.findMany({ where: { tenantId, ...(cursor ? { id: { gt: cursor } } : {}),
      ...(q.has("pickupDay") ? { pickupDay: validDay(q.get("pickupDay")) } : {}) }, orderBy: { id: "asc" }, take });
    return page(rows);
  });
}
export function POST(req: NextRequest) { return cashWrite(req, "pickup-orders:create", createPickup); }
