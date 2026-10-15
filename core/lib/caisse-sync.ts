import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { canonical, CashContractError, jsonValue, object, requireCash, type JsonRecord } from "./cash-day-projection.ts";

export type CashTx = Prisma.TransactionClient;
async function withTenant<T>(tenantId: string, fn: (tx: CashTx) => Promise<T>): Promise<T> {
  const tenant = await import("./tenant.ts");
  return tenant.withTenant(tenantId, fn as never) as Promise<T>;
}
export type ActionInput = JsonRecord & { tenantId: string; actionId: string; deviceId: string; entityKey: string; occurredAt: string };
export function text(value: unknown, max = 200, empty = false): string {
  requireCash(typeof value === "string" && value.length <= max && (empty || value.trim().length > 0)); return value;
}
export function uuid(value: unknown): string {
  const v = text(value, 36); requireCash(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)); return v.toLowerCase();
}
/** Normalise un actionId UUID tout en préservant les clés métier historiques non-UUID. */
export function normalizeActionId(value: unknown): string {
  const v = text(value, 200);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? uuid(v) : v;
}
const UUID_FIELDS = ["tenantId", "saleId", "cashDayId", "refundId", "partialRefundId", "voidActionId", "sessionId", "legacySessionId", "actorId", "receivedById", "createdBy", "cancelledBy", "openedBy", "closedBy", "cashierId", "giftCardId", "posteId", "by", "updatedBy", "clientFicheId", "appointmentId", "redeemedBy", "redeemedAppointmentId", "serviceId", "orderId"];
export function normalizeActionInput<T extends Record<string, any>>(input: T): T {
  const out: Record<string, any> = { ...input };
  for (const key of UUID_FIELDS) if (out[key] != null) out[key] = uuid(out[key]);
  if (out.actionId != null) out.actionId = normalizeActionId(out.actionId);
  for (const key of ["sharedActionId", "idempotencyKey"]) if (out[key] != null) out[key] = normalizeActionId(out[key]);
  if (typeof out.entityKey === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.entityKey)) out.entityKey = uuid(out.entityKey);
  for (const key of ["lines", "redeemGiftCards", "giftCards"]) if (Array.isArray(out[key])) out[key] = out[key].map((item: Record<string, any>) => ({
    ...item,
    ...(key === "lines" && item.lineId != null ? { lineId: uuid(item.lineId) } : {}),
    ...(key === "lines" && item.productId != null ? { productId: uuid(item.productId) } : {}),
    ...(key === "redeemGiftCards" && item.id != null ? { id: uuid(item.id) } : {}),
    ...(key === "giftCards" && item.serviceId != null ? { serviceId: uuid(item.serviceId) } : {}),
    ...(key === "giftCards" && item.orderId != null ? { orderId: uuid(item.orderId) } : {}),
  }));
  if (Array.isArray(out.sessionIds)) out.sessionIds = out.sessionIds.map((id: unknown) => uuid(id));
  return out as T;
}
export function date(value: unknown): Date {
  const v = text(value, 40); requireCash(/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)); const d = new Date(v); requireCash(Number.isFinite(d.getTime())); return d;
}
export function envelope(value: unknown, idempotencyKey: string | null): ActionInput {
  const raw = object(value); const b: ActionInput = normalizeActionInput(raw) as ActionInput;
  b.tenantId = uuid(raw.tenantId); b.actionId = normalizeActionId(raw.actionId);
  text(b.deviceId, 120); text(b.entityKey, 300); date(b.occurredAt);
  requireCash(idempotencyKey !== null && (idempotencyKey === b.actionId || normalizeActionId(idempotencyKey) === b.actionId), "IDEMPOTENCY_KEY_REQUIRED");
  return b as ActionInput;
}
export async function lockCashTenant(tx: CashTx, tenantId: string) {
  const normalized = uuid(tenantId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-l4:' + normalized}, 0))`;
}
export type ActionResponse = { status: number; body: JsonRecord };
/** L'accusé et la mutation métier commitent ensemble, y compris les candidats refusés. */
export async function cashAction(kind: string, b: ActionInput, mutate: (tx: CashTx) => Promise<unknown>): Promise<ActionResponse> {
  b = normalizeActionInput(b);
  b.tenantId = uuid(b.tenantId); b.actionId = normalizeActionId(b.actionId);
  const requestHash = createHash("sha256").update(canonical({ kind, b })).digest("hex");
  return withTenant(b.tenantId, async tx => {
    await lockCashTenant(tx, b.tenantId);
    const key = { tenantId_actionId: { tenantId: b.tenantId, actionId: b.actionId } };
    const previous = await tx.caisseSyncAction.findUnique({ where: key });
    if (previous) {
      if (previous.requestHash !== requestHash) return { status: 409, body: { ok: false, error: "ACTION_ID_CONFLICT" } };
      if (previous.state !== "PENDING") {
        const saved = object(previous.response);
        return { status: Number(saved.status), body: { ...object(saved.body), alreadyApplied: previous.state === "ACK" } };
      }
    }
    if (!previous) await tx.caisseSyncAction.create({ data: { tenantId: b.tenantId, actionId: b.actionId, deviceId: b.deviceId,
      kind, entityKey: b.entityKey, requestHash, payload: jsonValue(b) as Prisma.InputJsonValue } });
    await tx.$executeRawUnsafe("SAVEPOINT cash_l4_business");
    let result: ActionResponse;
    try {
      const data = object(jsonValue(await mutate(tx)));
      result = { status: 200, body: { ok: true, id: data.id ?? b.entityKey, revision: data.revision ?? 0, alreadyApplied: false, data } };
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT cash_l4_business");
    } catch (e) {
      if (!(e instanceof CashContractError)) throw e;
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT cash_l4_business");
      result = { status: e.status, body: { ok: false, error: e.message, ...(e.data === undefined ? {} : { data: jsonValue(e.data) }) } };
    }
    const retryable = result.status === 409 && result.body.error === "LEGACY_IN_PROGRESS";
    await tx.caisseSyncAction.update({ where: key, data: { state: result.status === 200 ? "ACK" : retryable ? "PENDING" : result.status === 409 ? "CONFLICT" : "REJECTED",
      response: jsonValue(result) as Prisma.InputJsonValue } });
    return result;
  });
}

/** Curseur keyset UUID, pagination sans plafond silencieux. Les mises à jour gardent l'id. */
export function pageQuery(query: URLSearchParams) {
  const raw = query.get("cursor");
  const cursor = raw ? uuid(raw) : null;
  return { cursor: cursor ?? undefined, take: 201 };
}
export function page<T extends { id: string; revision: number }>(rows: T[]) {
  const hasMore = rows.length > 200, data = rows.slice(0, 200);
  return { data, hasMore, nextCursor: hasMore ? data[data.length - 1].id : null,
    serverRevision: data.reduce((r, row) => Math.max(r, row.revision), 0) };
}

// Pour checkout/void/refund : réservation durable avant l'appel externe, ACK financier
// DANS la transaction de finalisation ; une coupure rejoue les primitives natives.
export async function financialReservation(kind: string, b: ActionInput) {
  b = normalizeActionInput(b);
  b.tenantId = uuid(b.tenantId); b.actionId = normalizeActionId(b.actionId);
  const requestHash = createHash("sha256").update(canonical({ kind, b })).digest("hex");
  return withTenant(b.tenantId, async tx => {
    await lockCashTenant(tx, b.tenantId);
    const key = { tenantId_actionId: { tenantId: b.tenantId, actionId: b.actionId } };
    const old = await tx.caisseSyncAction.findUnique({ where: key });
    if (old) {
      requireCash(old.requestHash === requestHash, "ACTION_ID_CONFLICT", 409);
      return old.state !== "PENDING" ? old.response : null;
    }
    await tx.caisseSyncAction.create({ data: { tenantId: b.tenantId, actionId: b.actionId, deviceId: b.deviceId,
      kind, entityKey: b.entityKey, requestHash, payload: jsonValue(b) as Prisma.InputJsonValue } });
    return null;
  });
}
export async function ackFinancial(tx: CashTx, tenantId: string, actionId: string, data: { id: string; [key: string]: unknown }, validateOnly = false) {
  tenantId = uuid(tenantId); actionId = normalizeActionId(actionId);
  data = { ...data, id: uuid(data.id), ...(data.saleId == null ? {} : { saleId: uuid(data.saleId) }), ...(data.cashDayId == null ? {} : { cashDayId: uuid(data.cashDayId) }) };
  const action = await tx.caisseSyncAction.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } });
  if (!action) return; // Le chemin historique peut être journalisé sans réservation de synchronisation.
  const operation = data.status === "PAID" ? "checkout" : data.status === "VOID" ? "void" : data.status === "DONE" ? "partial-refund" : null;
  const saleId = data.saleId ?? data.id;
  const parts = action.kind.split(":");
  requireCash(operation && parts.length === 5 && parts[0] === "cash-days" && parts[2] === "sales"
    && parts[3] === saleId && parts[4] === operation && (!data.cashDayId || parts[1] === data.cashDayId), "ACTION_ID_CONFLICT", 409);
  if (validateOnly) return;
  const response = jsonValue({ ok: true, id: data.id, revision: data.revision ?? 0, alreadyApplied: false, data }) as Prisma.InputJsonValue;
  await tx.caisseSyncAction.updateMany({ where: { tenantId, actionId, kind: action.kind, entityKey: action.entityKey, state: "PENDING" }, data: { state: "ACK", response } });
}
