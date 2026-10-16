import { withTenant } from "./tenant";
import { lockCashTenant, uuid, type CashTx } from "./caisse-sync";
import { CashContractError } from "./cash-day-projection";

export const CASHDAY_ROUTE_REQUIRED = { ok: false, error: "CASHDAY_ROUTE_REQUIRED" } as const;
export async function assertLegacyWriteAllowed(tx: CashTx, tenantId: string): Promise<void> {
  tenantId = uuid(tenantId);
  await lockCashTenant(tx, tenantId);
  if (await tx.cashDay.findFirst({ where: { tenantId }, select: { id: true } })) {
    throw new CashContractError("CASHDAY_ROUTE_REQUIRED", 409);
  }
}

/** Appelé après lockCashTenant et avant lockDay, pour qu'une bascule ne coupe aucune réservation. */
export async function assertNoLegacyOperationInProgress(tx: CashTx, tenantId: string): Promise<void> {
  tenantId = uuid(tenantId);
  const [refund, voidAction, correction, saleVoid, checkout] = await Promise.all([
    tx.partialRefund.findFirst({ where: { tenantId, status: "PENDING", cashDayId: null }, select: { id: true } }),
    tx.voidAction.findMany({ where: { tenantId, status: "PENDING" }, select: { id: true, saleId: true } }).then(async actions => {
      for (const action of actions) if (!(await tx.sale.findFirst({ where: { tenantId, id: action.saleId, cashDayId: { not: null } }, select: { id: true } }))) return action;
      return null;
    }),
    tx.caisseSyncAction.findFirst({ where: { tenantId, state: "PENDING", kind: "legacy-payment-correction" }, select: { id: true } }),
    tx.sale.findFirst({ where: { tenantId, status: "PAID", cashDayId: null, voidPreparedAt: { not: null } }, select: { id: true } }),
    tx.sale.findFirst({ where: { tenantId, status: "DRAFT", cashDayId: null, payments: { some: {} } }, select: { id: true } }),
  ]);
  if (refund || voidAction || correction || saleVoid || checkout) throw new CashContractError("LEGACY_IN_PROGRESS", 409);
}
type LegacyWrite = { openSession: true } | { sessionId?: string | null } | { saleId: string; refundCashDayId?: string; paymentCorrection?: true };

/** Toute écriture historique doit passer par l'API CashDay dès qu'un jour existe. */
export async function cashDayGuard(tenantId: string, target: LegacyWrite): Promise<boolean> {
  tenantId = uuid(tenantId);
  if ("sessionId" in target && target.sessionId) target = { ...target, sessionId: uuid(target.sessionId) };
  if ("saleId" in target) target = { ...target, saleId: uuid(target.saleId), ...(target.refundCashDayId ? { refundCashDayId: uuid(target.refundCashDayId) } : {}) };
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
