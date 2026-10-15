import { withTenant } from "./tenant";

export const CASHDAY_ROUTE_REQUIRED = { ok: false, error: "CASHDAY_ROUTE_REQUIRED" } as const;
type LegacyWrite = { openSession: true } | { sessionId: string | null | undefined } | { saleId: string; refundCashDayId?: string };

/** Garde des entrées historiques uniquement ; les primitives CashDay restent accessibles. */
export async function cashDayGuard(tenantId: string, target: LegacyWrite): Promise<boolean> {
  return withTenant(tenantId, async tx => {
    if ("openSession" in target) return !!await tx.cashDay.findFirst({ where: { tenantId, currentSession: { status: "OPEN" } } });
    let sessionId: string | null | undefined;
    let cashDayId: string | null | undefined;
    if ("saleId" in target) {
      const sale = await tx.sale.findFirst({ where: { tenantId, id: target.saleId }, select: { sessionId: true, cashDayId: true } });
      sessionId = sale?.sessionId;
      cashDayId = sale?.cashDayId;
    } else sessionId = target.sessionId;
    if (sessionId) {
      const canonical = await tx.cashDay.findFirst({ where: { tenantId, canonicalSessionId: sessionId } });
      const alias = await tx.cashDaySession.findUnique({ where: { tenantId_sessionId: { tenantId, sessionId } } });
      const owners = [cashDayId, canonical?.id, alias?.cashDayId].filter((id): id is string => !!id);
      if ("saleId" in target && target.refundCashDayId && owners.length && owners.every(id => id === target.refundCashDayId)) return false;
      return owners.length > 0;
    }
    return !!cashDayId && !("saleId" in target && target.refundCashDayId === cashDayId);
  });
}
