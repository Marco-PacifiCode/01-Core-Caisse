import { NextRequest } from "next/server";
import { cashWrite } from "@/lib/cash-shared-http";
import { attachLegacy } from "@/lib/cash-days";
import { uuid } from "@/lib/caisse-sync";
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return cashWrite(req, `cash-days:${id}:attach-legacy`, (tx, b) => attachLegacy(tx, uuid(id), b));
}
