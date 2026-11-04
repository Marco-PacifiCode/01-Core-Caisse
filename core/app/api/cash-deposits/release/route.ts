import { NextRequest } from "next/server";
import { cashHttp, cashResponse } from "@/lib/cash-shared-http";
import { withTenant } from "@/lib/tenant";
import { uuid } from "@/lib/caisse-sync";
import { releaseLease, readDepositBody } from "@/lib/cash-deposits";

// S2S : même garde X-Core-Key / tenant que /api/cash-deposits. Contrat : docs/cash-deposits-apply.md.
export function POST(req: NextRequest) {
  return cashHttp(req, async () => {
    const raw = await readDepositBody(req.body);
    const tenantId = uuid((raw as { tenantId?: unknown })?.tenantId);
    return cashResponse(await withTenant(tenantId, tx => releaseLease(tx, raw)), 200);
  });
}
