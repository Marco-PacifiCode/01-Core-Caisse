import { NextRequest } from "next/server";
import { cashHttp, cashResponse } from "@/lib/cash-shared-http";
import { rectifyCashDay } from "@/lib/cash-days";
import { withTenant } from "@/lib/tenant";
import { uuid, type ActionInput } from "@/lib/caisse-sync";
import { object } from "@/lib/cash-day-projection";
import { horsPortee } from "@/lib/cles-service";

// Même attestation S2S Administration que reopen : administration: true.
// Le reçu immuable du Z assure le rejeu sans écriture, même après cinq minutes.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return cashHttp(req, async () => {
    const { id } = await ctx.params;
    const b = object(await req.json()) as ActionInput;
    const tenantId = uuid(b.tenantId);
    const refus = horsPortee(req, tenantId); if (refus) return refus;
    const data = await withTenant(tenantId, tx => rectifyCashDay(tx, uuid(id), b));
    return cashResponse({ ok: true, id: data.id, revision: data.revision, alreadyApplied: data.alreadyApplied, data });
  });
}
