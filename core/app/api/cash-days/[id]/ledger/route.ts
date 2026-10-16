import { NextRequest } from "next/server";
import { cashRead } from "@/lib/cash-shared-http";
import { ledgerPage } from "@/lib/cash-days";
import { uuid } from "@/lib/caisse-sync";
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return cashRead(req, (tx, tenantId, q) => ledgerPage(tx, tenantId, uuid(id), q));
}
