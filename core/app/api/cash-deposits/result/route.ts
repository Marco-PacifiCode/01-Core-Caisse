import { NextRequest } from "next/server";
import { cashHttp, cashResponse } from "@/lib/cash-shared-http";
import { HorsPorteeError, identifierCle } from "@/lib/cles-service";
import { withTenant } from "@/lib/tenant";
import { readDepositBody, recordDepositResult, validateResultInput } from "@/lib/cash-deposits";
export function POST(req: NextRequest) { return cashHttp(req, async () => {
 const input = validateResultInput(await readDepositBody(req.body));
 const caller = identifierCle(req.headers.get("x-core-key"));
 if (caller && !caller.tenants.includes("*") && !caller.tenants.includes(input.tenantId)) return cashResponse({ error: "HORS_PORTEE" }, 403);
 try { const result = await withTenant(input.tenantId, tx => recordDepositResult(tx, input));
   return "error" in result ? cashResponse(result, 409) : cashResponse(result);
 } catch (e) { if (e instanceof HorsPorteeError) return cashResponse({ error: "HORS_PORTEE" }, 403); throw e; }
}); }
