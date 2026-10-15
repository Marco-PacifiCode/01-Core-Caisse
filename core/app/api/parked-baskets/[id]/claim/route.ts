import { NextRequest } from "next/server";
import { cashWrite } from "@/lib/cash-shared-http";
import { changeBasket } from "@/lib/cash-shared-data";
import { uuid } from "@/lib/caisse-sync";
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return cashWrite(req, `parked-baskets:${id}:claim`, (tx, b) => changeBasket(tx, uuid(id), b, true));
}
