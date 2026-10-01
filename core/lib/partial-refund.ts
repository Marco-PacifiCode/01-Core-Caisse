// XPF: prorata cumulatif tronqué (BigInt). La dernière quantité solde le TTC exact.
// Remises négatives: allocation proportionnelle par taux, ordre stable par id.
import type { CreditNoteInput, CreditNoteResult, InvoiceDetail } from "./clients";

export type RefundInput = {
  actionId: string; reason: string;
  lines: { lineId: string; qty: number }[];
  refundMethod: "CASH" | "CARD" | "TRANSFER" | "OTHER";
  // Espèces rendues par un tiroir hors session Core (Z importé déjà net des remboursements).
  cashDrawer?: "EXTERNAL";
  createdBy?: string; createdByName?: string;
};
export type RefundSale = {
  id: string; status: string; invoiceId: string | null; totalXpf: bigint;
  voidPreparedAt?: Date | null;
  lines: { id: string; label: string; qty: number; unitXpf: bigint; lineXpf: bigint; tgcRatePpm: number | null }[];
};
export type RefundLine = { lineId: string; qty: number; ttcXpf: number; tgcRatePpm: number };
export type RefundPlan = {
  invoiceId: string; lines: RefundLine[]; amountXpf: number;
  parTaux: { tgcRatePpm: number; htXpf: number; tgcXpf: number; ttcXpf: number }[];
  lineIds?: string[]; fullyRefunded: boolean;
};
export type RefundFailure = { ok: false; error: string; status?: number };
export type RefundSuccess = { ok: true; creditNoteId: string; actionId: string; refundMethod: RefundInput["refundMethod"]; cashDrawer?: "EXTERNAL"; plan: RefundPlan };
export type RefundResult = RefundFailure | RefundSuccess;
export const refuse = (error: string, status = 409): RefundFailure => ({ ok: false, error, status });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validRefundInput(input: unknown): input is RefundInput {
  if (!input || typeof input !== "object") return false;
  const x = input as RefundInput;
  return typeof x.actionId === "string" && uuid.test(x.actionId)
    && typeof x.reason === "string" && x.reason.trim().length > 0 && x.reason.length <= 1000
    && ["CASH", "CARD", "TRANSFER", "OTHER"].includes(x.refundMethod)
    && (x.cashDrawer === undefined || x.cashDrawer === "EXTERNAL" && x.refundMethod === "CASH")
    && Array.isArray(x.lines) && x.lines.length > 0 && x.lines.length <= 1000
    && x.lines.every(l => l && typeof l.lineId === "string" && uuid.test(l.lineId) && Number.isSafeInteger(l.qty) && l.qty >= 1)
    && new Set(x.lines.map(l => l.lineId.toLowerCase())).size === x.lines.length
    && (x.createdBy === undefined || typeof x.createdBy === "string" && uuid.test(x.createdBy))
    && (x.createdByName === undefined || typeof x.createdByName === "string" && x.createdByName.length <= 200);
}
export function refundFingerprint(input: RefundInput): string {
  // PostgreSQL JSONB réordonne les clés: l'empreinte ne dépend jamais de leur ordre.
  return JSON.stringify({ actionId: input.actionId, reason: input.reason, refundMethod: input.refundMethod,
    createdBy: input.createdBy, createdByName: input.createdByName,
    ...(input.cashDrawer !== undefined ? { cashDrawer: input.cashDrawer } : {}),
    lines: [...input.lines].sort((a, b) => a.lineId.localeCompare(b.lineId)).map(l => ({ lineId: l.lineId, qty: l.qty })) });
}
const safe = (n: bigint) => n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER);
const ht = (ttc: bigint, rate: number) => (ttc * 1_000_000n + (1_000_000n + BigInt(rate)) / 2n) / (1_000_000n + BigInt(rate));

