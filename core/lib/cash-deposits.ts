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
  const formatVersion = a.formatVersion == null ? null : a.formatVersion;
  requireCash(formatVersion === null || formatVersion === 1 || formatVersion === 2, "INVALID_FORMAT_VERSION");
  const sequence = a.sequence == null ? null : a.sequence;
  requireCash(sequence === null || (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0), "INVALID_SEQUENCE");
  if (formatVersion === 2) {
    requireCash(sequence !== null, "INVALID_SEQUENCE");
    requireCash((a.actorId == null) === (a.receivedById == null), "INVALID_AUTHOR_IDS");
    if (a.actorId != null) {
      try { uuid(a.actorId); uuid(a.receivedById); }
      catch { throw new CashContractError("INVALID_AUTHOR_IDS"); }
    }
  }
  return { actionId: uuid(a.actionId), deviceId, deviceName: nullableText(a.deviceName, 200, "deviceName"), kind,
    operation: nullableText(a.operation, 200, "operation"), entityKey: nullableText(a.entityKey, 300, "entityKey"),
    payload: payload as Prisma.InputJsonObject, dependsOn: (a.dependsOn ?? []) as string[], payloadHash: createHash("sha256").update(canonical(payload)).digest("hex"),
    clientCreatedAt: createdAt, clientState: nullableText(a.clientState, 100, "clientState"), clientErrorCode: nullableText(a.clientErrorCode, 200, "clientErrorCode"),
    formatVersion, sequence: sequence === null ? null : BigInt(sequence as number), actorId: a.actorId == null ? null : uuid(a.actorId), receivedById: a.receivedById == null ? null : uuid(a.receivedById) };
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
  return { tenantId, actions: b.actions.map(action), applied: (b.applied ?? []).map(uuid) };
}
export async function depositActions(tx: CashDepositTx, input: unknown) {
  const b = validateDepositInput(input), results: { actionId: string; result: string }[] = [];
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash-deposit:' + b.tenantId}, 0))::text`;
  for (const a of b.actions) {
    const where = { tenantId_actionId: { tenantId: b.tenantId, actionId: a.actionId } };
    const prior = await tx.cashDeposit.findUnique({ where });
    if (!prior) { await tx.cashDeposit.create({ data: { tenantId: b.tenantId, ...a } }); results.push({ actionId: a.actionId, result: "stored" }); }
    else if (prior.payloadHash === a.payloadHash) {
      await tx.cashDeposit.update({ where, data: { lastSeenAt: new Date() } });
      results.push({ actionId: a.actionId, result: "seen" });
    } else {
      await tx.cashDeposit.update({ where, data: { conflictCount: { increment: 1 } } }); results.push({ actionId: a.actionId, result: "conflict" });
    }
  }
  if (b.applied.length) await tx.cashDeposit.updateMany({ where: { tenantId: b.tenantId, actionId: { in: b.applied }, status: "PENDING" }, data: { status: "APPLIED", appliedAt: new Date() } });
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

export function validateClaimInput(input: unknown) {
  const b = object(input), tenantId = uuid(b.tenantId), holder = nullableText(b.holder, 100, "holder");
  requireCash(!!holder, "INVALID_HOLDER");
  requireCash(typeof b.leaseSeconds === "number" && Number.isInteger(b.leaseSeconds) && b.leaseSeconds >= 1 && b.leaseSeconds <= 60, "INVALID_LEASE_SECONDS");
  requireCash(typeof b.limit === "number" && Number.isInteger(b.limit) && b.limit >= 1 && b.limit <= 200, "INVALID_LIMIT");
  let after: { deviceId: string; sequence: number; actionId: string } | null = null;
  if (b.after != null) {
    try {
      const c = object(b.after), deviceId = nullableText(c.deviceId, 200, "deviceId");
      requireCash(!!deviceId && typeof c.sequence === "number" && Number.isSafeInteger(c.sequence) && c.sequence >= 0, "INVALID_CURSOR");
      after = { deviceId, sequence: c.sequence as number, actionId: uuid(c.actionId) };
    } catch { throw new CashContractError("INVALID_CURSOR"); }
  }
  return { tenantId, holder, leaseSeconds: b.leaseSeconds as number, limit: b.limit as number, after };
}
export async function claimDeposits(tx: CashDepositTx, input: ReturnType<typeof validateClaimInput>) {
  const token = randomUUID();
  const leases = await tx.$queryRaw<{ token: string; until: Date }[]>`INSERT INTO "CashDepositLease" ("tenantId", holder, token, "until") VALUES (${input.tenantId}::uuid, ${input.holder}, ${token}::uuid, clock_timestamp() + (${input.leaseSeconds} * interval '1 second')) ON CONFLICT ("tenantId") DO UPDATE SET holder=EXCLUDED.holder, token=EXCLUDED.token, "until"=EXCLUDED."until" WHERE "CashDepositLease"."until" <= clock_timestamp() OR "CashDepositLease".holder=EXCLUDED.holder RETURNING token, "until"`;
  if (!leases.length) return null;
  await tx.cashDeposit.updateMany({ where: { tenantId: input.tenantId, status: "PENDING", OR: [{ formatVersion: null }, { formatVersion: 1 }], lastResultCode: null }, data: { lastResultCode: "REJEU_TABLETTE" } });
  const after = input.after;
  const candidates = await tx.cashDeposit.findMany({ where: { tenantId: input.tenantId, status: "PENDING", formatVersion: 2,
    ...(after ? { OR: [
      { deviceId: { gt: after.deviceId } },
      { deviceId: after.deviceId, sequence: { gt: BigInt(after.sequence) } },
      { deviceId: after.deviceId, sequence: BigInt(after.sequence), actionId: { gt: after.actionId } },
    ] } : {}) }, orderBy: [{ deviceId: "asc" }, { sequence: "asc" }, { actionId: "asc" }], take: input.limit + 1 });
  const rows = candidates.slice(0, input.limit), last = rows.at(-1);
  const nextAfter = candidates.length > input.limit && last
    ? { deviceId: last.deviceId, sequence: Number(last.sequence), actionId: last.actionId } : null;
  const deps = [...new Set(rows.flatMap(r => Array.isArray(r.dependsOn) ? r.dependsOn.filter((x): x is string => typeof x === "string").map(x => x.toLowerCase()).filter(x => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)) : []))];
  const depRows = deps.length ? await tx.cashDeposit.findMany({ where: { tenantId: input.tenantId, actionId: { in: deps } }, select: { actionId: true, status: true, resultJson: true } }) : [];
  const byId = new Map(depRows.map(x => [x.actionId, x]));
  return { token: leases[0].token, until: leases[0].until, nextAfter, items: rows.map(r => ({ ...r, dependances: depsFor(r.dependsOn, byId) })) };
}
function depsFor(value: unknown, byId: Map<string, { actionId: string; status: string; resultJson: unknown }>) {
  return Array.isArray(value) ? value.flatMap(x => typeof x === "string"
    ? [byId.get(x.toLowerCase()) ?? { actionId: x, status: "MISSING", resultJson: null }] : []) : [];
}
export function validateResultInput(input: unknown) {
  const b = object(input), tenantId = uuid(b.tenantId), token = uuid(b.token), actionId = uuid(b.actionId);
  requireCash(["APPLIED", "REFUSED", "WAITING"].includes(String(b.outcome)), "INVALID_OUTCOME");
  requireCash(typeof b.code === "string" && b.code.length >= 1 && b.code.length <= 60 && /^[A-Z0-9_]+$/.test(b.code), "INVALID_CODE");
  requireCash(typeof b.reason === "string" && b.reason.length <= 300, "INVALID_REASON");
  let result: object | null = null;
  if (b.outcome === "APPLIED") {
    requireCash(!!b.result && typeof b.result === "object" && !Array.isArray(b.result), "INVALID_RESULT");
    const isJson = (v: unknown, seen = new Set<object>()): boolean => {
      if (v === null || typeof v === "string" || typeof v === "boolean") return true;
      if (typeof v === "number") return Number.isFinite(v);
      if (typeof v !== "object" || v instanceof Date || seen.has(v)) return false;
      seen.add(v);
      const valid = Array.isArray(v) ? v.every(x => isJson(x, seen))
        : (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
          && Object.values(v).every(x => isJson(x, seen));
      seen.delete(v); return valid;
    };
    requireCash(isJson(b.result), "INVALID_RESULT");
    requireCash(Buffer.byteLength(JSON.stringify(b.result)) <= 16384, "RESULT_TOO_LARGE"); result = b.result as object;
  } else requireCash(b.result === undefined, "INVALID_RESULT");
  return { tenantId, token, actionId, outcome: b.outcome as "APPLIED" | "REFUSED" | "WAITING", code: b.code, reason: b.reason, result };
}
export async function recordDepositResult(tx: CashDepositTx, input: ReturnType<typeof validateResultInput>) {
  const lease = await tx.$queryRaw<{ token: string; until: Date }[]>`SELECT token, "until" FROM "CashDepositLease" WHERE "tenantId"=${input.tenantId}::uuid FOR UPDATE`;
  const now = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!lease.length || lease[0].token !== input.token || lease[0].until <= now[0].now) return { error: "LEASE_LOST" };
  const where = { tenantId_actionId: { tenantId: input.tenantId, actionId: input.actionId } };
  const prior = await tx.cashDeposit.findUnique({ where });
  if (!prior) throw new CashContractError("NOT_FOUND", 404);
  if (prior.status === "APPLIED") return { status: "APPLIED", resultJson: prior.resultJson };
  if (input.outcome === "APPLIED") {
    const updated = await tx.cashDeposit.update({ where, data: { status: "APPLIED", appliedAt: now[0].now, resultJson: input.result as Prisma.InputJsonObject, lastResultCode: null, lastResultReason: null } });
    return { status: updated.status, resultJson: updated.resultJson };
  }
  const updated = await tx.cashDeposit.update({ where, data: { attempts: { increment: 1 }, lastAttemptAt: now[0].now, lastResultCode: input.code, lastResultReason: input.reason } });
  return { status: updated.status, attempts: updated.attempts, lastResultCode: updated.lastResultCode };
}
