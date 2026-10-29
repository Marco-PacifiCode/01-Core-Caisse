import { NextRequest } from "next/server";
import { cashHttp, cashRead, cashResponse } from "@/lib/cash-shared-http";
import { withTenant } from "@/lib/tenant";
import { depositActions, listDeposits, readDepositBody, validateDepositInput } from "@/lib/cash-deposits";

export function POST(req: NextRequest) {
  return cashHttp(req, async () => {
    const raw = await readDepositBody(req.body);
    const input = validateDepositInput(raw);
    const result = await withTenant(input.tenantId, tx => depositActions(tx, raw));
    return cashResponse(result, 200);
  });
}
export function GET(req: NextRequest) {
  return cashRead(req, (tx, tenantId, q) => listDeposits(tx, { tenantId, status: q.get("status"), cursor: q.get("cursor"), limit: q.get("limit"), withPayload: q.get("withPayload") }));
}
