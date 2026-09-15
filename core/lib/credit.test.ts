// Tests de lib/credit.ts — décisions PURES de la vente à crédit (échéancier, lot A, 2026-09-15),
// sans DB ni réseau (même patron que caisse.test.ts pour lib/money.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutUnderpaidGuard, dueAtNoonUtcIso, parseDueAt } from "./credit.ts";

// ─── parseDueAt / dueAtNoonUtcIso ─────────────────────────────────────────────

test("parseDueAt — format valide, ancré à midi UTC (piège +11)", () => {
  const d = parseDueAt("2026-10-01");
  assert.ok(d);
  assert.equal(d!.toISOString(), "2026-10-01T12:00:00.000Z");
});

test("parseDueAt — jour calendaire inexistant refusé (Date.UTC ne doit pas normaliser en silence)", () => {
  assert.equal(parseDueAt("2026-02-30"), null);
});

test("parseDueAt — format invalide refusé", () => {
  assert.equal(parseDueAt("01/10/2026"), null);
  assert.equal(parseDueAt("2026-10-1"), null);
  assert.equal(parseDueAt(""), null);
});

test("dueAtNoonUtcIso — ISO à midi UTC, jamais de décalage de jour", () => {
  assert.equal(dueAtNoonUtcIso("2026-10-01"), "2026-10-01T12:00:00.000Z");
});

test("dueAtNoonUtcIso — invalide → null", () => {
  assert.equal(dueAtNoonUtcIso("n'importe quoi"), null);
});

// ─── checkoutUnderpaidGuard ────────────────────────────────────────────────────

test("SANS credit : sous-payé → UNDERPAID (comportement inchangé)", () => {
  const r = checkoutUnderpaidGuard(10_000n, 2_000n, undefined);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "UNDERPAID");
  assert.equal(r.totalXpf, 10_000n);
  assert.equal(r.paidXpf, 2_000n);
});

test("SANS credit : payé pile → accepté", () => {
  assert.deepEqual(checkoutUnderpaidGuard(10_000n, 10_000n, undefined), { ok: true });
});

test("AVEC credit : 1er versement 0 < payé < total → accepté", () => {
  assert.deepEqual(checkoutUnderpaidGuard(10_000n, 2_000n, { dueAt: "2026-10-01" }), { ok: true });
});

test("AVEC credit : payé >= total → CREDIT_NOT_NEEDED (rien à créditer)", () => {
  const r = checkoutUnderpaidGuard(10_000n, 10_000n, { dueAt: "2026-10-01" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "CREDIT_NOT_NEEDED");
});

test("AVEC credit : payé 0 → CREDIT_NEEDS_DEPOSIT (un crédit exige un 1er versement)", () => {
  const r = checkoutUnderpaidGuard(10_000n, 0n, { dueAt: "2026-10-01" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "CREDIT_NEEDS_DEPOSIT");
});
