import { withTenant } from "./tenant";

export const CASHDAY_ROUTE_REQUIRED = { ok: false, error: "CASHDAY_ROUTE_REQUIRED" } as const;
type LegacyWrite = { openSession: true } | { sessionId?: string | null } | { saleId: string; refundCashDayId?: string; paymentCorrection?: true };

/** Toute écriture historique doit passer par l'API CashDay dès qu'un jour existe. */
export async function cashDayGuard(tenantId: string, target: LegacyWrite): Promise<boolean> {
  return withTenant(tenantId, async tx => {
    const days = await tx.cashDay.findFirst({ where: { tenantId }, select: { id: true } });
    if (!days) return false;
    // Les corrections d'une vente rattachée écrivent déjà un fait PAYMENT_CORRECTION.
    if ("saleId" in target && target.paymentCorrection && (await tx.sale.findFirst({
      where: { tenantId, id: target.saleId }, select: { cashDayId: true },
    }))?.cashDayId) return false;
    if ("saleId" in target && target.refundCashDayId && await tx.cashDay.findFirst({
      where: { tenantId, id: target.refundCashDayId, currentSession: { status: "OPEN" } }, select: { id: true },
    })) return false;
    return true;
  });
}
