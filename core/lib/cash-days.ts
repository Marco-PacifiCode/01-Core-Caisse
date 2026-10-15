import type { Prisma } from "@prisma/client";
import { closeSessionTx, openSessionTx } from "./caisse";
import { appendDayFact, lockDay, readFacts, recordSharedSale } from "./cash-day-ledger";
import { date, text, uuid, type ActionInput, type CashTx } from "./caisse-sync";
import { businessDay, canonical, CashContractError, jsonValue, object, projectCashDay, requireCash, safeXpf, validDay, xpfInteger, type DayClosure } from "./cash-day-projection";

export function sourceAuthor(b: ActionInput) {
  const receivedById = uuid(b.receivedById);
  requireCash(b.importMode === true || !!b.actorId);
  return { actorId: b.actorId == null ? null : uuid(b.actorId), actorName: b.actorId == null ? "auteur non enregistré" : text(b.actorName), receivedById };
}
function dayOf(b: ActionInput) {
  const day = validDay(b.businessDay);
  requireCash(businessDay(date(b.occurredAt)) === day, "DAY_MISMATCH", 409);
  requireCash(b.scope === undefined || b.scope === "rotisserie-caisse");
  return day;
}
export async function openCashDay(tx: CashTx, b: ActionInput) {
  const business = dayOf(b), tenantId = b.tenantId, author = sourceAuthor(b);
  const sourceKey = text(b.sourceKey, 300), localSessionKey = text(b.localSessionKey, 300);
  const openingFloatXpf = xpfInteger(b.openingFloatXpf);
  const deviceName = text(b.deviceName);
  let day = await tx.cashDay.findUnique({ where: { tenantId_scope_businessDay: { tenantId, scope: "rotisserie-caisse", businessDay: business } } });
  if (!day) {
    const native = await openSessionTx(tx, tenantId, { openedBy: author.actorId ?? author.receivedById,
      openedByName: author.actorName, openingFloatXpf, occurredAt: date(b.occurredAt) });
    const session = native.ok ? native.session : await tx.cashSession.findFirst({ where: { tenantId, id: native.sessionId } });
    if (!session || businessDay(session.openedAt) !== business) throw new CashContractError("PREVIOUS_SESSION_OPEN", 409, native);
    day = await tx.cashDay.create({ data: { tenantId, businessDay: business, canonicalSessionId: session.id, currentSessionId: session.id } });
    await tx.cashDaySession.create({ data: { tenantId, cashDayId: day.id, sessionId: session.id, cycle: 0 } });
  }
  const locked = await lockDay(tx, tenantId, day.id);
  const prior = await tx.cashDayOpening.findUnique({ where: { tenantId_sourceKey: { tenantId, sourceKey } } });
  if (prior) {
    requireCash(prior.cashDayId === day.id && prior.openingFloatXpf === openingFloatXpf && prior.localSessionKey === localSessionKey,
      "SOURCE_CONFLICT", 409);
    requireCash(prior.deviceId === b.deviceId && prior.deviceName === deviceName && prior.actorId === author.actorId
      && prior.actorName === author.actorName && prior.occurredAt.getTime() === date(b.occurredAt).getTime(), "SOURCE_CONFLICT", 409);
  } else {
    await tx.cashDayOpening.create({ data: { tenantId, cashDayId: day.id, sourceKey, localSessionKey, deviceId: b.deviceId, deviceName,
      ...author, occurredAt: date(b.occurredAt), openingFloatXpf } });
    await appendDayFact(tx, tenantId, day.id, { kind: "OPENING", sourceRef: sourceKey, deviceId: b.deviceId,
      occurredAt: date(b.occurredAt), snapshot: { ...author, localSessionKey, openingFloatXpf, deviceName } });
  }
  return { ...(await dayState(tx, tenantId, day.id)), fondRetenu: String(locked.canonicalSession.openingFloatXpf),
    fondNonRetenu: openingFloatXpf !== locked.canonicalSession.openingFloatXpf };
}
export async function dayState(tx: CashTx, tenantId: string, id: string) {
  const day = await lockDay(tx, tenantId, id);
  return { id: day.id, cashDayId: day.id, businessDay: day.businessDay, scope: day.scope, cycle: day.cycle,
    sessionId: day.currentSessionId, canonicalSessionId: day.canonicalSessionId, status: day.currentSession.status,
    revision: day.revision, fond: day.canonicalSession.openingFloatXpf, openedBy: day.currentSession.openedBy,
    openedByName: day.currentSession.openedByName, openedAt: day.currentSession.openedAt, closedBy: day.currentSession.closedBy,
    closedByName: day.currentSession.closedByName, closedAt: day.currentSession.closedAt };
}
export async function closeCashDay(tx: CashTx, cashDayId: string, b: ActionInput) {
  const day = await lockDay(tx, b.tenantId, cashDayId), author = sourceAuthor(b);
  const countedXpf = xpfInteger(b.countedXpf), occurredAt = date(b.occurredAt);
  requireCash(businessDay(occurredAt) === day.businessDay, "DAY_MISMATCH", 409);
  const closureMode = text(b.closureMode);
  requireCash(["ONLINE", "OFFLINE", "IMPORT"].includes(closureMode));
  const localExpectedXpf = xpfInteger(b.localExpectedXpf, true), localVarianceXpf = xpfInteger(b.localVarianceXpf, true);
  requireCash(localVarianceXpf === countedXpf - localExpectedXpf);
  // Une fermeture hors ligne est liée au cycle VU, jamais au cycle courant à sa réception.
  requireCash(Number.isSafeInteger(b.cycle) && Number(b.cycle) >= 0 && Number(b.cycle) <= day.cycle);
  const cycle = Number(b.cycle);
  if (closureMode !== "ONLINE") {
    const snapshot = object(b.legacySnapshot);
    requireCash(Array.isArray(snapshot.knownSourceRefs) && snapshot.knownSourceRefs.every((s: unknown) => typeof s === "string"));
  }
  const sourceKey = text(b.sourceKey, 300);
  const previous = await tx.cashDayClosure.findUnique({ where: { tenantId_sourceKey: { tenantId: b.tenantId, sourceKey } } });
  if (previous) {
    requireCash(previous.cashDayId === day.id && previous.countedXpf === countedXpf && previous.cycle === cycle
      && previous.localExpectedXpf === localExpectedXpf && previous.localVarianceXpf === localVarianceXpf
      && previous.closureMode === closureMode && previous.deviceId === b.deviceId && previous.deviceName === b.deviceName
      && previous.actorId === author.actorId && previous.actorName === author.actorName && previous.occurredAt.getTime() === occurredAt.getTime()
      && canonical(previous.legacySnapshot) === canonical(b.legacySnapshot ?? null), "SOURCE_CONFLICT", 409);
    return { id: previous.id, alreadyClosed: true, recount: !previous.authoritative, cutoffRevision: previous.cutoffRevision };
  }
  const first = await tx.cashDayClosure.findFirst({ where: { tenantId: b.tenantId, cashDayId, cycle, authoritative: true } });
  let legacySessionId: string | undefined;
  if (b.legacySessionId !== undefined) {
    legacySessionId = uuid(b.legacySessionId);
    const alias = await tx.cashDaySession.findUnique({ where: { tenantId_sessionId: { tenantId: b.tenantId, sessionId: legacySessionId } } });
    requireCash(alias?.cashDayId === day.id, "DAY_MISMATCH", 409);
  }
  const authoritative = !first && cycle === day.cycle;
  const marker = await appendDayFact(tx, b.tenantId, day.id, { kind: "CLOSURE", sourceRef: sourceKey, deviceId: b.deviceId, occurredAt,
    snapshot: { cycle, countedXpf, ...author } });
  const facts = await readFacts(tx, b.tenantId, day.id, marker.sequence);
  const expected = projectCashDay({ fond: day.canonicalSession.openingFloatXpf, cycle, revision: marker.sequence, facts, closures: [] }).totauxCourants.expectedXpf;
  let report: unknown = null;
  if (authoritative) {
    // Le rapport natif utilise son contrat numérique historique : refus de conversion non sûre.
    safeXpf(countedXpf); safeXpf(expected);
    const native = await closeSessionTx(tx, b.tenantId, { sessionId: day.currentSessionId, closedBy: author.actorId ?? author.receivedById,
      closedByName: author.actorName, closingCountedXpf: countedXpf });
    requireCash(native.ok, "NOT_FOUND", 404);
    report = native.report;
    // Heure d'origine seulement à la première clôture ; aucune pièce fermée n'est réécrite.
    if (!native.alreadyClosed) await tx.cashSession.update({ where: { id: day.currentSessionId }, data: { closedAt: occurredAt } });
  }
  const closure = await tx.cashDayClosure.create({ data: { tenantId: b.tenantId, cashDayId, sourceKey, cycle, deviceId: b.deviceId,
    deviceName: text(b.deviceName), ...author, occurredAt, countedXpf, localExpectedXpf, localVarianceXpf,
    baselineExpectedXpf: closureMode === "ONLINE" ? expected : localExpectedXpf, closureMode, cutoffRevision: marker.sequence,
    authoritative, legacySessionId, ...(b.legacySnapshot === undefined ? {} : { legacySnapshot: jsonValue(b.legacySnapshot) as Prisma.InputJsonValue }) } });
  return { id: closure.id, closureId: closure.id, cashDayId, revision: marker.sequence, cutoffRevision: marker.sequence,
    alreadyClosed: !!first, recount: !authoritative, report };
}
export async function reopenCashDay(tx: CashTx, id: string, b: ActionInput) {
  const day = await lockDay(tx, b.tenantId, id), author = sourceAuthor(b);
  // Le relais S2S vérifie le cookie Administration signé ; le Core exige son attestation.
  requireCash(b.administration === true && !!author.actorId, "MODE_CAISSE", 403);
  requireCash(day.businessDay === businessDay(new Date()) && businessDay(date(b.occurredAt)) === day.businessDay, "DAY_MISMATCH", 409);
  requireCash(day.currentSession.status === "CLOSED", "DAY_ALREADY_OPEN", 409);
  const native = await openSessionTx(tx, b.tenantId, { openedBy: author.actorId!, openedByName: author.actorName,
    openingFloatXpf: 0n, occurredAt: date(b.occurredAt) });
  requireCash(native.ok, "PREVIOUS_SESSION_OPEN", 409);
  await tx.cashDaySession.create({ data: { tenantId: b.tenantId, cashDayId: id, sessionId: native.session.id, cycle: day.cycle + 1 } });
  await tx.cashDay.update({ where: { tenantId_id: { tenantId: b.tenantId, id } }, data: { currentSessionId: native.session.id, cycle: { increment: 1 } } });
  await appendDayFact(tx, b.tenantId, id, { kind: "REOPEN", sourceRef: b.actionId, deviceId: b.deviceId, occurredAt: date(b.occurredAt),
    snapshot: { ...author, cycle: day.cycle + 1, sessionId: native.session.id } });
  return dayState(tx, b.tenantId, id);
}
export async function ledgerPage(tx: CashTx, tenantId: string, id: string, q: URLSearchParams) {
  const day = await lockDay(tx, tenantId, id);
  const revision = q.has("atRevision") ? xpfInteger(q.get("atRevision")) : day.revision;
  const after = q.has("afterSequence") ? xpfInteger(q.get("afterSequence")) : q.has("cursor") ? xpfInteger(q.get("cursor")) : 0n;
  requireCash(revision <= day.revision && after <= revision);
  const rows = await tx.cashDayEvent.findMany({ where: { tenantId, cashDayId: id, sequence: { gt: after, lte: revision } }, orderBy: { sequence: "asc" }, take: 201 });
  const facts = await readFacts(tx, tenantId, id, revision);
  const closures: DayClosure[] = await tx.cashDayClosure.findMany({ where: { tenantId, cashDayId: id, cutoffRevision: { lte: revision } }, orderBy: [{ cycle: "asc" }, { receivedAt: "asc" }] });
  const openings = await tx.cashDayOpening.findMany({ where: { tenantId, cashDayId: id }, orderBy: { receivedAt: "asc" } });
  const visibleOpeningKeys = new Set(facts.filter(f => f.kind === "OPENING").map(f => f.sourceRef));
  const cycle = facts.filter(f => f.kind === "REOPEN").length;
  const projection = projectCashDay({ fond: day.canonicalSession.openingFloatXpf, revision, cycle, facts, closures });
  return { id, businessDay: day.businessDay, sessionId: day.currentSessionId, revision, serverRevision: day.revision,
    data: rows.slice(0, 200), hasMore: rows.length > 200, nextCursor: rows.length > 200 ? String(rows[199].sequence) : null,
    closures, openings: openings.filter((o: { sourceKey: string }) => visibleOpeningKeys.has(o.sourceKey)), projection: { ...projection,
      fondsNonRetenus: openings.filter((o: { sourceKey: string; openingFloatXpf: bigint }) => visibleOpeningKeys.has(o.sourceKey) && o.openingFloatXpf !== day.canonicalSession.openingFloatXpf) } };
}
export async function attachLegacy(tx: CashTx, id: string, b: ActionInput) {
  const day = await lockDay(tx, b.tenantId, id);
  const sessions = b.sessionIds ?? [], origins = b.origins ?? [], localVoids = b.localVoids ?? [];
  requireCash(Array.isArray(sessions) && Array.isArray(origins) && Array.isArray(localVoids));
  requireCash(sessions.length + origins.length + localVoids.length <= 200, "BATCH_TOO_LARGE", 413);
  requireCash(Number.isSafeInteger(b.cycle) && Number(b.cycle) >= 0 && Number(b.cycle) <= day.cycle);
  for (const value of sessions) {
    const sessionId = uuid(value);
    const s = await tx.cashSession.findFirst({ where: { tenantId: b.tenantId, id: sessionId } });
    requireCash(s, "NOT_FOUND", 404);
    requireCash(businessDay(s.openedAt) === day.businessDay, "DAY_MISMATCH", 409);
    const alias = await tx.cashDaySession.findUnique({ where: { tenantId_sessionId: { tenantId: b.tenantId, sessionId } } });
    requireCash(!alias || alias.cashDayId === id, "DAY_MISMATCH", 409);
    if (!alias) await tx.cashDaySession.create({ data: { tenantId: b.tenantId, cashDayId: id, sessionId, cycle: Number(b.cycle) } });
  }
  const saleIds: string[] = [];
  for (const value of origins) {
    const origin = object(value), sourceType = text(origin.sourceType), sourceId = text(origin.sourceId, 300);
    const sale = await tx.sale.findFirst({ where: { tenantId: b.tenantId, sourceType, sourceId } });
    requireCash(sale, "NOT_FOUND", 404);
    requireCash(businessDay(sale.paidAt ?? sale.createdAt) === day.businessDay && (!sale.cashDayId || sale.cashDayId === id), "DAY_MISMATCH", 409);
    await tx.sale.update({ where: { id: sale.id }, data: { cashDayId: id, sessionId: day.canonicalSessionId } });
    await recordSharedSale(tx, b.tenantId, sale.id);
    // Les avoirs confirmés ont leur propre clé : un complément ne change pas la vente.
    const refunds = await tx.partialRefund.findMany({ where: { tenantId: b.tenantId, saleId: sale.id, status: "DONE" } });
    for (const refund of refunds) {
      const input = object(refund.input), plan = object(refund.plan);
      if (input.refundMethod !== "CASH") continue;
      // Avoir rendu un AUTRE jour : il sort d'un autre tiroir, il n'entre pas dans ce Z (et ne bloque pas l'import).
      if (refund.cashDayId && refund.cashDayId !== id) continue;
      const occurredAt = input.occurredAt ? date(input.occurredAt) : refund.createdAt;
      if (businessDay(occurredAt) !== day.businessDay) continue;
      await appendDayFact(tx, b.tenantId, id, { kind: "PARTIAL_REFUND_DONE", sourceRef: refund.actionId,
        refundActionId: refund.id, deviceId: refund.deviceId ?? sale.deviceId ?? "legacy", occurredAt,
        snapshot: { payments: [{ method: "CASH", amountXpf: String(xpfInteger(String(plan.amountXpf))) }],
          parTaux: (plan.parTaux as unknown[]).map(v => { const t = object(v); return { tgcRatePpm: t.tgcRatePpm,
            htXpf: String(t.htXpf), tgcXpf: String(t.tgcXpf), ttcXpf: String(t.ttcXpf) }; }) } });
    }
    saleIds.push(sale.id);
  }
  for (const value of localVoids) {
    const v = object(value); const occurredAt = date(v.occurredAt);
    requireCash(businessDay(occurredAt) === day.businessDay, "DAY_MISMATCH", 409);
    await appendDayFact(tx, b.tenantId, id, { kind: "LOCAL_VOID", sourceRef: text(v.sourceKey, 300), deviceId: text(v.deviceId, 120),
      occurredAt, snapshot: { ...v, saleRef: text(v.sourceKey, 300) } });
  }
  return { ...(await dayState(tx, b.tenantId, id)), saleIds };
}
