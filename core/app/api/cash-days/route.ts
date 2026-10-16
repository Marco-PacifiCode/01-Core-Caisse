// API opt-in L4 : remplace les extensions des routes sessions sans modifier leur contrat.
import { NextRequest } from "next/server";
import { cashRead, cashWrite } from "@/lib/cash-shared-http";
import { dayState, listCashDays, openCashDay } from "@/lib/cash-days";
import { validDay, requireCash } from "@/lib/cash-day-projection";
export function POST(req: NextRequest) { return cashWrite(req, "cash-days:open", openCashDay); }
export function GET(req: NextRequest) {
  return cashRead(req, async (tx, tenantId, q) => {
    requireCash(!q.has("scope") || q.get("scope") === "rotisserie-caisse");
    if (!q.has("businessDay")) return listCashDays(tx, tenantId, q);
    const day = await tx.cashDay.findUnique({ where: { tenantId_scope_businessDay: { tenantId, scope: "rotisserie-caisse", businessDay: validDay(q.get("businessDay")) } } });
    const settings = await tx.cashSettings.findUnique({ where: { tenantId } });
    return { day: day ? await dayState(tx, tenantId, day.id) : null, defaultFloatXpf: settings?.defaultFloatXpf ?? 25000n };
  });
}
