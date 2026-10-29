import type { Prisma } from "@prisma/client";
import { closeSessionTx, openSessionTx, type ZReport } from "./caisse";
import { appendDayFact, lockDay, readFacts, recordSharedSale } from "./cash-day-ledger";
import { date, findHistoricalSource, receivedActionInput, lockCashTenant, normalizeActionId, normalizeActionInput, recordCashConflict, CashConflictAfterRollback, text, uuid, type ActionInput, type CashTx } from "./caisse-sync";
import { businessDay, canonical, CashContractError, jsonValue, object, projectCashDay, requireCash, safeXpf, validDay, xpfInteger, type DayClosure } from "./cash-day-projection";
import { lockSaleRow } from "./sale-lock";
import { assertNoLegacyOperationInProgress } from "./cash-day-guard";

export function sourceAuthor(b: ActionInput) {
  const receivedById = uuid(b.receivedById);
  requireCash(b.importMode === true || !!b.actorId);
  return { actorId: b.actorId == null ? null : uuid(b.actorId), actorName: b.actorId == null ? "auteur non enregistré" : text(b.actorName), receivedById };
}
type CashDayReport = ZReport & {
  parTaux?: Record<string, { ttcXpf: number; htXpf: number; tgcXpf: number }>;
  cancelledCount?: number;
  refundCashXpf?: number;
  movementNetXpf?: number;
};
function dayOf(b: ActionInput) {
  const day = validDay(b.businessDay);
  requireCash(businessDay(date(b.occurredAt)) === day, "DAY_MISMATCH", 409);
  requireCash(b.scope === undefined || b.scope === "rotisserie-caisse");
  return day;
}
export async function openCashDay(tx: CashTx, b: ActionInput) {
  b = normalizeActionInput(b);
  await lockCashTenant(tx, b.tenantId);
  await assertNoLegacyOperationInProgress(tx, b.tenantId);
  const business = dayOf(b), tenantId = b.tenantId, author = sourceAuthor(b);
  const sourceKey = normalizeActionId(text(b.sourceKey, 300)), localSessionKey = normalizeActionId(text(b.localSessionKey, 300));
  const openingFloatXpf = xpfInteger(b.openingFloatXpf);
  const deviceName = text(b.deviceName), occurredAt = date(b.occurredAt);
  const toCloseEnabled = (await tx.cashSettings.findUnique({ where: { tenantId } }))?.toCloseEnabled === true;
  const serverDay = businessDay(new Date());
  if (toCloseEnabled) requireCash(occurredAt.getTime() <= Date.now() + 60_000, "FUTURE_DATE", 409);
  let day = await tx.cashDay.findUnique({ where: { tenantId_scope_businessDay: { tenantId, scope: "rotisserie-caisse", businessDay: business } } });
  const conflicts: Array<{ actionName: string; tenantId: string; scope: string; businessDay: string; code: string }> = [];
  if (!day) {
    if (toCloseEnabled && business < serverDay) {
      const ageDays = (Date.parse(`${serverDay}T00:00:00Z`) - Date.parse(`${business}T00:00:00Z`)) / 86_400_000;
      if (ageDays > 7) throw new CashConflictAfterRollback("OUVERTURE_TROP_ANCIENNE", {
        actionName: `${tenantId}:rotisserie-caisse:${business}:OUVERTURE_TROP_ANCIENNE`, tenantId, scope: "rotisserie-caisse", businessDay: business,
      });
      const session = await tx.cashSession.create({ data: { tenantId, openedBy: author.actorId ?? author.receivedById,
        openedByName: author.actorName, openingFloatXpf, openedAt: occurredAt, posteId: null, status: "TO_CLOSE" } });
      day = await tx.cashDay.create({ data: { tenantId, businessDay: business, canonicalSessionId: session.id, currentSessionId: session.id } });
      await tx.cashDaySession.create({ data: { tenantId, cashDayId: day.id, sessionId: session.id, cycle: 0 } });
      await appendDayFact(tx, tenantId, day.id, { kind: "TO_CLOSE", sourceRef: session.id, deviceId: "core", occurredAt,
        snapshot: { sessionId: session.id } });
      conflicts.push({ actionName: `${day.id}to-close`, tenantId, scope: "rotisserie-caisse", businessDay: business,
        code: "OUVERTURE_TARDIVE" });
    } else {
      if (toCloseEnabled) {
        const open = await tx.cashSession.findFirst({ where: { tenantId, status: "OPEN", posteId: null }, orderBy: { openedAt: "desc" } });
        if (open) {
          const alias = await tx.cashDaySession.findUnique({ where: { tenantId_sessionId: { tenantId, sessionId: open.id } } });
          if (alias) {
            const previousDay = await lockDay(tx, tenantId, alias.cashDayId);
            const reread = await tx.cashSession.findFirst({ where: { tenantId, id: open.id, status: "OPEN", posteId: null } });
            if (reread && previousDay.currentSessionId === reread.id && previousDay.businessDay < serverDay && previousDay.businessDay < business) {
              const changed = await tx.cashSession.updateMany({ where: { tenantId, id: reread.id, status: "OPEN" }, data: { status: "TO_CLOSE" } });
              requireCash(changed.count === 1, "PREVIOUS_SESSION_OPEN", 409);
              await appendDayFact(tx, tenantId, previousDay.id, { kind: "TO_CLOSE", sourceRef: reread.id, deviceId: "core", occurredAt,
                snapshot: { sessionId: reread.id } });
              conflicts.push({ actionName: `${previousDay.id}to-close`, tenantId, scope: previousDay.scope,
                businessDay: previousDay.businessDay, code: "PREVIOUS_SESSION_OPEN" });
            }
          }
        }
      }
      const native = await openSessionTx(tx, tenantId, { openedBy: author.actorId ?? author.receivedById,
        openedByName: author.actorName, openingFloatXpf, occurredAt });
      const session = native.ok ? native.session : await tx.cashSession.findFirst({ where: { tenantId, id: native.sessionId } });
      if (!session || businessDay(session.openedAt) !== business) throw new CashContractError("PREVIOUS_SESSION_OPEN", 409, native);
      day = await tx.cashDay.create({ data: { tenantId, businessDay: business, canonicalSessionId: session.id, currentSessionId: session.id } });
      await tx.cashDaySession.create({ data: { tenantId, cashDayId: day.id, sessionId: session.id, cycle: 0 } });
    }
  }
  const locked = await lockDay(tx, tenantId, day.id);
  const prior = await tx.cashDayOpening.findFirst({ where: { tenantId, sourceKey: sourceKey } });
  if (prior) {
    requireCash(prior.cashDayId === day.id && prior.openingFloatXpf === openingFloatXpf && normalizeActionId(prior.localSessionKey) === localSessionKey,
      "SOURCE_CONFLICT", 409);
    requireCash(prior.deviceId === b.deviceId && prior.deviceName === deviceName && prior.actorId === author.actorId
      && prior.actorName === author.actorName && prior.occurredAt.getTime() === occurredAt.getTime(), "SOURCE_CONFLICT", 409);
  } else {
    await tx.cashDayOpening.create({ data: { tenantId, cashDayId: day.id, sourceKey, localSessionKey, deviceId: b.deviceId, deviceName,
      ...author, occurredAt, openingFloatXpf } });
    await appendDayFact(tx, tenantId, day.id, { kind: "OPENING", sourceRef: sourceKey, deviceId: b.deviceId,
      occurredAt, snapshot: { ...author, localSessionKey, openingFloatXpf, deviceName } });
  }
  for (const conflict of conflicts) await recordCashConflict(tx, conflict);
  return { ...(await dayState(tx, tenantId, day.id)), fondRetenu: String(locked.canonicalSession.openingFloatXpf),
    fondNonRetenu: openingFloatXpf !== locked.canonicalSession.openingFloatXpf };
}
export async function dayState(tx: CashTx, tenantId: string, id: string) {
  tenantId = uuid(tenantId); id = uuid(id);
  const day = await lockDay(tx, tenantId, id);
  return cashDayView(day);
}
function cashDayView(day: Prisma.CashDayGetPayload<{ include: { canonicalSession: true; currentSession: true } }>) {
  return { id: day.id, cashDayId: day.id, businessDay: day.businessDay, scope: day.scope, cycle: day.cycle,
    sessionId: day.currentSessionId, canonicalSessionId: day.canonicalSessionId, status: day.currentSession.status,
    revision: day.revision, fond: day.canonicalSession.openingFloatXpf, openedBy: day.currentSession.openedBy,
    openedByName: day.currentSession.openedByName, openedAt: day.currentSession.openedAt, closedBy: day.currentSession.closedBy,
    closedByName: day.currentSession.closedByName, closedAt: day.currentSession.closedAt,
    closedLate: day.currentSession.status === "CLOSED" && day.currentSession.closedAt !== null
      && businessDay(day.currentSession.closedAt) > day.businessDay };
}

