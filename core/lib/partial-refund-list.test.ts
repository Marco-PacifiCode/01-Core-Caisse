import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { listRefunds, parseRefundRange, type RefundRange, type RefundRow } from "./partial-refund-list.ts";

const row = (o: Partial<RefundRow> & { actionId: string }, done?: string): RefundRow => ({ saleId: "sale", status: "DONE",
  input: { actionId: o.actionId, reason: "Retour", refundMethod: "CASH", cashDrawer: "EXTERNAL", lines: [{ lineId: "l1", qty: 1 }] },
  plan: { amountXpf: 101, parTaux: [{ tgcRatePpm: 50_000, htXpf: 96, tgcXpf: 5, ttcXpf: 101 }], lines: [] },
  outcome: done ? { ok: true, doneAt: done, saleChanged: true } : { ok: true }, creditNoteId: "cn", sessionId: null,
  createdAt: new Date("2026-09-01T00:00:00Z"), ...o });

test("plage: requis, invalide, inversée, > 92 jours → erreur; marge SQL de 2 jours", () => {
  for (const [f, t] of [[null, "2026-10-01"], ["x", "2026-10-01"], ["2026-10-01", "2026-09-01"], ["2026-01-01", "2026-04-04"]]) assert.ok("error" in parseRefundRange(f, t));
  const r = parseRefundRange("2026-09-01T00:00:00Z", "2026-12-02T00:00:00Z"); assert.ok(!("error" in r));
  assert.equal(r.sqlFrom.toISOString(), "2026-08-30T00:00:00.000Z");
});
test("bornes [from, to[ sur doneAt (repli createdAt), tri, PENDING exclu, format", () => {
  const range = parseRefundRange("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z") as RefundRange;
  const out = listRefunds([
    row({ actionId: "b" }, "2026-09-01T12:00:00.000Z"),
    row({ actionId: "a" }),                                   // createdAt = from → inclus
    row({ actionId: "c" }, "2026-09-02T00:00:00.000Z"),         // = to → exclu
    row({ actionId: "d", createdAt: new Date("2026-08-31T00:00:00Z") }, "2026-09-01T01:00:00.000Z"), // créé avant, confirmé dedans
    row({ actionId: "e", status: "PENDING" }),
  ], range);
  assert.deepEqual(out.map(e => e.actionId), ["a", "d", "b"]);
  assert.deepEqual(out[2], { actionId: "b", saleId: "sale", refundMethod: "CASH", cashDrawer: "EXTERNAL", amountXpf: 101, creditNoteId: "cn",
    reason: "Retour", lines: [{ lineId: "l1", qty: 1 }], parTaux: [{ tgcRatePpm: 50_000, htXpf: 96, tgcXpf: 5, ttcXpf: 101 }],
    saleChanged: true, doneAt: "2026-09-01T12:00:00.000Z", sessionId: null });
  assert.equal(out[0].doneAt, "2026-09-01T00:00:00.000Z"); assert.equal(out[0].saleChanged, undefined);
});
test("route: clé de service, tenant isolé (withTenant + where tenantId), DONE, fenêtre SQL, 400", () => {
  const src = readFileSync(new URL("../app/api/partial-refunds/route.ts", import.meta.url), "utf8");
  assert.match(src, /if \(!hasServiceKey\(req\)\)[^\n]*401/);
  assert.match(src, /withTenant\(tenantId,/); assert.match(src, /where: \{ tenantId, status: "DONE", createdAt: \{ gte: range.sqlFrom, lt: range.to \} \}/);
  assert.match(src, /"error" in range\)[^\n]*status: 400/); assert.match(src, /tenantId requis/);
});
