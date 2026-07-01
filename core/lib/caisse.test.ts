import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChange, lineTotalXpf, type PaymentLike } from "./money.ts";

const cash = (amountXpf: bigint, tenderedXpf?: bigint): PaymentLike => ({ method: "CASH", amountXpf, tenderedXpf });
const card = (amountXpf: bigint): PaymentLike => ({ method: "CARD", amountXpf });

test("computeChange — espèces pile, aucun rendu", () => {
  assert.equal(computeChange([cash(2000n, 2000n)]), 0n);
});

test("computeChange — espèces avec rendu monnaie", () => {
  // total 2000, le client donne 5000 → rendu 3000
  assert.equal(computeChange([cash(2000n, 5000n)]), 3000n);
});

test("computeChange — tendered absent = pas de rendu", () => {
  assert.equal(computeChange([cash(2000n)]), 0n);
});

test("computeChange — paiement mixte CB + espèces avec rendu", () => {
  // CB 1500 (pas de tendered) + espèces 500 payées avec 1000 remis → rendu 500
  assert.equal(computeChange([card(1500n), cash(500n, 1000n)]), 500n);
});

test("computeChange — jamais négatif", () => {
  assert.equal(computeChange([cash(2000n, 1000n)]), 0n);
});

test("lineTotalXpf — prix unitaire × quantité", () => {
  assert.equal(lineTotalXpf(3500n, 3), 10500n);
});