function dayPage(q: URLSearchParams, fallback: number, max: number) {
  const raw = q.get("limit");
  requireCash(raw === null || /^[0-9]+$/.test(raw));
  const limit = raw === null ? fallback : Number(raw);
  requireCash(Number.isSafeInteger(limit) && limit >= 1 && limit <= max);
  return { limit, cursor: q.has("cursor") ? validDay(q.get("cursor")) : null };
}

export async function listCashDays(tx: CashTx, tenantId: string, q: URLSearchParams) {
  tenantId = uuid(tenantId);
  const { limit, cursor } = dayPage(q, 31, 100);
  const toCloseEnabled = (await tx.cashSettings.findUnique({ where: { tenantId } }))?.toCloseEnabled === true;
  // Index (tenantId, scope, businessDay), sans passer par dayState/lockDay.
  const rows = await tx.cashDay.findMany({
    where: { tenantId, scope: "rotisserie-caisse", ...(cursor ? { businessDay: { lt: cursor } } : {}) },
    orderBy: { businessDay: "desc" }, take: limit + 1,
    include: { canonicalSession: true, currentSession: true,
      ...(toCloseEnabled ? { closures: { where: { tenantId, authoritative: true }, orderBy: [{ cycle: "desc" }, { receivedAt: "desc" }], take: 1 } } : {}),
      events: { where: { tenantId, kind: "CLOSURE" }, orderBy: { sequence: "desc" }, take: 1 } },
  });
  const days = [];
  for (const day of rows.slice(0, limit)) {
    let closure = day.events[0]?.snapshot ?? null;
    if (toCloseEnabled) {
      const authoritative = day.closures?.[0];
      const event = authoritative ? await tx.cashDayEvent.findFirst({ where: { tenantId, cashDayId: day.id, kind: "CLOSURE", sourceRef: authoritative.sourceKey } }) : null;
      closure = event?.snapshot ?? null;
    }
    days.push({ ...cashDayView(day), closure });
  }
  return { days,
    nextCursor: rows.length > limit ? rows[limit - 1].businessDay : null };
}

