import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenant } from "./tenant";
import { canonical, CashContractError, jsonValue, object, requireCash, type JsonRecord } from "./cash-day-projection";

export type CashTx = Prisma.TransactionClient;
export type ActionInput = JsonRecord & { tenantId: string; actionId: string; deviceId: string; entityKey: string; occurredAt: string };
export function text(value: unknown, max = 200, empty = false): string {
  requireCash(typeof value === "string" && value.length <= max && (empty || value.trim().length > 0)); return value;
}
export function uuid(value: unknown): string {
  const v = text(value, 36); requireCash(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)); return v.toLowerCase();
}
export function date(value: unknown): Date {
  const v = text(value, 40); requireCash(/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)); const d = new Date(v); requireCash(Number.isFinite(d.getTime())); return d;
}
export function envelope(value: unknown, idempotencyKey: string | null): ActionInput {
  const b = object(value); uuid(b.tenantId); text(b.actionId, 200); text(b.deviceId, 120); text(b.entityKey, 300); date(b.occurredAt);
  requireCash(idempotencyKey === b.actionId, "IDEMPOTENCY_KEY_REQUIRED");
  return b as ActionInput;
}
export async function lockCashTenant(tx: CashTx, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-l4:' + tenantId}, 0))`;
}
export type ActionResponse = { status: number; body: JsonRecord };
/** L'accusé et la mutation métier commitent ensemble, y compris les candidats refusés. */
export async function cashAction(kind: string, b: ActionInput, mutate: (tx: CashTx) => Promise<unknown>): Promise<ActionResponse> {
  const requestHash = createHash("sha256").update(canonical({ kind, b })).digest("hex");
  return withTenant(b.tenantId, async tx => {
    await lockCashTenant(tx, b.tenantId);
    const key = { tenantId_actionId: { tenantId: b.tenantId, actionId: b.actionId } };
    const previous = await tx.caisseSyncAction.findUnique({ where: key });
    if (previous) {
      if (previous.requestHash !== requestHash) return { status: 409, body: { ok: false, error: "ACTION_ID_CONFLICT" } };
      const saved = object(previous.response);
      return { status: Number(saved.status), body: { ...object(saved.body), alreadyApplied: previous.state === "ACK" } };
    }
    await tx.caisseSyncAction.create({ data: { tenantId: b.tenantId, actionId: b.actionId, deviceId: b.deviceId,
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
    await tx.caisseSyncAction.update({ where: key, data: { state: result.status === 200 ? "ACK" : result.status === 409 ? "CONFLICT" : "REJECTED",
      response: jsonValue(result) as Prisma.InputJsonValue } });
    return result;
  });
}

/** Curseur keyset UUID, pagination sans plafond silencieux. Les mises à jour gardent l'id. */
export function pageQuery(query: URLSearchParams) {
  const cursor = query.get("cursor");
  if (cursor) uuid(cursor);
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
