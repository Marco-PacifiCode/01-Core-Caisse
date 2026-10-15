import { withTenant } from "./tenant";

export const CASHDAY_ROUTE_REQUIRED = { ok: false, error: "CASHDAY_ROUTE_REQUIRED" } as const;
type LegacyWrite = { openSession: true } | { sessionId?: string | null } | { saleId: string; refundCashDayId?: string };

/** Toute écriture historique doit passer par l'API CashDay dès qu'un jour existe. */
export async function cashDayGuard(tenantId: string, target: LegacyWrite): Promise<boolean> {
  return withTenant(tenantId, async tx => {
    const days = await tx.cashDay.findFirst({ where: { tenantId }, select: { id: true } });
    if (!days) return false;
    if ("saleId" in target) {
      if (target.refundCashDayId && await tx.cashDay.findFirst({ where: { tenantId, id: target.refundCashDayId }, select: { id: true } })) return false;
      const sale = await tx.sale.findFirst({ where: { tenantId, id: target.saleId }, select: { sessionId: true, cashDayId: true } });
      if (target.refundCashDayId && sale?.sessionId) {
        const canonical = await tx.cashDay.findFirst({ where: { tenantId, canonicalSessionId: sale.sessionId }, select: { id: true } });
        const alias = await tx.cashDaySession.findUnique({ where: { tenantId_sessionId: { tenantId, sessionId: sale.sessionId } } });
        if ([sale.cashDayId, canonical?.id, alias?.cashDayId].includes(target.refundCashDayId)) return false;
      } else if (target.refundCashDayId && sale?.cashDayId === target.refundCashDayId) return false;
    }
    return true;
  });
}
