import { NextRequest } from "next/server";
import { cashRead, cashWrite } from "@/lib/cash-shared-http";
import { createBasket } from "@/lib/cash-shared-data";
import { page, pageQuery } from "@/lib/caisse-sync";
export function GET(req: NextRequest) {
  return cashRead(req, async (tx, tenantId, q) => {
    const { cursor, take } = pageQuery(q);
    const rows = await tx.parkedBasket.findMany({ where: { tenantId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take });
    return page(rows);
  });
}
export function POST(req: NextRequest) { return cashWrite(req, "parked-baskets:create", createBasket); }
