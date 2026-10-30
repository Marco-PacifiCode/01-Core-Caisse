import { NextRequest } from "next/server";
import { cashHttp, cashResponse } from "@/lib/cash-shared-http";
import { HorsPorteeError, identifierCle } from "@/lib/cles-service";
import { withTenant } from "@/lib/tenant";
import { claimDeposits, readDepositBody, validateClaimInput } from "@/lib/cash-deposits";
export function POST(req: NextRequest) { return cashHttp(req, async () => {
 const input = validateClaimInput(await readDepositBody(req.body));
 const caller = identifierCle(req.headers.get("x-core-key"));
 if (caller && !caller.tenants.includes("*") && !caller.tenants.includes(input.tenantId)) return cashResponse({ error: "HORS_PORTEE" }, 403);
 try { const result = await withTenant(input.tenantId, tx => claimDeposits(tx, input));
   // Transmet nextAfter tel quel : la page suivante renouvelle aussi le bail.
   return result ? cashResponse(result) : cashResponse({ error: "LEASE_HELD" }, 409);
 } catch (e) { if (e instanceof HorsPorteeError) return cashResponse({ error: "HORS_PORTEE" }, 403); throw e; }
}); }
