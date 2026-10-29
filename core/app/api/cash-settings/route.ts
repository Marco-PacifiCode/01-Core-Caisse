import { NextRequest } from "next/server";
import { cashRead, cashWrite } from "@/lib/cash-shared-http";
import { changeSettings } from "@/lib/cash-shared-data";
export function GET(req: NextRequest) {
  return cashRead(req, async (tx, tenantId) => {
    const settings = await tx.cashSettings.findUnique({ where: { tenantId } });
    return settings ? { ...settings, toCloseEnabled: (settings as typeof settings & { toCloseEnabled?: boolean }).toCloseEnabled ?? false }
      : { tenantId, defaultFloatXpf: "25000", allowNegativeStock: false, toCloseEnabled: false, revision: 0 };
  });
}
export function PATCH(req: NextRequest) { return cashWrite(req, "cash-settings:patch", changeSettings); }