export function planPartialRefund(sale: RefundSale, invoice: InvoiceDetail, input: RefundInput, prior: RefundPlan[]): RefundPlan | RefundFailure {
  if (sale.status !== "PAID") return refuse("SALE_NOT_PAID");
  if (sale.voidPreparedAt) return refuse("VOID_IN_PROGRESS");
  if (!sale.invoiceId || invoice.id !== sale.invoiceId || invoice.sourceType !== "caisse" || invoice.sourceId !== sale.id) return refuse("INVOICE_MISMATCH");
  if (!Number.isSafeInteger(invoice.totalXpf) || BigInt(invoice.totalXpf) !== sale.totalXpf || !safe(sale.totalXpf)) return refuse("INVOICE_MISMATCH");
  if (!Number.isSafeInteger(invoice.paidXpf) || invoice.paidXpf < invoice.totalXpf) return refuse("INVOICE_NOT_PAID");
  const rateOf = (l: { tgcRatePpm: number | null }) => l.tgcRatePpm ?? invoice.tgcRatePpm ?? 0;
  if ([...sale.lines, ...invoice.lines].some(l => !Number.isInteger(rateOf(l)) || rateOf(l) < 0 || rateOf(l) > 1_000_000)) return refuse("INVALID_RATE");
  if (sale.lines.some(l => !Number.isSafeInteger(l.qty) || l.qty < 1) || sale.lines.reduce((s, l) => s + l.lineXpf, 0n) !== sale.totalXpf) return refuse("SALE_AMOUNT_MISMATCH");
  const signature = (l: { label: string; qty: number; unitXpf: bigint | number; tgcRatePpm: number | null }) => JSON.stringify([l.label, l.qty, String(l.unitXpf), rateOf(l)]);
  // Vérifie le multiensemble complet; aucune correspondance par position/libellé seul.
  const saleKeys = sale.lines.map(signature).sort();
  const invoiceKeys = invoice.lines.map(signature).sort();
  if (JSON.stringify(saleKeys) !== JSON.stringify(invoiceKeys)) return refuse("INVOICE_LINES_MISMATCH");
  const totals = new Map<string, bigint>();
  for (const rate of new Set(sale.lines.map(rateOf))) {
    const group = sale.lines.filter(l => rateOf(l) === rate);
    const positives = group.filter(l => l.lineXpf > 0n).sort((a, b) => a.id.localeCompare(b.id));
    const gross = positives.reduce((s, l) => s + l.lineXpf, 0n);
    const discount = -group.filter(l => l.lineXpf < 0n).reduce((s, l) => s + l.lineXpf, 0n);
    if (discount > gross) return refuse("NEGATIVE_RATE_GROUP");
    let cumulative = 0n, allocated = 0n;
    for (const l of positives) {
      cumulative += l.lineXpf;
      const next = discount * cumulative / gross;
      totals.set(l.id, l.lineXpf - (next - allocated));
      allocated = next;
    }
  }
  const used = new Map<string, { qty: number; ttc: bigint }>();
  for (const p of prior) for (const l of p.lines) {
    const old = used.get(l.lineId) ?? { qty: 0, ttc: 0n };
    used.set(l.lineId, { qty: old.qty + l.qty, ttc: old.ttc + BigInt(l.ttcXpf) });
  }
  const lines: RefundLine[] = [];
  const mapped: string[] = [];
  let entire = !sale.lines.some(l => l.lineXpf < 0n);
  for (const requested of input.lines) {
    const l = sale.lines.find(l => l.id === requested.lineId);
    if (!l) return refuse("LINE_NOT_FOUND", 404);
    const total = totals.get(l.id);
    if (total === undefined || total <= 0n) return refuse("LINE_NOT_REFUNDABLE");
    const old = used.get(l.id) ?? { qty: 0, ttc: 0n };
    const qty = old.qty + requested.qty;
    if (qty > l.qty) return refuse("EXCEEDS_SOLD_QTY");
    const amount = total * BigInt(qty) / BigInt(l.qty) - old.ttc;
    if (!safe(amount) || amount <= 0n) return refuse("INVALID_REFUND_AMOUNT");
    lines.push({ lineId: l.id, qty: requested.qty, ttcXpf: Number(amount), tgcRatePpm: rateOf(l) });
    const matches = invoice.lines.filter(i => signature(i) === signature(l));
    if (old.qty !== 0 || requested.qty !== l.qty || matches.length !== 1 || total !== l.unitXpf * BigInt(l.qty)) entire = false;
    else mapped.push(matches[0].id);
  }
  const rates = new Set(invoice.lines.map(rateOf));
  if (!entire && rates.size !== 1) return refuse("PARTIAL_QTY_MULTI_RATE");
  const amount = lines.reduce((s, l) => s + BigInt(l.ttcXpf), 0n);
  const before = prior.reduce((s, p) => s + BigInt(p.amountXpf), 0n);
  if (!safe(amount) || before + amount > sale.totalXpf) return refuse("EXCEEDS_SALE_TOTAL");
  const parTaux = [...new Set(lines.map(l => l.tgcRatePpm))].sort((a, b) => a - b).map(rate => {
    const ttc = lines.filter(l => l.tgcRatePpm === rate).reduce((s, l) => s + BigInt(l.ttcXpf), 0n);
    const base = ht(ttc, rate);
    return { tgcRatePpm: rate, htXpf: Number(base), tgcXpf: Number(ttc - base), ttcXpf: Number(ttc) };
  });
  const fullyRefunded = sale.lines.filter(l => (totals.get(l.id) ?? 0n) > 0n).every(l =>
    (used.get(l.id)?.qty ?? 0) + (input.lines.find(r => r.lineId === l.id)?.qty ?? 0) === l.qty);
  return { invoiceId: sale.invoiceId, lines, amountXpf: Number(amount), parTaux, ...(entire ? { lineIds: mapped } : {}), fullyRefunded };
}

export type RefundReservation = { input: RefundInput; plan: RefundPlan; outcome?: RefundSuccess };
export async function runPartialRefund(deps: {
  tenantId: string; saleId: string;
  prepare(): Promise<RefundReservation | RefundFailure>;
  creditNote(input: CreditNoteInput): Promise<CreditNoteResult>;
  finalize(reservation: RefundReservation, creditNoteId: string): Promise<RefundResult>;
}): Promise<RefundResult> {
  const r = await deps.prepare();
  if ("ok" in r) return r;
  if (r.outcome) return r.outcome;
  let credit: CreditNoteResult;
  try {
    credit = await deps.creditNote({ tenantId: deps.tenantId, invoiceId: r.plan.invoiceId, reason: r.input.reason,
      creditKey: `caisse:${deps.saleId}:${r.input.actionId}`,
      ...(r.plan.lineIds ? { lineIds: r.plan.lineIds } : { amountXpf: r.plan.amountXpf }) });
  } catch (err) {
    const e = err as { status?: number; detail?: string };
    let error = "CREDIT_NOTE_FAILED";
    try { error = JSON.parse(e.detail ?? "{}").error ?? error; } catch { /* réponse non JSON */ }
    return refuse(error, e.status === 409 || e.status === 404 ? e.status : 502);
  }
  if (!Number.isSafeInteger(credit.totalXpf) || -credit.totalXpf !== r.plan.amountXpf) return refuse("CREDIT_NOTE_AMOUNT_MISMATCH", 502);
  return deps.finalize(r, credit.creditNoteId);
}
