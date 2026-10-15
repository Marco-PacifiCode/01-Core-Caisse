import { NextRequest } from "next/server";
import { cashWrite } from "@/lib/cash-shared-http";
import { dayMovement } from "@/lib/cash-day-sales";
import { uuid } from "@/lib/caisse-sync";
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return cashWrite(req, `cash-days:${id}:movements`, (tx, b) => dayMovement(tx, uuid(id), b));
}
