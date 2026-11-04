import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { canonical, CashContractError, object, requireCash } from "./cash-day-projection.ts";
import { date, uuid } from "./caisse-sync.ts";

export type CashDepositTx = Prisma.TransactionClient;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export async function readDepositBody(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw new CashContractError("INVALID_PAYLOAD");
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new CashContractError("BODY_TOO_LARGE", 413); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new SyntaxError("INVALID_PAYLOAD"); }
}
const nullableText = (v: unknown, max: number, field: string): string | null => {
  if (v === null || v === undefined) return null;
  requireCash(typeof v === "string" && v.length <= max, "INVALID_" + field.toUpperCase());
  return v;
};
function action(raw: unknown) {
  const a = object(raw), payload = object(a.payload);
  const isJson = (v: unknown): boolean => v === null || typeof v === "string" || typeof v === "boolean"
    || (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.every(isJson))
    || (!!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
      && Object.values(v).every(isJson));
  requireCash(isJson(payload), "INVALID_PAYLOAD");
  requireCash(a.dependsOn === undefined || (Array.isArray(a.dependsOn) && a.dependsOn.every(x => typeof x === "string")), "INVALID_DEPENDS_ON");
  const createdAt = a.clientCreatedAt == null ? null : date(a.clientCreatedAt);
  const kind = nullableText(a.kind, 40, "kind"); requireCash(!!kind, "INVALID_KIND");
  const deviceId = nullableText(a.deviceId, 200, "deviceId"); requireCash(!!deviceId, "INVALID_DEVICE_ID");
  return { actionId: uuid(a.actionId), deviceId, deviceName: nullableText(a.deviceName, 200, "deviceName"), kind,
    operation: nullableText(a.operation, 200, "operation"), entityKey: nullableText(a.entityKey, 300, "entityKey"),
    payload: payload as Prisma.InputJsonObject, dependsOn: (a.dependsOn ?? []) as string[], payloadHash: createHash("sha256").update(canonical(payload)).digest("hex"),
    clientCreatedAt: createdAt, clientState: nullableText(a.clientState, 100, "clientState"), clientErrorCode: nullableText(a.clientErrorCode, 200, "clientErrorCode") };
}
// Enveloppe de format 2 : HORS du payload et de payloadHash. Format 1 (absent ou 1) : rien n'est lu.
function envelopeOf(raw: unknown): { formatVersion: 2; sequence: bigint; actorId: string | null; actorName: string | null; receivedById: string | null } | null {
  const a = object(raw);
  if (a.formatVersion === undefined || a.formatVersion === null || a.formatVersion === 1) return null;
  requireCash(a.formatVersion === 2, "INVALID_FORMAT_VERSION");
  const s = a.sequence;
  requireCash((typeof s === "number" && Number.isSafeInteger(s) && s >= 0) || (typeof s === "string" && /^[0-9]{1,18}$/.test(s)), "INVALID_SEQUENCE");
  return { formatVersion: 2, sequence: BigInt(s as number | string), actorId: nullableText(a.actorId, 200, "actorId"),
    actorName: nullableText(a.actorName, 200, "actorName"), receivedById: nullableText(a.receivedById, 200, "receivedById") };
}
// Élément de `applied` : UUID seul (inchangé) ou {actionId, resultJson: objet} (format 2 accusé par la tablette).
function appliedItem(v: unknown): { actionId: string; resultJson: Prisma.InputJsonObject | null } {
  if (typeof v === "string") return { actionId: uuid(v), resultJson: null };
  requireCash(!!v && typeof v === "object" && !Array.isArray(v), "INVALID_APPLIED");
  const o = v as Record<string, unknown>, r = o.resultJson;
  requireCash(Object.keys(o).every(k => k === "actionId" || k === "resultJson"), "INVALID_APPLIED");
  requireCash(typeof o.actionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.actionId), "INVALID_APPLIED");
  requireCash(!!r && typeof r === "object" && !Array.isArray(r), "INVALID_APPLIED");
  return { actionId: o.actionId.toLowerCase(), resultJson: r as Prisma.InputJsonObject };
}
export function validateDepositInput(input: unknown) {
  const b = object(input), tenantId = uuid(b.tenantId);
  let bodySize = 0;
  try { bodySize = Buffer.byteLength(JSON.stringify(input)); } catch { throw new CashContractError("INVALID_PAYLOAD"); }
  requireCash(bodySize <= MAX_BODY_BYTES, "BODY_TOO_LARGE", 413);
  requireCash(Array.isArray(b.actions) && b.actions.length <= 200, "INVALID_ACTIONS");
  requireCash(b.applied === undefined || (Array.isArray(b.applied) && b.applied.length <= 1000), "INVALID_APPLIED");
  // Une file vidée après accusés n'a plus que des « applied » à dire : lot d'actions vide permis, corps vide refusé.
  requireCash(b.actions.length + (b.applied?.length ?? 0) >= 1, "INVALID_ACTIONS");
  const items = (b.applied ?? []).map(appliedItem);
  return { tenantId, actions: b.actions.map(action), envelopes: b.actions.map(envelopeOf),
    applied: items.map(i => i.actionId), appliedPlain: items.filter(i => !i.resultJson).map(i => i.actionId), appliedWithResult: items.filter(i => i.resultJson) };
}
export async function depositActions(tx: CashDepositTx, input: unknown) {
  const b = validateDepositInput(input), results: { actionId: string; result: string }[] = [];
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-deposit:' + b.tenantId}, 0))::text`;
  for (const [i, a] of b.actions.entries()) {
    const env = b.envelopes[i];
    const where = { tenantId_actionId: { tenantId: b.tenantId, actionId: a.actionId } };
    const prior = await tx.cashDeposit.findUnique({ where });
    if (!prior) { await tx.cashDeposit.create({ data: { tenantId: b.tenantId, ...a, ...(env ?? {}) } }); results.push({ actionId: a.actionId, result: "stored" }); }
    else if (prior.payloadHash === a.payloadHash) {
      // Format 2 : un champ d'auteur déjà renseigné n'est jamais remplacé (seulement complété s'il est null).
      const authors: Record<string, string> = {};
      if (env) for (const k of ["actorId", "actorName", "receivedById"] as const) if (prior[k] == null && env[k] != null) authors[k] = env[k]!;
      await tx.cashDeposit.update({ where, data: { lastSeenAt: new Date(), clientState: a.clientState, clientErrorCode: a.clientErrorCode, ...authors } });
      results.push({ actionId: a.actionId, result: "seen" });
    } else {
      await tx.cashDeposit.update({ where, data: { conflictCount: { increment: 1 } } }); results.push({ actionId: a.actionId, result: "conflict" });
    }
  }
  if (b.appliedPlain.length) await tx.cashDeposit.updateMany({ where: { tenantId: b.tenantId, actionId: { in: b.appliedPlain }, status: "PENDING" }, data: { status: "APPLIED", appliedAt: new Date() } });
  // Avec resultJson : seule une ligne encore PENDING change ; une ligne APPLIED n'est jamais réécrite.
  for (const i of b.appliedWithResult) { const at = new Date();
    await tx.cashDeposit.updateMany({ where: { tenantId: b.tenantId, actionId: i.actionId, status: "PENDING" }, data: { status: "APPLIED", appliedAt: at, resultJson: i.resultJson!, lastResultCode: "APPLIED", lastAttemptAt: at } }); }
  return { results, applied: b.applied };
}
export async function listDeposits(tx: CashDepositTx, input: { tenantId: string; status?: string | null; cursor?: string | null; limit?: string | number | null; withPayload?: string | null }) {
  const tenantId = uuid(input.tenantId), status = input.status ?? undefined;
  requireCash(status === undefined || ["PENDING", "APPLIED"].includes(status), "INVALID_STATUS");
  const limit = Number(input.limit ?? 50); requireCash(Number.isInteger(limit) && limit >= 1 && limit <= 200, "INVALID_LIMIT");
  let cursor: { receivedAt: Date; id: string } | undefined;
  if (input.cursor) {
    try { const c = JSON.parse(input.cursor); cursor = { receivedAt: new Date(c.receivedAt), id: uuid(c.id) }; requireCash(Number.isFinite(cursor.receivedAt.getTime())); }
    catch { throw new CashContractError("INVALID_CURSOR"); }
  }
  const select = { id: true, tenantId: true, actionId: true, deviceId: true, deviceName: true, kind: true, operation: true, entityKey: true,
    ...(input.withPayload === "1" ? { payload: true } : {}), dependsOn: true, payloadHash: true, clientCreatedAt: true, clientState: true,
    clientErrorCode: true, receivedAt: true, lastSeenAt: true, status: true, appliedAt: true, conflictCount: true } as const;
  const rows = await tx.cashDeposit.findMany({ where: { tenantId, ...(status ? { status } : {}), ...(cursor ? { OR: [{ receivedAt: { gt: cursor.receivedAt } }, { receivedAt: cursor.receivedAt, id: { gt: cursor.id } }] } : {}) },
    select, orderBy: [{ receivedAt: "asc" }, { id: "asc" }], take: limit + 1 });
  const more = rows.length > limit, page = rows.slice(0, limit);
  return { items: page, nextCursor: more && page.length ? JSON.stringify({ receivedAt: page.at(-1)!.receivedAt, id: page.at(-1)!.id }) : null };
}

