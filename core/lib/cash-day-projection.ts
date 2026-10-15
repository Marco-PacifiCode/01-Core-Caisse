// Projection pure L4. Les montants JSON sont des chaînes XPF ; aucune lecture live de carte.
export type JsonRecord = { [key: string]: unknown };
export type DayFact = {
  sequence: bigint; kind: string; sourceRef: string; deviceId: string;
  occurredAt: Date; receivedAt: Date; cashDeltaXpf: bigint; snapshot: unknown;
};
export type DayClosure = {
  id: string; cycle: number; authoritative: boolean; countedXpf: bigint;
  baselineExpectedXpf: bigint; cutoffRevision: bigint; closureMode: string;
  occurredAt: Date; receivedAt: Date; actorName: string; legacySnapshot: unknown;
};
export class CashContractError extends Error {
  readonly status: number;
  readonly data: unknown;
  constructor(code: string, status = 400, data?: unknown) { super(code); this.status = status; this.data = data; }
}
export function requireCash(condition: unknown, code = "INVALID_PAYLOAD", status = 400): asserts condition {
  if (!condition) throw new CashContractError(code, status);
}
export function object(value: unknown): JsonRecord {
  requireCash(!!value && typeof value === "object" && !Array.isArray(value));
  return value as JsonRecord;
}
export function xpfInteger(value: unknown, signed = false): bigint {
  requireCash(typeof value === "string" && (signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value));
  const n = BigInt(value);
  requireCash(n >= -9223372036854775808n && n <= 9223372036854775807n);
  return n;
}
export function safeXpf(value: bigint): number {
  const n = Number(value); requireCash(Number.isSafeInteger(n), "UNSAFE_LEGACY_AMOUNT"); return n;
}
export function businessDay(at: Date): string {
  requireCash(Number.isFinite(at.getTime()));
  return new Date(at.getTime() + 11 * 3600000).toISOString().slice(0, 10);
}
export function validDay(value: unknown): string {
  requireCash(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  return value;
}
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function jsonValue(value: unknown): unknown { return JSON.parse(canonical(value)); }
export type FrozenLine = { lineXpf: string; tgcRatePpm?: number | null; [key: string]: unknown };
export function taxes(lines: readonly FrozenLine[]) {
  const groups = new Map<number, bigint>();
  for (const l of lines) {
    const rate = l.tgcRatePpm ?? 0;
    requireCash(Number.isInteger(rate) && rate >= 0 && rate <= 1000000);
    groups.set(rate, (groups.get(rate) ?? 0n) + xpfInteger(l.lineXpf, true));
  }
  return [...groups].sort(([a], [b]) => a - b).map(([tgcRatePpm, ttcXpf]) => {
    requireCash(ttcXpf >= 0n);
    const divisor = 1000000n + BigInt(tgcRatePpm);
    const tgcXpf = (ttcXpf * BigInt(tgcRatePpm) + divisor / 2n) / divisor;
    return { tgcRatePpm, ttcXpf: String(ttcXpf), htXpf: String(ttcXpf - tgcXpf), tgcXpf: String(tgcXpf) };
  });
}
export function paymentParts(raw: unknown) {
  requireCash(Array.isArray(raw));
  const byMethod: Record<string, bigint> = {};
  for (const item of raw) {
    const p = object(item);
    requireCash(typeof p.method === "string" && ["CASH", "CARD", "TRANSFER", "CHEQUE", "OTHER"].includes(p.method));
    byMethod[p.method] = (byMethod[p.method] ?? 0n) + xpfInteger(p.amountXpf);
  }
  return byMethod;
}
/** Vérifie snapshot/delta, également employé AVANT toute insertion du ledger. */
export function factDelta(kind: string, snapshot: unknown): bigint {
  const s = object(snapshot);
  if (kind === "SALE_PAID") {
    requireCash(Array.isArray(s.lines));
    const lines = s.lines as FrozenLine[];
    const total = xpfInteger(s.totalXpf);
    requireCash(lines.reduce((n, l) => n + xpfInteger(l.lineXpf, true), 0n) === total);
    const parts = paymentParts(s.payments);
    requireCash(Object.values(parts).reduce((n, p) => n + p, 0n) === total);
    requireCash(canonical(s.parTaux) === canonical(taxes(lines)));
    return parts.CASH ?? 0n;
  }
  if (kind === "PARTIAL_REFUND_DONE") return -(paymentParts(s.payments).CASH ?? 0n);
  if (kind === "MOVEMENT") {
    requireCash(["CASH_IN", "CASH_OUT", "REFUND"].includes(String(s.kind)));
    // Les avoirs EXTERNAL figurent seulement dans PARTIAL_REFUND_DONE.
    requireCash(s.refundActionId === undefined);
    return xpfInteger(s.amountXpf) * (s.kind === "CASH_IN" ? 1n : -1n);
  }
  requireCash(["SALE_VOID", "LOCAL_VOID", "GIFT_CARD_REDEEMED", "REOPEN", "OPENING", "CLOSURE"].includes(kind));
  return 0n;
}
function totals(facts: DayFact[], fond: bigint) {
  const voided = new Set(facts.filter(f => f.kind === "SALE_VOID" || f.kind === "LOCAL_VOID").map(f => String(object(f.snapshot).saleRef ?? f.sourceRef)));
  const byMethod: Record<string, bigint> = {};
  const parTaux: Record<string, { ttcXpf: bigint; htXpf: bigint; tgcXpf: bigint }> = {};
  let cash = 0n, refunds = 0n, movements = 0n, totalSales = 0n, gift = 0n, giftCount = 0;
  for (const f of facts) {
    requireCash(factDelta(f.kind, f.snapshot) === f.cashDeltaXpf, "CORRUPT_CASH_FACT", 409);
    const s = object(f.snapshot);
    if (f.kind === "SALE_PAID" && !voided.has(f.sourceRef)) {
      const parts = paymentParts(s.payments);
      for (const [k, n] of Object.entries(parts)) byMethod[k] = (byMethod[k] ?? 0n) + n;
      cash += parts.CASH ?? 0n;
      totalSales += xpfInteger(s.totalXpf);
      for (const t of taxes(s.lines as FrozenLine[])) {
        const row = parTaux[t.tgcRatePpm] ??= { ttcXpf: 0n, htXpf: 0n, tgcXpf: 0n };
        row.ttcXpf += BigInt(t.ttcXpf); row.htXpf += BigInt(t.htXpf); row.tgcXpf += BigInt(t.tgcXpf);
      }
    }
    if (f.kind === "PARTIAL_REFUND_DONE") refunds -= f.cashDeltaXpf;
    if (f.kind === "MOVEMENT") movements += f.cashDeltaXpf;
    if (f.kind === "GIFT_CARD_REDEEMED") { gift += xpfInteger(s.amountXpf); giftCount++; }
  }
  return { cashXpf: cash, refundCashXpf: refunds, movementNetXpf: movements, expectedXpf: fond + cash - refunds + movements,
    totalSalesXpf: totalSales, byMethod, parTaux, cancelledCount: voided.size, giftCardRedeemedCount: giftCount, giftCardRedeemedXpf: gift };
}
export function projectCashDay(input: {
  fond: bigint; revision: bigint; cycle: number; facts: readonly DayFact[]; closures: readonly DayClosure[];
}) {
  const dedup = new Map<string, DayFact>();
  for (const f of [...input.facts].sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0)) {
    if (f.sequence > input.revision) continue;
    const key = `${f.kind}:${f.sourceRef}`, prior = dedup.get(key);
    requireCash(!prior || canonical(prior.snapshot) === canonical(f.snapshot), "SOURCE_CONFLICT", 409);
    if (!prior) dedup.set(key, f);
  }
  const facts = [...dedup.values()];
  const closures = input.closures.filter(c => c.cutoffRevision <= input.revision);
  const closure = closures.find(c => c.cycle === input.cycle && c.authoritative);
  const current = totals(facts, input.fond);
  const known = closure && closure.closureMode !== "ONLINE" ? object(closure.legacySnapshot ?? {}).knownSourceRefs : null;
  const knownSet = Array.isArray(known) ? new Set(known) : null;
  const atCutoff = closure ? facts.filter(f => f.sequence <= closure.cutoffRevision && (!knownSet || knownSet.has(`${f.kind}:${f.sourceRef}`))) : facts;
  const baseline = closure?.baselineExpectedXpf ?? current.expectedXpf;
  const late = closure ? facts.filter(f => f.sequence > closure.cutoffRevision || !!knownSet && !knownSet.has(`${f.kind}:${f.sourceRef}`))
    .filter(f => !["OPENING", "REOPEN", "CLOSURE"].includes(f.kind)) : [];
  const last = late.reduce<Date | null>((d, f) => !d || f.receivedAt > d ? f.receivedAt : d, null);
  const ecartCloture = closure ? closure.countedXpf - baseline : null;
  const regularisation = current.expectedXpf - baseline;
  return { revision: input.revision, fond: input.fond, compte: closure?.countedXpf ?? null,
    clotureLe: closure?.occurredAt ?? null, cloturePar: closure?.actorName ?? null,
    totauxCloture: totals(atCutoff, input.fond), totauxCourants: current, ecartCloture, regularisation,
    ecartZ: ecartCloture === null ? null : ecartCloture - regularisation, regulariseLe: last,
    remonteesApresCloture: late, recomptages: closures.filter(c => c !== closure),
    reouvertures: facts.filter(f => f.kind === "REOPEN") };
}
