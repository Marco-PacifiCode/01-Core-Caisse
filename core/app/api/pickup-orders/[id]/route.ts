import { NextRequest } from "next/server";
import { cashWrite } from "@/lib/cash-shared-http";
import { changePickup } from "@/lib/cash-shared-data";
import { uuid } from "@/lib/caisse-sync";
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return cashWrite(req, `pickup-orders:${id}:patch`, (tx, b) => changePickup(tx, uuid(id), b, false));
}
