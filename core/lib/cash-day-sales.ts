import type { LineKind, Prisma } from "@prisma/client";
import { appendDayFact, lockDay, recordSharedSale } from "./cash-day-ledger";
import { businessDay, canonical, requireCash, safeXpf, xpfInteger } from "./cash-day-projection";
import { frozenLines } from "./cash-shared-policy";
import { date, findHistoricalSource, normalizeActionInput, receivedActionInput, text, uuid, type ActionInput, type CashTx } from "./caisse-sync";
import { lockSaleRow } from "./sale-lock";

export async function createDaySale(tx: CashTx, cashDayId: string, b: ActionInput) {
  const received = receivedActionInput(b);
  b = normalizeActionInput(b);
  const day = await lockDay(tx, b.tenantId, cashDayId), occurredAt = date(b.occurredAt);
  requireCash(businessDay(occurredAt) === day.businessDay, "DAY_MISMATCH", 409);
  requireCash(day.currentSession.status === "OPEN" || day.currentSession.status === "TO_CLOSE"
    || b.offlineCompleted === true || b.importMode === true, "DAY_CLOSED", 409);
  if (b.sessionId !== undefined) {
    const alias = await tx.cashDaySession.findUnique({ where: { tenantId_sessionId: { tenantId: b.tenantId, sessionId: uuid(b.sessionId) } } });
    requireCash(alias?.cashDayId === day.id, "DAY_MISMATCH", 409);
  }
  const sourceType = text(b.sourceType), sourceId = text(b.sourceId, 300);
  const frozen = frozenLines(b.lines); requireCash(frozen.total !== null && frozen.total >= 0n);
  safeXpf(frozen.total);
  const lines = frozen.lines.map(l => {
    requireCash(["SERVICE", "PRODUCT", "OTHER"].includes(String(l.kind)));
    const unitXpf = xpfInteger(l.unitXpf, true), lineXpf = xpfInteger(l.lineXpf, true); safeXpf(unitXpf); safeXpf(lineXpf);
    return { tenantId: b.tenantId, kind: l.kind as LineKind, label: text(l.label, 1000), qty: Number(l.qty), unitXpf, lineXpf,
      productId: l.kind === "PRODUCT" ? uuid(l.productId) : null, tgcRatePpm: l.tgcRatePpm == null ? null : Number(l.tgcRatePpm) };
  });
  const found = await findHistoricalSource({ sourceType: text(received.sourceType), sourceId: text(received.sourceId, 300) },
    (sourceType, sourceId) => tx.sale.findFirst({ where: { tenantId: b.tenantId, sourceType, sourceId }, include: { lines: true } }));
  if (found) {
    requireCash(await lockSaleRow(tx, found.id, b.tenantId), "NOT_FOUND", 404);
    const old = await tx.sale.findFirstOrThrow({ where: { tenantId: b.tenantId, id: found.id }, include: { lines: true } });
    requireCash(!old.cashDayId || old.cashDayId === day.id, "DAY_MISMATCH", 409);
    const signature = (rows: typeof lines) => rows.map(l => canonical({ kind: l.kind, label: l.label, qty: l.qty, unitXpf: l.unitXpf, lineXpf: l.lineXpf, productId: l.productId, tgcRatePpm: l.tgcRatePpm })).sort();
    requireCash(old.totalXpf === frozen.total && canonical(signature(old.lines)) === canonical(signature(lines)), "SOURCE_CONFLICT", 409);
    requireCash(businessDay(old.paidAt ?? old.createdAt) === day.businessDay, "DAY_MISMATCH", 409);
    // Une pièce connue n'est jamais réencaissée ; seule son appartenance est complétée.
    await tx.sale.update({ where: { id: old.id }, data: { cashDayId: day.id, sessionId: day.canonicalSessionId } });
    await recordSharedSale(tx, b.tenantId, old.id);
    return { id: old.id, saleId: old.id, totalXpf: old.totalXpf, alreadyExisted: true };
  }
  const pickupOrderId = b.pickupOrderId == null ? null : uuid(b.pickupOrderId);
  if (pickupOrderId) {
    const order = await tx.pickupOrder.findFirst({ where: { tenantId: b.tenantId, id: pickupOrderId } });
    requireCash(order, "NOT_FOUND", 404);
    requireCash(!order.saleId && !["RETIREE", "ANNULEE", "PERDUE"].includes(order.status), "ORDER_ALREADY_PAID", 409);
    requireCash(order.claimedByDevice === b.deviceId, "ALREADY_CLAIMED", 409);
    requireCash(order.totalXpf === frozen.total, "ORDER_AMOUNT_MISMATCH", 409);
  }
  const data: Prisma.SaleUncheckedCreateInput = { tenantId: b.tenantId, cashDayId: day.id, sessionId: day.canonicalSessionId,
    sourceType, sourceId, totalXpf: frozen.total, subtotalXpf: frozen.total, createdAt: occurredAt,
    deviceId: b.deviceId, deviceName: text(b.deviceName), ticketNumber: text(b.ticketNumber, 120),
    sellerId: b.sellerId == null ? null : uuid(b.sellerId), sellerName: b.sellerName == null ? null : text(b.sellerName), pickupOrderId,
    cashierId: b.actorId == null ? null : uuid(b.actorId), lines: { create: lines } };
  const sale = await tx.sale.create({ data });
  return { id: sale.id, saleId: sale.id, totalXpf: sale.totalXpf, alreadyExisted: false };
}

export async function dayMovement(tx: CashTx, cashDayId: string, b: ActionInput) {
  const day = await lockDay(tx, b.tenantId, cashDayId);
  requireCash(businessDay(date(b.occurredAt)) === day.businessDay, "DAY_MISMATCH", 409);
  requireCash(["CASH_IN", "CASH_OUT"].includes(String(b.kind))); // Les avoirs ont leur propre journal.
  const amountXpf = xpfInteger(b.amountXpf); requireCash(amountXpf > 0n); safeXpf(amountXpf);
  const movement = await tx.cashMovement.create({ data: { tenantId: b.tenantId, sessionId: day.currentSessionId,
    kind: b.kind as "CASH_IN" | "CASH_OUT", amountXpf, reason: text(b.reason, 1000), ref: `shared:${b.actionId}`,
    createdAt: date(b.occurredAt), createdBy: uuid(b.actorId), createdByName: text(b.actorName) } });
  const event = await appendDayFact(tx, b.tenantId, day.id, { kind: "MOVEMENT", sourceRef: movement.id, deviceId: b.deviceId,
    occurredAt: movement.createdAt, snapshot: { kind: movement.kind, amountXpf: movement.amountXpf, reason: movement.reason } });
  return { id: movement.id, revision: event.sequence };
}
