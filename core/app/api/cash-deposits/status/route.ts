import { NextRequest } from "next/server";
import { cashHttp, cashResponse } from "@/lib/cash-shared-http";
import { withTenant } from "@/lib/tenant";
import { uuid } from "@/lib/caisse-sync";
import { depositStatuses, readDepositBody, validateStatusInput } from "@/lib/cash-deposits";

// S2S : même garde X-Core-Key / tenant que /api/cash-deposits (cashHttp → hasServiceKey). Lecture seule.
// Contrat : docs/cash-deposits-apply.md, « État des dépôts ».
export function POST(req: NextRequest) {
  return cashHttp(req, async () => {
    const raw = await readDepositBody(req.body);
    validateStatusInput(raw);
    const tenantId = uuid((raw as { tenantId?: unknown })?.tenantId);
    return cashResponse(await withTenant(tenantId, tx => depositStatuses(tx, raw)), 200);
  });
}
