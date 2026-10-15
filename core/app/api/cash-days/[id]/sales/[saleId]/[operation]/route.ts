import { NextRequest } from "next/server";
import { cashHttp, cashResponse } from "@/lib/cash-shared-http";
import { envelope, uuid } from "@/lib/caisse-sync";
import { dayFinancial } from "@/lib/cash-day-finance";
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; saleId: string; operation: string }> }) {
  return cashHttp(req, async () => {
    const { id, saleId, operation } = await ctx.params;
    const b = envelope(await req.json(), req.headers.get("Idempotency-Key"));
    const result = await dayFinancial(uuid(id), uuid(saleId), operation, b);
    const value = result as { ok?: boolean; status?: number };
    return cashResponse(result, value.ok === false ? value.status ?? 409 : 200);
  });
}
