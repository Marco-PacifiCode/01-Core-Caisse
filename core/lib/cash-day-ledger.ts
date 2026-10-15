import type { Prisma } from "@prisma/client";
import { businessDay, canonical, CashContractError, factDelta, jsonValue, requireCash, taxes, type FrozenLine, type DayFact } from "./cash-day-projection";
import { lockCashTenant, type CashTx } from "./caisse-sync";

export async function lockDay(tx: CashTx, tenantId: string, cashDayId: string) {
  await lockCashTenant(tx, tenantId);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CashDay" WHERE "tenantId"=${tenantId}::uuid AND "id"=${cashDayId}::uuid FOR UPDATE`;
  if (!rows.length) throw new CashContractError("NOT_FOUND", 404);
  return tx.cashDay.findFirstOrThrow({ where: { tenantId, id: cashDayId }, include: { canonicalSession: true, currentSession: true } });
}
export async function appendDayFact(tx: CashTx, tenantId: string, cashDayId: string, input: {
  kind: string; sourceRef: string; deviceId: string; occurredAt: Date; snapshot: unknown; saleId?: string; refundActionId?: string;
}) {
  await lockDay(tx, tenantId, cashDayId);
  const snapshot = jsonValue(input.snapshot) as Prisma.InputJsonValue;
  const cashDeltaXpf = factDelta(input.kind, snapshot);
  const old = await tx.cashDayEvent.findUnique({ where: { tenantId_cashDayId_kind_sourceRef: { tenantId, cashDayId, kind: input.kind, sourceRef: input.sourceRef } } });
  if (old) {
    if (canonical(old.snapshot) !== canonical(snapshot)) throw new CashContractError("SOURCE_CONFLICT", 409);
    return old;
  }
  const day = await tx.cashDay.update({ where: { tenantId_id: { tenantId, id: cashDayId } }, data: { revision: { increment: 1n } } });
  return tx.cashDayEvent.create({ data: { tenantId, cashDayId, sequence: day.revision, kind: input.kind, sourceRef: input.sourceRef,
    deviceId: input.deviceId, occurredAt: input.occurredAt, cashDeltaXpf, snapshot, saleId: input.saleId, refundActionId: input.refundActionId } });
}
export async function lockSharedSale(tx: CashTx, tenantId: string, saleId: string) {
  // Pas de lecture d'une nouvelle table quand la vente n'a pas opté pour CashDay.
  const sale = await tx.sale.findFirst({ where: { tenantId, id: saleId } });
  if (sale?.cashDayId) await lockDay(tx, tenantId, sale.cashDayId);
  return sale;
}
export async function prepareSharedCheckout(tx: CashTx, tenantId: string, saleId: string) {
  await lockSharedSale(tx, tenantId, saleId);
  const current = await tx.sale.findFirstOrThrow({ where: { tenantId, id: saleId } });
  if (current.status === "PAID") return false;
  if (current.status !== "DRAFT") throw new CashContractError("ALREADY_VOID", 409);
  return true;
}
export async function recordSharedGift(tx: CashTx, tenantId: string, cashDayId: string, giftId: string, deviceId: string, occurredAt: Date) {
  const card = await tx.giftCard.findFirstOrThrow({ where: { tenantId, id: giftId } });
  await appendDayFact(tx, tenantId, cashDayId, { kind: "GIFT_CARD_REDEEMED", sourceRef: card.id, deviceId, occurredAt,
    snapshot: { amountXpf: String(card.amountXpf) } });
}
export async function recordSharedSale(tx: CashTx, tenantId: string, saleId: string) {
  const sale = await tx.sale.findFirstOrThrow({ where: { tenantId, id: saleId }, include: { lines: true, payments: true } });
  if (!sale.cashDayId) return;
  const day = await lockDay(tx, tenantId, sale.cashDayId);
  const occurredAt = sale.paidAt ?? sale.createdAt;
  if (businessDay(occurredAt) !== day.businessDay) throw new CashContractError("DAY_MISMATCH", 409);
  if (sale.status === "PAID" || sale.status === "VOID" && sale.paidAt) {
    const lines = jsonValue(sale.lines) as FrozenLine[];
    // Les contre-écritures gardent leurs propres faits : SALE_PAID reste immuable au rejeu.
    const corrections = sale.payments.filter(p => p.settleRef?.startsWith("corr:"));
    await appendDayFact(tx, tenantId, day.id, { kind: "SALE_PAID", sourceRef: sale.id, saleId: sale.id,
      deviceId: sale.deviceId ?? "legacy", occurredAt, snapshot: { totalXpf: sale.totalXpf, lines, payments: sale.payments.filter(p => !p.settleRef?.startsWith("corr:")),
        parTaux: taxes(lines), ticketNumber: sale.ticketNumber, deviceName: sale.deviceName, sellerId: sale.sellerId, sellerName: sale.sellerName } });
    for (const p of corrections) {
      const ref = p.settleRef!;
      requireCash(ref.startsWith(`corr:caisse:${sale.id}:`) && (ref.endsWith(":out") || ref.endsWith(":in")));
      if (!ref.endsWith(":out")) {
        requireCash(corrections.some(out => out.settleRef === ref.slice(0, -3) + ":out"));
        continue;
      }
      const pair = corrections.filter(into => into.settleRef === ref.slice(0, -4) + ":in");
      requireCash(pair.length === 1 && corrections.filter(out => out.settleRef === ref).length === 1);
      await appendDayFact(tx, tenantId, day.id, { kind: "PAYMENT_CORRECTION", sourceRef: ref, saleId: sale.id,
        deviceId: sale.deviceId ?? "legacy", occurredAt: p.createdAt ?? occurredAt,
        snapshot: { saleRef: sale.id, payments: [p, pair[0]].map(payment => ({ method: payment.method, amountXpf: String(payment.amountXpf) })) } });
    }
  }
  if (sale.status === "VOID") await appendDayFact(tx, tenantId, day.id, { kind: sale.paidAt ? "SALE_VOID" : "LOCAL_VOID",
    sourceRef: sale.id, saleId: sale.id, deviceId: sale.deviceId ?? "legacy", occurredAt: sale.updatedAt,
    snapshot: { saleRef: sale.id, creditNoteId: sale.creditNoteId } });
}
export async function consumePickupOrder(tx: CashTx, tenantId: string, saleId: string) {
  const sale = await tx.sale.findFirstOrThrow({ where: { tenantId, id: saleId } });
  if (!sale.cashDayId || !sale.pickupOrderId) return;
  const order = await tx.pickupOrder.findFirst({ where: { tenantId, id: sale.pickupOrderId } });
  if (!order) throw new CashContractError("NOT_FOUND", 404);
  if (order.saleId === saleId && order.status === "RETIREE") return;
  if (order.saleId || ["RETIREE", "ANNULEE", "PERDUE"].includes(order.status)) throw new CashContractError("ORDER_ALREADY_PAID", 409, order);
  if (order.claimedByDevice !== sale.deviceId) throw new CashContractError("ALREADY_CLAIMED", 409, order);
  if (order.totalXpf !== sale.totalXpf) throw new CashContractError("ORDER_AMOUNT_MISMATCH", 409);
  const changed = await tx.pickupOrder.updateMany({ where: { tenantId, id: order.id, revision: order.revision, saleId: null },
    data: { status: "RETIREE", saleId, pickedUpAt: sale.paidAt, ticketNumber: sale.ticketNumber, revision: { increment: 1 } } });
  if (changed.count !== 1) throw new CashContractError("ORDER_ALREADY_PAID", 409);
}
export async function readFacts(tx: CashTx, tenantId: string, cashDayId: string, revision: bigint): Promise<DayFact[]> {
  return tx.cashDayEvent.findMany({ where: { tenantId, cashDayId, sequence: { lte: revision } }, orderBy: { sequence: "asc" } });
}
