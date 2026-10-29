import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { canonical, CashContractError, jsonValue, object, requireCash, type JsonRecord } from "./cash-day-projection.ts";

export type CashTx = Prisma.TransactionClient;
// Namespace UUID propre à Core-Caisse (v5 RFC 4122), figé pour stabiliser les dépôts de conflit.
const CASH_CONFLICT_NAMESPACE = "9f3f68b4-6f19-5a2d-9c87-01c455d11740";
function uuidV5(name: string) {
  const namespace = Buffer.from(CASH_CONFLICT_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespace).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class CashConflictAfterRollback extends CashContractError {
  readonly conflict: { actionName: string; tenantId: string; scope: string; businessDay: string; code: string };
  constructor(code: string, conflict: { actionName: string; tenantId: string; scope: string; businessDay: string }) {
    super(code, 409); this.conflict = { ...conflict, code };
  }
}
/** Dépose un signal APPLIED, hors file d'application. actionId rend l'écriture idempotente. */
export async function recordCashConflict(tx: CashTx, conflict: { actionName: string; tenantId: string; scope: string; businessDay: string; code: string }) {
  const actionId = uuidV5(conflict.actionName);
  const existing = await tx.cashDeposit.findFirst({ where: { tenantId: conflict.tenantId, actionId } });
  if (existing) return existing;
  const payload = {};
  const row = await tx.cashDeposit.create({ data: { tenantId: conflict.tenantId, actionId, deviceId: "core", kind: "conflit",
    operation: conflict.code, entityKey: conflict.businessDay, payload,
    payloadHash: createHash("sha256").update(canonical(payload)).digest("hex"), status: "APPLIED", appliedAt: new Date() } });
  console.warn(`[conflit] tenant=${conflict.tenantId} code=${conflict.code} businessDay=${conflict.businessDay}`);
  return row;
}
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
  return normalizeActionInput(v);
}
// La casse reçue reste disponible pour les recherches historiques, sans entrer dans
// le JSON durable ni dans les empreintes. Les normalisations successives la conservent.
const receivedInputs = new WeakMap<object, object>();
export function receivedActionInput<T extends object>(input: T): T {
  return (receivedInputs.get(input) ?? input) as T;
}
/** Parcourt toutes les valeurs ; seules les chaînes UUID complètes sont canonisées. */
export function normalizeActionInput<T>(input: T): T {
  if (typeof input === "string") return (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input) ? input.toLowerCase() : input) as T;
  if (input && (Array.isArray(input) || Object.prototype.toString.call(input) === "[object Object]")) {
    const normalized = Array.isArray(input) ? input.map(value => normalizeActionInput(value))
      : Object.fromEntries(Object.entries(input).map(([key, value]) => [key, normalizeActionInput(value)]));
    receivedInputs.set(normalized, receivedActionInput(input));
    return normalized as T;
  }
  return input;
}
/** Canonise uniquement les sous-chaînes UUID d'une référence métier composée. */
export function normalizeComposedUuidReference(value: string): string {
  return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, uuid => uuid.toLowerCase());
}
/** Formes exactes d'une référence historique contenant un ou plusieurs UUID. */
export function historicalComposedReferenceKeys(received: string): string[] {
  const normalized = normalizeComposedUuidReference(received);
  const upper = normalized.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, uuid => uuid.toUpperCase());
  return [...new Set([received, normalized, upper])];
}
export async function findHistoricalComposedReference<T>(received: string, read: (key: string) => Promise<T | null>): Promise<T | null> {
  for (const key of historicalComposedReferenceKeys(received)) { const row = await read(key); if (row) return row; }
  return null;
}
/** Tables historiques : au plus trois égalités indexées, sans réécrire la clé stockée. */
export async function findHistoricalKey<T>(received: string, read: (key: string) => Promise<T | null>): Promise<T | null> {
  const normalized = normalizeActionInput(received);
  const keys = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(received)
    ? [...new Set([received, normalized, received.toUpperCase()])] : [received];
  for (const key of keys) { const row = await read(key); if (row) return row; }
  return null;
}
/** Chaque composante texte d'une origine conserve ses égalités indexées. */
export async function findHistoricalSource<T>(source: { sourceType?: string | null; sourceId?: string | null },
  read: (sourceType: string, sourceId: string) => Promise<T | null>): Promise<T | null> {
  if (!source.sourceType || !source.sourceId) return null;
  return findHistoricalKey(source.sourceType, sourceType => findHistoricalKey(source.sourceId!, sourceId => read(sourceType, sourceId)));
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
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-l4:' + normalized}, 0))::text`;
}
export type ActionResponse = { status: number; body: JsonRecord };
/** Les UUID intégrés dans les noms de route font partie du contenu canonique. */
export function normalizeActionKind(kind: string): string {
  return kind.split(":").map(part => normalizeActionInput(part)).join(":");
}
function sameRequest(old: { kind: string; requestHash: string; payload: unknown }, kind: string, b: ActionInput, hash: string) {
  if (old.requestHash === hash) return true;
  // Le payload durable permet de retrouver la casse ORIGINALE, même si le rejeu en utilise une autre.
  const raw = object(old.payload);
  const originalHash = createHash("sha256").update(canonical({ kind: old.kind, b: raw })).digest("hex");
  return old.requestHash === originalHash && normalizeActionKind(old.kind) === kind
    && canonical(normalizeActionInput(raw)) === canonical(b);
}
/** L'accusé et la mutation métier commitent ensemble, y compris les candidats refusés. */
export async function cashAction(kind: string, b: ActionInput, mutate: (tx: CashTx) => Promise<unknown>): Promise<ActionResponse> {
  kind = normalizeActionKind(kind);
  b = normalizeActionInput(b);
  b.tenantId = uuid(b.tenantId); b.actionId = normalizeActionId(b.actionId);
  const requestHash = createHash("sha256").update(canonical({ kind, b })).digest("hex");
  return withTenant(b.tenantId, async tx => {
    await lockCashTenant(tx, b.tenantId);
    const previous = await tx.caisseSyncAction.findFirst({ where: { tenantId: b.tenantId, actionId: b.actionId } });
    const key = { tenantId_actionId: { tenantId: b.tenantId, actionId: previous?.actionId ?? b.actionId } };
    if (previous) {
      if (!sameRequest(previous, kind, b, requestHash)) return { status: 409, body: { ok: false, error: "ACTION_ID_CONFLICT" } };
      if (previous.state !== "PENDING") {
        const saved = object(previous.response);
        return { status: Number(saved.status), body: object(saved.body) };
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
      if (e instanceof CashConflictAfterRollback) await recordCashConflict(tx, e.conflict);
      result = { status: e.status, body: { ok: false, error: e.message, ...(e.data === undefined ? {} : { data: jsonValue(e.data) }) } };
    }
    // Refus dus à un état passager (reprise en cours, autre session encore ouverte) : jamais mémorisés,
    // le rejeu identique repasse par la mutation une fois la cause disparue.
    const retryable = result.status === 409 && ["LEGACY_IN_PROGRESS", "PREVIOUS_SESSION_OPEN"].includes(String(result.body.error));
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
  kind = normalizeActionKind(kind);
  b = normalizeActionInput(b);
  b.tenantId = uuid(b.tenantId); b.actionId = normalizeActionId(b.actionId);
  const requestHash = createHash("sha256").update(canonical({ kind, b })).digest("hex");
  return withTenant(b.tenantId, async tx => {
    await lockCashTenant(tx, b.tenantId);
    const old = await tx.caisseSyncAction.findFirst({ where: { tenantId: b.tenantId, actionId: b.actionId } });
    if (old) {
      requireCash(sameRequest(old, kind, b, requestHash), "ACTION_ID_CONFLICT", 409);
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
  const action = await tx.caisseSyncAction.findFirst({ where: { tenantId, actionId: actionId } });
  if (!action) return; // Le chemin historique peut être journalisé sans réservation de synchronisation.
  const operation = data.status === "PAID" ? "checkout" : data.status === "VOID" ? "void" : data.status === "DONE" ? "partial-refund" : null;
  const saleId = data.saleId ?? data.id;
  const parts = normalizeActionKind(action.kind).split(":");
  requireCash(operation && parts.length === 5 && parts[0] === "cash-days" && parts[2] === "sales"
    && parts[3] === saleId && parts[4] === operation && (!data.cashDayId || parts[1] === data.cashDayId), "ACTION_ID_CONFLICT", 409);
  if (validateOnly) return;
  const response = jsonValue({ ok: true, id: data.id, revision: data.revision ?? 0, alreadyApplied: false, data }) as Prisma.InputJsonValue;
  await tx.caisseSyncAction.updateMany({ where: { tenantId, actionId: action.actionId, kind: action.kind, entityKey: action.entityKey, state: "PENDING" }, data: { state: "ACK", response } });
}
