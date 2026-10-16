import { test } from "node:test";
import assert from "node:assert/strict";
import { canChange, frozenLines } from "./cash-shared-policy.ts";
import { refundFingerprint, validRefundInput, type RefundInput } from "./partial-refund.ts";

test("claim durable : autre appareil refusé ; révision et états terminaux protégés", () => {
  const row = { status: "CLAIMED", revision: 2, claimedByDevice: "A" };
  assert.throws(() => canChange(row, { deviceId: "B", baseRevision: 2 }, true), /ALREADY_CLAIMED/);
  assert.throws(() => canChange(row, { deviceId: "A", baseRevision: 1 }, true), /REVISION_CONFLICT/);
  assert.doesNotThrow(() => canChange(row, { deviceId: "A", baseRevision: 2, status: "WAITING" }));
  assert.throws(() => canChange({ ...row, status: "CONSUMED" }, { deviceId: "A", baseRevision: 2 }), /TERMINAL_STATE/);
  assert.throws(() => canChange({ ...row, status: "DELETED" }, { deviceId: "A", baseRevision: 2 }), /TERMINAL_STATE/);
  assert.throws(() => canChange({ ...row, status: "PRETE" }, { deviceId: "A", baseRevision: 2, status: "RETIREE" }, false, true), /SALE_REQUIRED/);
});
test("commande 3000, acompte 500 : reste affiché 2500 mais lignes inchangées 3000", () => {
  const lines = [{ id: "historique", parentId: null, qty: 1, unitXpf: "3000", lineXpf: "3000", tgcRatePpm: 60000, prixVariable: true, produitNom: "Synthétique" }];
  const parsed = frozenLines(lines); assert.equal(parsed.total, 3000n); assert.deepEqual(parsed.lines, lines);
  for (const deposit of [0n, 500n]) { assert.equal(parsed.total! - deposit, deposit === 0n ? 3000n : 2500n); assert.equal(parsed.total, 3000n); }
  assert.throws(() => frozenLines([{ qty: 1, unitXpf: "1", lineXpf: "3000" }]));
  const unknown = [{ qty: 1, prix: null, historique: "prix inconnu" }];
  assert.deepEqual(frozenLines(unknown, true).lines, unknown); assert.equal(frozenLines(unknown, true).total, null);
  assert.throws(() => frozenLines(unknown));
});
test("avoir : ancienne empreinte inchangée ; nouvelles attributions couvertes et valides en UTC+11", () => {
  const old: RefundInput = { actionId: "10000000-0000-0000-0000-000000000001", reason: "Synthétique", refundMethod: "CASH", cashDrawer: "EXTERNAL",
    lines: [{ lineId: "10000000-0000-0000-0000-000000000002", qty: 1 }] };
  const extended: RefundInput = { ...old, cashDayId: "10000000-0000-0000-0000-000000000003", drawerBusinessDay: "2026-10-15", deviceId: "A", occurredAt: "2026-10-14T13:00:00Z" };
  assert.equal(validRefundInput(old), true); assert.equal(validRefundInput(extended), true);
  assert.notEqual(refundFingerprint(old), refundFingerprint(extended));
  assert.notEqual(refundFingerprint(extended), refundFingerprint({ ...extended, deviceId: "B" }));
  assert.equal(validRefundInput({ ...extended, drawerBusinessDay: "2026-10-14" }), false);
});
