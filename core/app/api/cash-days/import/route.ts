import { NextRequest } from "next/server";
import { cashWrite } from "@/lib/cash-shared-http";
import { attachLegacy, closeCashDay, openCashDay } from "@/lib/cash-days";
import { object, requireCash } from "@/lib/cash-day-projection";
import type { ActionInput } from "@/lib/caisse-sync";
export function POST(req: NextRequest) {
  return cashWrite(req, "cash-days:import", async (tx, b) => {
    requireCash(b.importMode === true);
    const day = await openCashDay(tx, b);
    if (b.sessionIds !== undefined || b.origins !== undefined || b.localVoids !== undefined) await attachLegacy(tx, day.id, { ...b, cycle: b.cycle ?? 0 });
    const closure = b.closure === undefined ? null : await closeCashDay(tx, day.id, { ...b, ...object(b.closure), tenantId: b.tenantId,
      actionId: b.actionId, deviceId: b.deviceId, entityKey: b.entityKey, importMode: true, closureMode: "IMPORT" } as ActionInput);
    return { ...day, closure };
  });
}
