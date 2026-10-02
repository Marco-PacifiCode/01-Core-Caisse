// Liste des avoirs partiels DONE par période (date de confirmation, repli createdAt pour les anciens).
import type { RefundInput, RefundPlan, RefundSuccess } from "./partial-refund.ts";

export const MAX_RANGE_DAYS = 92;
const DAY = 86_400_000;
export type RefundRange = { from: Date; to: Date; sqlFrom: Date };
export function parseRefundRange(from: string | null, to: string | null): RefundRange | { error: string } {
  if (!from || !to) return { error: "from et to requis (ISO)" };
  const f = new Date(from), t = new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return { error: "from/to invalides" };
  if (t <= f) return { error: "to doit être après from" };
  if (t.getTime() - f.getTime() > MAX_RANGE_DAYS * DAY) return { error: `période max ${MAX_RANGE_DAYS} jours` };
  // doneAt ≥ createdAt; marge de 2 jours pour une confirmation tardive d'une réservation antérieure.
  return { from: f, to: t, sqlFrom: new Date(f.getTime() - 2 * DAY) };
}
export type RefundRow = { actionId: string; saleId: string; status: string; input: unknown; plan: unknown; outcome: unknown;
  creditNoteId: string | null; sessionId: string | null; createdAt: Date };
export type RefundListEntry = { actionId: string; saleId: string; refundMethod: RefundInput["refundMethod"]; cashDrawer?: "EXTERNAL";
  amountXpf: number; creditNoteId: string | null; reason: string; lines: { lineId: string; qty: number }[];
  parTaux: RefundPlan["parTaux"]; saleChanged?: true; doneAt: string; sessionId: string | null };
export function listRefunds(rows: RefundRow[], range: RefundRange): RefundListEntry[] {
  return rows.filter(r => r.status === "DONE").map(r => {
    const input = r.input as RefundInput, plan = r.plan as RefundPlan, outcome = (r.outcome ?? {}) as Partial<RefundSuccess>;
    const doneAt = outcome.doneAt ?? r.createdAt.toISOString();
    return { actionId: r.actionId, saleId: r.saleId, refundMethod: input.refundMethod,
      ...(input.cashDrawer ? { cashDrawer: input.cashDrawer } : {}), amountXpf: plan.amountXpf,
      creditNoteId: r.creditNoteId ?? outcome.creditNoteId ?? null, reason: input.reason,
      lines: input.lines.map(l => ({ lineId: l.lineId, qty: l.qty })), parTaux: plan.parTaux,
      ...(outcome.saleChanged ? { saleChanged: true as const } : {}), doneAt, sessionId: r.sessionId };
  }).filter(e => { const d = new Date(e.doneAt).getTime(); return d >= range.from.getTime() && d < range.to.getTime(); })
    .sort((a, b) => a.doneAt.localeCompare(b.doneAt) || a.actionId.localeCompare(b.actionId));
}
