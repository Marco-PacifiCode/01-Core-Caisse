import { test } from "node:test";
import assert from "node:assert/strict";
import { detailCheque, CHEQUE_NUMERO_MAX } from "./cheque-detail.ts";
import { normalizePayments } from "./money.ts";

test("detailCheque : gardé sur CHEQUE, nul ailleurs, jamais un refus", () => {
  assert.deepEqual(detailCheque("CHEQUE", " 1234567 ", "BCI"), { chequeNumber: "1234567", chequeBank: "BCI" });
  assert.deepEqual(detailCheque("CARD", "1234567", "BCI"), { chequeNumber: null, chequeBank: null });
  assert.deepEqual(detailCheque("CHEQUE", "   ", 42), { chequeNumber: null, chequeBank: null });
  assert.equal(detailCheque("CHEQUE", "9".repeat(CHEQUE_NUMERO_MAX + 5), null).chequeNumber?.length, CHEQUE_NUMERO_MAX);
  assert.equal(detailCheque("CHEQUE", "12\n34", null).chequeNumber, "12 34");
});

test("normalizePayments porte le détail du chèque sur SA ligne, sans toucher aux montants", () => {
  const r = normalizePayments(8000n, [
    { method: "CHEQUE", amountXpf: 5000n, chequeNumber: "1234567", chequeBank: "BCI" },
    { method: "CASH", amountXpf: 3000n, tenderedXpf: 5000n },
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.payments[1].chequeNumber, undefined);
  assert.equal(r.payments[0].chequeNumber, "1234567");
  assert.equal(r.payments[0].chequeBank, "BCI");
  assert.deepEqual(r.payments.map((p) => p.amountXpf), [5000n, 3000n]);
  assert.equal(r.changeXpf, 2000n);
});
