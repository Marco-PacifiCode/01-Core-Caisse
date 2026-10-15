import type { PayMethod } from "@prisma/client";
import { annulerVente, checkoutSale, rembourserPartiellement, type CheckoutOptions } from "./caisse";
import { withTenant } from "./tenant";
import { ackFinancial, date, financialReservation, text, uuid, type ActionInput } from "./caisse-sync";
import { lockDay } from "./cash-day-ledger";
import { businessDay, canonical, CashContractError, jsonValue, object, paymentParts, requireCash, safeXpf, xpfInteger } from "./cash-day-projection";
import type { Prisma } from "@prisma/client";
import { validRefundInput, type RefundInput } from "./partial-refund";

export async function dayFinancial(cashDayId: string, saleId: string, operation: string, b: ActionInput) {
  requireCash(["checkout", "void", "partial-refund"].includes(operation));
  uuid(b.actionId);
  const replay = await financialReservation(`cash-days:${cashDayId}:sales:${saleId}:${operation}`, b);
  if (replay) return { ...object(replay), alreadyApplied: object(replay).ok === true };
  try {
    return await applyDayFinancial(cashDayId, saleId, operation, b);
  } catch (e) {
    if (e instanceof CashContractError) {
      // Ancienne réservation sur jour clos : refus explicite, clé conservée rejouable.
      if (e.message === "REFUND_DAY_CLOSED_REOPEN_REQUIRED") return { ok: false, error: e.message, status: e.status, data: e.data };
      const completed = await withTenant(b.tenantId, async tx => {
        // Un appel concurrent de la même clé peut avoir terminé entre-temps.
        const action = await tx.caisseSyncAction.findUnique({ where: { tenantId_actionId: { tenantId: b.tenantId, actionId: b.actionId } } });
        if (action?.state === "ACK") return action.response;
        await tx.caisseSyncAction.updateMany({ where: { tenantId: b.tenantId, actionId: b.actionId, state: "PENDING" },
          data: { state: e.status === 409 ? "CONFLICT" : "REJECTED", response: jsonValue({ ok: false, error: e.message, status: e.status, data: e.data }) as Prisma.InputJsonValue } });
        return null;
      });
      if (completed) return { ...object(completed), alreadyApplied: true };
    }
    throw e;
  }
}
async function applyDayFinancial(cashDayId: string, saleId: string, operation: string, b: ActionInput) {
  // Revalidation après réservation, avant tout appel Compta/Stock.
  await withTenant(b.tenantId, async tx => {
    const day = await lockDay(tx, b.tenantId, cashDayId);
    const sale = await tx.sale.findFirst({ where: { tenantId: b.tenantId, id: saleId }, include: { payments: true } });
    requireCash(sale, "NOT_FOUND", 404);
    if (operation !== "partial-refund") {
      requireCash(sale.cashDayId === cashDayId, "DAY_MISMATCH", 409);
      requireCash(businessDay(date(b.occurredAt)) === day.businessDay, "DAY_MISMATCH", 409);
    }
    if (operation === "checkout") {
      if (sale.status === "PAID") throw new CashContractError("SALE_ALREADY_PAID", 409,
        { payments: sale.payments.map(p => ({ method: p.method, amountXpf: String(p.amountXpf) })) });
      const parts = paymentParts(b.payments);
      requireCash(Object.values(parts).reduce((s, n) => s + n, 0n) === sale.totalXpf);
      if (sale.payments.length && canonical(parts) !== canonical(paymentParts(sale.payments.map(p => ({ method: p.method, amountXpf: String(p.amountXpf) }))))) {
        throw new CashContractError("SALE_ALREADY_PAID", 409,
          { payments: sale.payments.map(p => ({ method: p.method, amountXpf: String(p.amountXpf) })) });
      }
    }
  });
  let result: { ok: boolean; [key: string]: unknown };
  if (operation === "checkout") {
    requireCash(Array.isArray(b.payments));
    const payments = b.payments.map(v => {
      const p = object(v), amountXpf = xpfInteger(p.amountXpf); safeXpf(amountXpf);
      const tenderedXpf = p.tenderedXpf === undefined ? undefined : xpfInteger(p.tenderedXpf);
      if (tenderedXpf !== undefined) { safeXpf(tenderedXpf); requireCash(tenderedXpf >= amountXpf); }
      return { method: p.method as PayMethod, amountXpf, tenderedXpf };
    });
    const options: CheckoutOptions = { paidAt: date(b.occurredAt), sharedActionId: b.actionId };
    if (b.giftCards !== undefined) {
      requireCash(Array.isArray(b.giftCards));
      options.giftCards = b.giftCards.map(v => { const g = object(v); return { ...g, code: text(g.code), amountXpf: xpfInteger(g.amountXpf) }; });
    }
    if (b.redeemGiftCards !== undefined) {
      requireCash(Array.isArray(b.redeemGiftCards));
      options.redeemGiftCards = b.redeemGiftCards.map(v => { const g = object(v); return { id: uuid(g.id),
        redeemedBy: uuid(b.actorId), redeemedByName: text(b.actorName), redeemedForXpf: g.redeemedForXpf == null ? null : safeXpf(xpfInteger(g.redeemedForXpf)) }; });
    }
    result = await checkoutSale(b.tenantId, saleId, payments, options);
  } else if (operation === "void") {
    result = await annulerVente(b.tenantId, saleId, { actionId: b.actionId, sharedActionId: b.actionId, reason: text(b.reason, 1000) });
  } else {
    const input: RefundInput = { actionId: b.actionId, reason: text(b.reason, 1000), lines: b.lines as RefundInput["lines"],
      refundMethod: b.refundMethod as RefundInput["refundMethod"], cashDrawer: b.refundMethod === "CASH" ? "EXTERNAL" : undefined,
      cashDayId, drawerBusinessDay: businessDay(date(b.occurredAt)), occurredAt: b.occurredAt, deviceId: b.deviceId,
      createdBy: uuid(b.actorId), createdByName: text(b.actorName) };
    requireCash(validRefundInput(input));
    result = await rembourserPartiellement(b.tenantId, saleId, input);
  }
  if (!result.ok) return result;
  // PAID/VOID/DONE déjà connus (notamment perte d'accusé sur un ancien chemin) :
  // aucun nouvel effet, l'ACK manquant est complété sous le même verrou.
  return withTenant(b.tenantId, async tx => {
    await lockDay(tx, b.tenantId, cashDayId);
    await ackFinancial(tx, b.tenantId, b.actionId, { id: saleId, saleId, status: operation === "checkout" ? "PAID" : operation === "void" ? "VOID" : "DONE" });
    const action = await tx.caisseSyncAction.findUniqueOrThrow({ where: { tenantId_actionId: { tenantId: b.tenantId, actionId: b.actionId } } });
    return action.response;
  });
}