// ---- Application par le serveur (2026-11-04) : bail par commerce, claim / result / release. ----
export const LEASE_MS = 60_000;
const lockTenantDeposits = (tx: CashDepositTx, tenantId: string) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-deposit:' + tenantId}, 0))::text`;
const holderText = (v: unknown) => { requireCash(typeof v === "string" && v.trim().length > 0 && v.length <= 100, "INVALID_HOLDER"); return v; };
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validateClaimInput(input: unknown) {
  const b = object(input), limit = b.limit === undefined ? 50 : b.limit;
  requireCash(typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 100, "INVALID_LIMIT");
  return { tenantId: uuid(b.tenantId), holder: holderText(b.holder), limit };
}
export async function claimDeposits(tx: CashDepositTx, input: unknown) {
  const b = validateClaimInput(input);
  await lockTenantDeposits(tx, b.tenantId);
  const now = new Date(), lease = await tx.cashDepositLease.findUnique({ where: { tenantId: b.tenantId } });
  if (lease && lease.holder !== b.holder && lease.until.getTime() > now.getTime()) throw new CashContractError("LEASE_HELD", 409, { until: lease.until });
  const token = lease && lease.holder === b.holder ? lease.token : randomUUID(), until = new Date(now.getTime() + LEASE_MS);
  await tx.cashDepositLease.upsert({ where: { tenantId: b.tenantId }, create: { tenantId: b.tenantId, holder: b.holder, token, until }, update: { holder: b.holder, token, until } });
  // Format 1 : rejoué par la tablette, jamais appliqué ici ; seul lastResultCode est posé (status inchangé).
  await tx.cashDeposit.updateMany({ where: { tenantId: b.tenantId, status: "PENDING", formatVersion: 1, lastResultCode: null }, data: { lastResultCode: "REJEU_TABLETTE" } });
  const rows = await tx.cashDeposit.findMany({ where: { tenantId: b.tenantId, status: "PENDING", formatVersion: 2 },
    orderBy: [{ deviceId: "asc" }, { sequence: "asc" }, { clientCreatedAt: "asc" }, { actionId: "asc" }], take: b.limit,
    select: { actionId: true, kind: true, operation: true, entityKey: true, payload: true, dependsOn: true, clientState: true, clientErrorCode: true,
      sequence: true, actorId: true, actorName: true, receivedById: true, attempts: true, lastResultCode: true } });
  const depIds = [...new Set(rows.flatMap(r => (Array.isArray(r.dependsOn) ? r.dependsOn : []).filter(isUuid).map(x => x.toLowerCase())))];
  const deps = depIds.length ? await tx.cashDeposit.findMany({ where: { tenantId: b.tenantId, actionId: { in: depIds } }, select: { actionId: true, status: true, resultJson: true } }) : [];
  const byId = new Map(deps.map(d => [d.actionId, { status: d.status, resultJson: d.resultJson ?? null }]));
  const items = rows.map(r => {
    const ids = Array.isArray(r.dependsOn) ? (r.dependsOn as string[]) : [];
    return { ...r, dependencies: Object.fromEntries(ids.map(id => [id, isUuid(id) ? byId.get(id.toLowerCase()) ?? null : null])) };
  });
  return { token, until, items };
}
const OUTCOMES = ["APPLIED", "REFUSED", "WAITING"] as const;
export function validateResultInput(input: unknown) {
  const b = object(input), outcome = b.outcome as (typeof OUTCOMES)[number];
  requireCash(OUTCOMES.includes(outcome), "INVALID_OUTCOME");
  const base = { tenantId: uuid(b.tenantId), token: uuid(b.token), actionId: uuid(b.actionId), outcome };
  if (outcome === "APPLIED") {
    const r = b.resultJson;
    requireCash(!!r && typeof r === "object" && !Array.isArray(r), "INVALID_RESULT_JSON");
    return { ...base, resultJson: r as Prisma.InputJsonObject, code: null, reason: null };
  }
  requireCash(typeof b.code === "string" && b.code.trim().length > 0 && b.code.length <= 100, "INVALID_CODE");
  return { ...base, resultJson: null, code: b.code, reason: nullableText(b.reason, 300, "reason") };
}
async function currentLease(tx: CashDepositTx, tenantId: string, token: string, now: Date) {
  const lease = await tx.cashDepositLease.findUnique({ where: { tenantId } });
  requireCash(!!lease && lease.token === token && lease.until.getTime() > now.getTime(), "LEASE_LOST", 409);
}
export async function recordDepositResult(tx: CashDepositTx, input: unknown) {
  const b = validateResultInput(input);
  await lockTenantDeposits(tx, b.tenantId);
  const now = new Date();
  await currentLease(tx, b.tenantId, b.token, now);
  const where = { tenantId_actionId: { tenantId: b.tenantId, actionId: b.actionId } };
  const row = await tx.cashDeposit.findUnique({ where });
  requireCash(!!row, "NOT_FOUND", 404);
  requireCash(row.formatVersion === 2, "FORMAT_NOT_APPLICABLE", 409);
  if (row.status === "APPLIED") {
    requireCash(b.outcome === "APPLIED" && canonical(row.resultJson) === canonical(b.resultJson), "ALREADY_APPLIED", 409);
    return { actionId: b.actionId, status: "APPLIED", idempotent: true };
  }
  const common = { attempts: { increment: 1 }, lastAttemptAt: now };
  if (b.outcome === "APPLIED") await tx.cashDeposit.update({ where, data: { ...common, status: "APPLIED", appliedAt: now, resultJson: b.resultJson!, lastResultCode: "APPLIED", lastResultReason: null } });
  else await tx.cashDeposit.update({ where, data: { ...common, lastResultCode: b.code, lastResultReason: b.reason } });
  return { actionId: b.actionId, status: b.outcome === "APPLIED" ? "APPLIED" : "PENDING", idempotent: false };
}
export async function releaseLease(tx: CashDepositTx, input: unknown) {
  const b = object(input), tenantId = uuid(b.tenantId), token = uuid(b.token);
  await lockTenantDeposits(tx, tenantId);
  // Libérer = expirer le bail (aucune suppression) ; un autre applicateur peut le reprendre aussitôt.
  const released = await tx.cashDepositLease.updateMany({ where: { tenantId, token, until: { gt: new Date() } }, data: { until: new Date() } });
  return { released: released.count === 1 };
}
