import { createHash } from "node:crypto";
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
      await tx.cashDeposit.update({ where, data: { lastSeenAt: new Date(), clientState: a.clientState, clientErrorCode: a.clientErrorCode } });
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
