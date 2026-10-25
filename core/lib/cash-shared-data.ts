import type { Prisma } from "@prisma/client";
import { canonical, CashContractError, jsonValue, requireCash, validDay, xpfInteger } from "./cash-day-projection";
import { canChange, frozenLines, revisionOf } from "./cash-shared-policy";
import { date, text, uuid, type ActionInput, type CashTx } from "./caisse-sync";

export async function changeSettings(tx: CashTx, b: ActionInput) {
  const hasFloat = b.defaultFloatXpf !== undefined;
  const hasNegative = Object.prototype.hasOwnProperty.call(b, "allowNegativeStock");
  requireCash(hasFloat || hasNegative);
  if (hasNegative) requireCash(typeof b.allowNegativeStock === "boolean");
  const value = hasFloat ? xpfInteger(b.defaultFloatXpf) : undefined;
  if (value !== undefined) requireCash(value <= 99999999n);
  const data = { ...(value !== undefined ? { defaultFloatXpf: value } : {}),
    ...(hasNegative ? { allowNegativeStock: b.allowNegativeStock as boolean } : {}) };
  const baseRevision = revisionOf(b.baseRevision);
  const row = await tx.cashSettings.findUnique({ where: { tenantId: b.tenantId } });
  if (row && b.importMode === true && ((hasFloat && row.defaultFloatXpf !== value) ||
    (hasNegative && row.allowNegativeStock !== b.allowNegativeStock))) throw new CashContractError("REVISION_CONFLICT", 409, { server: row, proposal: b });
  if (!row) {
    requireCash(baseRevision === 0, "REVISION_CONFLICT", 409);
    return tx.cashSettings.create({ data: { tenantId: b.tenantId, ...data, revision: 1 } });
  }
  const changed = await tx.cashSettings.updateMany({ where: { tenantId: b.tenantId, revision: baseRevision },
    data: { ...data, revision: { increment: 1 } } });
  requireCash(changed.count === 1, "REVISION_CONFLICT", 409);
  return tx.cashSettings.findUniqueOrThrow({ where: { tenantId: b.tenantId } });
}
export async function createBasket(tx: CashTx, b: ActionInput) {
  const sourceKey = text(b.sourceKey, 300), label = text(b.label, 300, true);
  const { lines } = frozenLines(b.lines, b.importMode === true);
  const old = await tx.parkedBasket.findUnique({ where: { tenantId_sourceKey: { tenantId: b.tenantId, sourceKey } } });
  if (old) {
    requireCash(old.label === label && canonical(old.lines) === canonical(lines) && old.occurredAt.getTime() === date(b.occurredAt).getTime(), "SOURCE_CONFLICT", 409);
    return old; // Un ancien import ne ressuscite jamais un tombstone/claim.
  }
  return tx.parkedBasket.create({ data: { tenantId: b.tenantId, sourceKey, label, lines: lines as Prisma.InputJsonValue,
    occurredAt: date(b.occurredAt), ...(b.importMode ? { status: "CLAIMED", claimedByDevice: b.deviceId, claimActionId: b.actionId } : {}) } });
}
export async function changeBasket(tx: CashTx, id: string, b: ActionInput, claim: boolean) {
  const row = await tx.parkedBasket.findFirst({ where: { tenantId: b.tenantId, id } }); requireCash(row, "NOT_FOUND", 404);
  canChange(row, b, claim);
  const data: Prisma.ParkedBasketUpdateManyMutationInput = { revision: { increment: 1 } };
  if (claim) { data.status = "CLAIMED"; data.claimedByDevice = b.deviceId; data.claimActionId = b.actionId; }
  else {
    if (b.label !== undefined) data.label = text(b.label, 300, true);
    if (b.lines !== undefined) data.lines = frozenLines(b.lines).lines as Prisma.InputJsonValue;
    if (b.status !== undefined) {
      requireCash(["WAITING", "CONSUMED", "DELETED"].includes(String(b.status)));
      data.status = String(b.status);
      if (b.status === "WAITING") { data.claimedByDevice = null; data.claimActionId = null; }
    }
  }
  const changed = await tx.parkedBasket.updateMany({ where: { tenantId: b.tenantId, id, revision: revisionOf(b.baseRevision) }, data });
  requireCash(changed.count === 1, "REVISION_CONFLICT", 409);
  return tx.parkedBasket.findFirstOrThrow({ where: { tenantId: b.tenantId, id } });
}
function orderData(b: ActionInput) {
  const { lines, total } = frozenLines(b.lines, b.importMode === true), totalXpf = xpfInteger(b.totalXpf);
  requireCash(total === null && b.importMode === true || total === totalXpf);
  const depositXpf = xpfInteger(b.depositXpf ?? "0");
  requireCash(b.importMode === true || depositXpf === 0n); // Aucun nouvel encaissement d'acompte.
  const pickupTime = text(b.pickupTime, 5); requireCash(/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime));
  return { clientName: text(b.clientName, 200, true), phone: text(b.phone, 30, true), pickupDay: validDay(b.pickupDay), pickupTime,
    lines: jsonValue(lines) as Prisma.InputJsonValue, summary: text(b.summary ?? "", 1000, true), totalXpf, depositXpf };
}
export async function createPickup(tx: CashTx, b: ActionInput) {
  const data = orderData(b), sourceKey = text(b.sourceKey, 300);
  const old = await tx.pickupOrder.findUnique({ where: { tenantId_sourceKey: { tenantId: b.tenantId, sourceKey } } });
  if (old) {
    const same = Object.entries(data).every(([k, v]) => canonical(old[k as keyof typeof old]) === canonical(v));
    requireCash(same && old.occurredAt.getTime() === date(b.occurredAt).getTime(), "SOURCE_CONFLICT", 409);
    return old;
  }
  const status = b.importMode ? String(b.status ?? "A_PREPARER") : "A_PREPARER";
  requireCash(["A_PREPARER", "PRETE", "RETIREE", "ANNULEE", "PERDUE"].includes(status));
  let saleId: string | undefined;
  if (status === "RETIREE") {
    saleId = uuid(b.saleId);
    const sale = await tx.sale.findFirst({ where: { tenantId: b.tenantId, id: saleId, status: "PAID" } });
    requireCash(sale && sale.totalXpf === data.totalXpf, "SALE_REQUIRED", 409);
    const linked = await tx.pickupOrder.findFirst({ where: { tenantId: b.tenantId, saleId } });
    requireCash(!linked, "ORDER_ALREADY_PAID", 409);
  }
  return tx.pickupOrder.create({ data: { tenantId: b.tenantId, sourceKey, ...data, status, occurredAt: date(b.occurredAt),
    saleId,
    pickedUpAt: b.pickedUpAt === undefined ? undefined : date(b.pickedUpAt), cancelledAt: b.cancelledAt === undefined ? undefined : date(b.cancelledAt),
    ...(b.importMode ? { claimedByDevice: b.deviceId, claimActionId: b.actionId } : {}) } });
}
export async function changePickup(tx: CashTx, id: string, b: ActionInput, claim: boolean) {
  const row = await tx.pickupOrder.findFirst({ where: { tenantId: b.tenantId, id } }); requireCash(row, "NOT_FOUND", 404);
  canChange(row, b, claim, true);
  const data: Prisma.PickupOrderUpdateManyMutationInput = { revision: { increment: 1 } };
  if (claim) { data.claimedByDevice = b.deviceId; data.claimActionId = b.actionId; }
  else {
    if (b.depositXpf !== undefined) requireCash(xpfInteger(b.depositXpf) === row.depositXpf); // métadonnée importée conservée
    if (b.lines !== undefined || b.totalXpf !== undefined) {
      const frozen = frozenLines(b.lines ?? row.lines); const total = xpfInteger(b.totalXpf ?? String(row.totalXpf)); requireCash(frozen.total === total);
      data.lines = frozen.lines as Prisma.InputJsonValue; data.totalXpf = total;
    }
    if (b.clientName !== undefined) data.clientName = text(b.clientName, 200, true);
    if (b.phone !== undefined) data.phone = text(b.phone, 30, true);
    if (b.pickupDay !== undefined) data.pickupDay = validDay(b.pickupDay);
    if (b.pickupTime !== undefined) { const time = text(b.pickupTime, 5); requireCash(/^([01]\d|2[0-3]):[0-5]\d$/.test(time)); data.pickupTime = time; }
    if (b.summary !== undefined) data.summary = text(b.summary, 1000, true);
    if (b.status !== undefined) { requireCash(["A_PREPARER", "PRETE", "ANNULEE", "PERDUE"].includes(String(b.status))); data.status = String(b.status);
      if (b.status === "ANNULEE") data.cancelledAt = date(b.occurredAt); }
  }
  const changed = await tx.pickupOrder.updateMany({ where: { tenantId: b.tenantId, id, revision: revisionOf(b.baseRevision), saleId: null }, data });
  requireCash(changed.count === 1, "REVISION_CONFLICT", 409);
  return tx.pickupOrder.findFirstOrThrow({ where: { tenantId: b.tenantId, id } });
}