export async function listLegacyCashDays(tx: CashTx, tenantId: string, q: URLSearchParams) {
  tenantId = uuid(tenantId);
  const { limit, cursor } = dayPage(q, 7, 31);
  const sessionWhere: Prisma.CashSessionWhereInput = { tenantId,
    canonicalDays: { none: { tenantId } }, currentDays: { none: { tenantId } }, dayAliases: { none: { tenantId } } };
  const saleWhere = { tenantId, cashDayId: null };
  // Bornes UTC du même jour métier UTC+11 que businessDay(), utilisables par les index temporels.
  const startOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 11 * 3600000);
  let since = cursor ? new Date(startOf(cursor).getTime() + 86400000) : null;
  const days = [];
  while (days.length <= limit) {
    const session = await tx.cashSession.findFirst({ where: { ...sessionWhere, ...(since ? { openedAt: { gte: since } } : {}) },
      orderBy: [{ openedAt: "asc" }, { id: "asc" }], select: { openedAt: true } });
    // Jour d'une vente = paidAt ?? createdAt, même règle que attachLegacy (sinon DAY_MISMATCH).
    const paid = await tx.sale.findFirst({ where: { ...saleWhere, paidAt: since ? { not: null, gte: since } : { not: null } },
      orderBy: [{ paidAt: "asc" }, { id: "asc" }], select: { paidAt: true } });
    const unpaid = await tx.sale.findFirst({ where: { ...saleWhere, paidAt: null, ...(since ? { createdAt: { gte: since } } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { createdAt: true } });
    const saleAt = [paid?.paidAt, unpaid?.createdAt].filter((at): at is Date => !!at).sort((x, y) => x.getTime() - y.getTime())[0];
    if (!session && !saleAt) break;
    const firstAt = !saleAt || session && session.openedAt <= saleAt ? session!.openedAt : saleAt;
    const business = businessDay(firstAt);
    if (days.length === limit) return { days, nextCursor: days[days.length - 1].businessDay };
    const gte = startOf(business), lt = new Date(gte.getTime() + 86400000);
    const sessions = await tx.cashSession.findMany({ where: { ...sessionWhere, openedAt: { gte, lt } },
      orderBy: [{ openedAt: "asc" }, { id: "asc" }], take: 201,
      select: { id: true, status: true, sourceType: true, sourceId: true, openedAt: true, closedAt: true,
        openingFloatXpf: true, closingCountedXpf: true, expectedXpf: true, varianceXpf: true } });
    const ofDay = { OR: [{ paidAt: { gte, lt } }, { paidAt: null, createdAt: { gte, lt } }] };
    const origins = (await tx.sale.findMany({ where: { ...saleWhere, ...ofDay,
      sourceType: { not: null, notIn: [""] }, sourceId: { not: null, notIn: [""] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, sourceType: true, sourceId: true, status: true, totalXpf: true, createdAt: true, paidAt: true } }))
      .sort((x, y) => (x.paidAt ?? x.createdAt).getTime() - (y.paidAt ?? y.createdAt).getTime() || x.id.localeCompare(y.id)).slice(0, 201);
    const salesWithoutSource = await tx.sale.count({ where: { ...saleWhere, AND: [ofDay,
      { OR: [{ sourceType: null }, { sourceId: null }, { sourceType: "" }, { sourceId: "" }] }] } });
    const day = await tx.cashDay.findUnique({ where: { tenantId_scope_businessDay: { tenantId, scope: "rotisserie-caisse", businessDay: business } }, select: { id: true } });
    // Plafond commun sessions + origines, avec un ordre stable entre les deux listes.
    const entries = [
      ...sessions.map(s => ({ kind: "session", id: s.id, at: s.openedAt })),
      ...origins.map(s => ({ kind: "origin", id: s.id, at: s.paidAt ?? s.createdAt })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
    const visible = new Set(entries.slice(0, 200).map(e => `${e.kind}:${e.id}`));
    days.push({ businessDay: business, cashDayId: day?.id ?? null,
      sessions: sessions.filter(s => visible.has(`session:${s.id}`)),
      origins: origins.filter(s => visible.has(`origin:${s.id}`)).map(({ id, ...s }) => ({ saleId: id, ...s })),
      salesWithoutSource, more: entries.length > 200 });
    since = lt;
  }
  return { days, nextCursor: null };
}

export async function listPendingLegacyClosures(tx: CashTx, tenantId: string, q: URLSearchParams) {
  tenantId = uuid(tenantId);
  const raw = q.get("limit");
  requireCash(raw === null || /^[0-9]+$/.test(raw));
  const limit = raw === null ? 100 : Number(raw);
  requireCash(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200);
  const cursor = q.has("cursor") ? uuid(q.get("cursor")) : null;
  let after: { closedAt: Date; id: string } | null = null;
  if (cursor) {
    const session = await tx.cashSession.findFirst({ where: { tenantId, id: cursor }, select: { id: true, closedAt: true } });
    requireCash(session?.closedAt, "INVALID_CURSOR");
    after = { closedAt: session.closedAt, id: session.id };
  }
  const pending: Array<{ cashDayId: string; businessDay: string; cycle: number; session: Record<string, unknown> }> = [];
  let scanAfter = after;
  while (pending.length <= limit) {
    const aliases = await tx.cashDaySession.findMany({ where: { tenantId,
      session: { tenantId, status: "CLOSED", closedAt: { not: null }, ...(scanAfter ? { OR: [
        { closedAt: { gt: scanAfter.closedAt } }, { AND: [{ closedAt: scanAfter.closedAt }, { id: { gt: scanAfter.id } }] },
      ] } : {}) }, cashDay: { tenantId } },
      orderBy: [{ session: { closedAt: "asc" } }, { sessionId: "asc" }], take: 201,
      include: { cashDay: { select: { id: true, businessDay: true, cycle: true } }, session: { select: {
        id: true, status: true, sourceType: true, sourceId: true, openedAt: true, closedAt: true,
        openingFloatXpf: true, closingCountedXpf: true, expectedXpf: true, varianceXpf: true,
      } } } });
    if (!aliases.length) break;
    for (const alias of aliases) {
      scanAfter = { closedAt: alias.session.closedAt!, id: alias.session.id };
      if (await tx.cashDayClosure.findFirst({ where: { tenantId, cashDayId: alias.cashDayId, legacySessionId: alias.sessionId } })) continue;
      pending.push({ cashDayId: alias.cashDay.id, businessDay: alias.cashDay.businessDay, cycle: alias.cashDay.cycle,
        session: { id: alias.session.id, status: alias.session.status, sourceType: alias.session.sourceType, sourceId: alias.session.sourceId,
          openedAt: alias.session.openedAt, closedAt: alias.session.closedAt, openingFloatXpf: alias.session.openingFloatXpf,
          closingCountedXpf: alias.session.closingCountedXpf, expectedXpf: alias.session.expectedXpf, varianceXpf: alias.session.varianceXpf } });
      if (pending.length > limit) break;
    }
    if (pending.length > limit || aliases.length < 201) break;
  }
  return { items: pending.slice(0, limit), nextCursor: pending.length > limit ? pending[limit - 1].session.id : null };
}
export async function closeCashDay(tx: CashTx, cashDayId: string, b: ActionInput) {
  cashDayId = uuid(cashDayId); b = normalizeActionInput(b);
  const day = await lockDay(tx, b.tenantId, cashDayId), author = sourceAuthor(b);
  const toCloseEnabled = (await tx.cashSettings.findUnique({ where: { tenantId: b.tenantId } }))?.toCloseEnabled === true;
  if (!toCloseEnabled) requireCash(!await tx.partialRefund.findFirst({ where: { tenantId: b.tenantId, cashDayId, status: "PENDING" } }), "REFUND_IN_PROGRESS", 409);
  const countedXpf = xpfInteger(b.countedXpf), occurredAt = date(b.occurredAt);
  // La clôture conserve son heure réelle ; le Z reste rattaché au CashDay d'origine.
  requireCash(businessDay(occurredAt) >= day.businessDay, "DAY_MISMATCH", 409);
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
  const previous = await tx.cashDayClosure.findFirst({ where: { tenantId: b.tenantId, sourceKey: sourceKey } });
  if (previous) {
    requireCash(previous.cashDayId === day.id && previous.countedXpf === countedXpf && previous.cycle === cycle
      && previous.localExpectedXpf === localExpectedXpf && previous.localVarianceXpf === localVarianceXpf
      && previous.closureMode === closureMode && previous.deviceId === b.deviceId && previous.deviceName === b.deviceName
      && previous.actorId === author.actorId && previous.actorName === author.actorName && previous.occurredAt.getTime() === occurredAt.getTime()
      && canonical(normalizeActionInput(previous.legacySnapshot)) === canonical(b.legacySnapshot ?? null), "SOURCE_CONFLICT", 409);
    const event = await tx.cashDayEvent.findFirst({ where: { tenantId: b.tenantId, cashDayId, kind: "CLOSURE", sourceRef: sourceKey } });
    return { id: previous.id, alreadyClosed: true, recount: !previous.authoritative, cutoffRevision: previous.cutoffRevision,
      report: event ? object(event.snapshot).report ?? null : null };
  }
  const first = await tx.cashDayClosure.findFirst({ where: { tenantId: b.tenantId, cashDayId, cycle, authoritative: true } });
  let legacySessionId: string | undefined;
  if (b.legacySessionId !== undefined) {
    legacySessionId = uuid(b.legacySessionId);
    const alias = await tx.cashDaySession.findUnique({ where: { tenantId_sessionId: { tenantId: b.tenantId, sessionId: legacySessionId } } });
    requireCash(alias?.cashDayId === day.id, "DAY_MISMATCH", 409);
  }
  const authoritative = !first && cycle === day.cycle;
  const facts = await readFacts(tx, b.tenantId, day.id, day.revision);
  const totals = projectCashDay({ fond: day.canonicalSession.openingFloatXpf, cycle, revision: day.revision, facts, closures: [] }).totauxCourants;
  const expected = totals.expectedXpf;
  let report: CashDayReport | null = null;
  if (authoritative) {
    // Le rapport natif utilise son contrat numérique historique : refus de conversion non sûre.
    safeXpf(countedXpf); safeXpf(expected);
    const native = await closeSessionTx(tx, b.tenantId, { sessionId: day.currentSessionId, closedBy: author.actorId ?? author.receivedById,
      closedByName: author.actorName, closingCountedXpf: countedXpf });
    requireCash(native.ok, "NOT_FOUND", 404);
    // Tous les montants couvrent le jour entier, y compris après une réouverture.
    report = { sessionId: day.currentSessionId, openingFloatXpf: safeXpf(day.canonicalSession.openingFloatXpf),
      cashSalesXpf: safeXpf(totals.cashXpf), totalSalesXpf: safeXpf(totals.totalSalesXpf), salesCount: totals.salesCount,
      byMethod: Object.fromEntries(Object.entries(totals.byMethod).map(([method, amount]) => [method, safeXpf(amount)])),
      refundsXpf: safeXpf(totals.refundsXpf), cashInXpf: safeXpf(totals.cashInXpf), cashOutXpf: safeXpf(totals.cashOutXpf),
      giftCardRedeemedCount: totals.giftCardRedeemedCount, giftCardRedeemedXpf: safeXpf(totals.giftCardRedeemedXpf),
      // SALE_PAID impose un paiement intégral dans le journal CashDay.
      creditXpf: 0, expectedXpf: safeXpf(expected), countedXpf: safeXpf(countedXpf), varianceXpf: safeXpf(countedXpf - expected) };
    if (toCloseEnabled) Object.assign(report, {
      parTaux: Object.fromEntries(Object.entries(totals.parTaux).sort(([a], [b]) => Number(a) - Number(b)).map(([rate, row]) => [Number(rate), {
        ttcXpf: safeXpf(row.ttcXpf), htXpf: safeXpf(row.htXpf), tgcXpf: safeXpf(row.tgcXpf),
      }])),
      cancelledCount: totals.cancelledCount, refundCashXpf: safeXpf(totals.refundCashXpf), movementNetXpf: safeXpf(totals.movementNetXpf),
    });
    // Heure d'origine seulement à la première clôture ; aucune pièce fermée n'est réécrite.
    if (!native.alreadyClosed) {
      const variance = countedXpf - expected;
      safeXpf(variance);
      await tx.cashSession.update({ where: { id: day.currentSessionId }, data: {
        closedAt: occurredAt, expectedXpf: expected, varianceXpf: variance,
      } });
    }
  }
  // Le rapport est figé dans le fait de clôture, à la même révision que son Z.
  const marker = await appendDayFact(tx, b.tenantId, day.id, { kind: "CLOSURE", sourceRef: sourceKey, deviceId: b.deviceId, occurredAt,
    snapshot: { cycle, countedXpf, ...author, report } });
  const closure = await tx.cashDayClosure.create({ data: { tenantId: b.tenantId, cashDayId, sourceKey, cycle, deviceId: b.deviceId,
    deviceName: text(b.deviceName), ...author, occurredAt, countedXpf, localExpectedXpf, localVarianceXpf,
    baselineExpectedXpf: closureMode === "ONLINE" ? expected : localExpectedXpf, closureMode, cutoffRevision: marker.sequence,
    authoritative, legacySessionId, ...(b.legacySnapshot === undefined ? {} : { legacySnapshot: jsonValue(b.legacySnapshot) as Prisma.InputJsonValue }) } });
  return { id: closure.id, closureId: closure.id, cashDayId, revision: marker.sequence, cutoffRevision: marker.sequence,
    alreadyClosed: !!first, recount: !authoritative, report };
}
export async function reopenCashDay(tx: CashTx, id: string, b: ActionInput) {
  id = uuid(id); b = normalizeActionInput(b);
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
  tenantId = uuid(tenantId); id = uuid(id);
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
  id = uuid(id); b = normalizeActionInput(b);
  await lockCashTenant(tx, b.tenantId);
  await assertNoLegacyOperationInProgress(tx, b.tenantId);
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
  // Inclut la canonique et tous les alias, même lors d'un nouvel import sans sessionIds.
  const aliases = await tx.cashDaySession.findMany({ where: { tenantId: b.tenantId, cashDayId: id } });
  const sessionIds = [...new Set([day.canonicalSessionId, ...aliases.map(alias => alias.sessionId)])];
  const movements = await tx.cashMovement.findMany({ where: { tenantId: b.tenantId, sessionId: { in: sessionIds } } });
  for (const movement of movements) {
    if (businessDay(movement.createdAt) !== day.businessDay) continue;
    // Les avoirs partiels ont leur propre fait financier.
    if (movement.ref?.startsWith("avoir-partiel:")) continue;
    await appendDayFact(tx, b.tenantId, id, { kind: "MOVEMENT", sourceRef: movement.id, deviceId: "legacy",
      occurredAt: movement.createdAt, snapshot: { kind: movement.kind, amountXpf: movement.amountXpf, reason: movement.reason } });
  }
  // Le tiroir suit le jour du rendu, même sans vente de ce jour dans origins. Rendu = confirmation
  // (outcome.doneAt) : un avoir réservé J puis confirmé J+1 sort du tiroir J+1, comme le compte la
  // tablette. Aucune borne sur createdAt : la réservation peut précéder la confirmation de plusieurs
  // semaines. Volume borné : après bascule, tout avoir porte un cashDayId (route CashDay).
  const candidates = await tx.partialRefund.findMany({ where: { tenantId: b.tenantId, status: "DONE",
    OR: [{ cashDayId: null }, { cashDayId: id }] } });
  // Un avoir déjà porté au journal d'un AUTRE jour (rejeu par la route CashDay) n'est jamais compté deux fois.
  const elsewhere = new Set((candidates.length ? await tx.cashDayEvent.findMany({ where: { tenantId: b.tenantId,
    kind: "PARTIAL_REFUND_DONE", refundActionId: { in: candidates.map(refund => refund.id) } } }) : [])
    .filter(event => event.cashDayId !== id).map(event => event.refundActionId));
  const refunds = candidates.filter(refund => {
    if (elsewhere.has(refund.id)) return false;
    if (refund.cashDayId === id) return true;
    const input = object(refund.input), doneAt = object(refund.outcome ?? {}).doneAt;
    return businessDay(typeof doneAt === "string" ? date(doneAt) : input.occurredAt ? date(input.occurredAt) : refund.createdAt) === day.businessDay;
  });
  const saleIds: string[] = [];
  for (const value of origins) {
    const origin = object(value);
    text(origin.sourceType); text(origin.sourceId, 300);
    const received = receivedActionInput(origin);
    const sale = await findHistoricalSource({ sourceType: text(received.sourceType), sourceId: text(received.sourceId, 300) },
      (sourceType, sourceId) => tx.sale.findFirst({ where: { tenantId: b.tenantId, sourceType, sourceId } }));
    requireCash(sale, "NOT_FOUND", 404);
    if (businessDay(sale.paidAt ?? sale.createdAt) !== day.businessDay) {
      // L'origine peut désigner la vente d'un avoir du jour ; la vente reste dans son Z d'origine.
      requireCash(refunds.some(refund => refund.saleId === sale.id), "DAY_MISMATCH", 409);
      continue;
    }
    requireCash(!sale.cashDayId || sale.cashDayId === id, "DAY_MISMATCH", 409);
    requireCash(await lockSaleRow(tx, sale.id, b.tenantId), "NOT_FOUND", 404);
    const currentSale = await tx.sale.findFirst({ where: { tenantId: b.tenantId, id: sale.id } });
    requireCash(currentSale && (!currentSale.cashDayId || currentSale.cashDayId === id), "DAY_MISMATCH", 409);
    await tx.sale.update({ where: { id: sale.id }, data: { cashDayId: id, sessionId: day.canonicalSessionId } });
    await recordSharedSale(tx, b.tenantId, sale.id);
    saleIds.push(sale.id);
  }
  // Même clé par avoir, qu'il soit découvert avec sa vente ou par l'import du jour de rendu.
  for (const refund of refunds) {
      const input = object(refund.input), plan = object(refund.plan), doneAt = object(refund.outcome ?? {}).doneAt;
      const occurredAt = typeof doneAt === "string" ? date(doneAt) : input.occurredAt ? date(input.occurredAt) : refund.createdAt;
      await appendDayFact(tx, b.tenantId, id, { kind: "PARTIAL_REFUND_DONE", sourceRef: refund.actionId,
        refundActionId: refund.id, deviceId: refund.deviceId ?? "legacy", occurredAt,
        snapshot: { payments: [{ method: input.refundMethod, amountXpf: String(xpfInteger(String(plan.amountXpf))) }],
          parTaux: (plan.parTaux as unknown[]).map(v => { const t = object(v); return { tgcRatePpm: t.tgcRatePpm,
            htXpf: String(t.htXpf), tgcXpf: String(t.tgcXpf), ttcXpf: String(t.ttcXpf) }; }) } });
  }
  for (const value of localVoids) {
    const v = object(value); const occurredAt = date(v.occurredAt);
    requireCash(businessDay(occurredAt) === day.businessDay, "DAY_MISMATCH", 409);
    await appendDayFact(tx, b.tenantId, id, { kind: "LOCAL_VOID", sourceRef: text(v.sourceKey, 300), deviceId: text(v.deviceId, 120),
      occurredAt, snapshot: { ...v, saleRef: text(v.sourceKey, 300) } });
  }
  return { ...(await dayState(tx, b.tenantId, id)), saleIds };
}
