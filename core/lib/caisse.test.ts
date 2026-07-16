import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChange, lineTotalXpf, normalizePayments, type PaymentLike } from "./money.ts";

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

// ─── normalizePayments — « j'encaisse, puis je rends » (règle portée par le MOTEUR) ───
// Régression V'Cut 2026-07-16 : la surface envoyait amountXpf=3000 sur un ticket à 2500,
// le moteur persistait 3000 et Compta soldait 3000 → 500 de rendu comptabilisés en recette
// (constaté : FAC-2026-0002/0003, paidXpf 3000 pour totalXpf 2500).

test("normalizePayments — LE bug V'Cut : 3000 déclarés en espèces sur un ticket à 2500", () => {
  const r = normalizePayments(2500n, [cash(3000n)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.payments[0].amountXpf, 2500n, "imputé = le dû, jamais plus");
  assert.equal(r.payments[0].tenderedXpf, 3000n, "le remis est conservé pour le reçu");
  assert.equal(r.changeXpf, 500n, "l'excédent est rendu, pas encaissé");
});

test("normalizePayments — appelant correct (amount+tendered) : inchangé", () => {
  const r = normalizePayments(2500n, [cash(2500n, 3000n)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.payments[0].amountXpf, 2500n);
  assert.equal(r.changeXpf, 500n);
});

test("normalizePayments — compte juste : aucun rendu, aucune trace de remis", () => {
  const r = normalizePayments(2500n, [cash(2500n)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.payments[0].amountXpf, 2500n);
  assert.equal(r.payments[0].tenderedXpf, undefined);
  assert.equal(r.changeXpf, 0n);
});

test("normalizePayments — carte en trop = saisie fausse, REFUS (rien ne se rend sur une carte)", () => {
  const r = normalizePayments(2500n, [card(3000n)]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "OVERPAID");
  assert.equal(r.method, "CARD");
  assert.equal(r.excessXpf, 500n);
});

test("normalizePayments — mixte carte + espèces : la carte impute, les espèces rendent", () => {
  const r = normalizePayments(2500n, [card(1000n), cash(3000n)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.payments[0].amountXpf, 1000n);
  assert.equal(r.payments[1].amountXpf, 1500n, "les espèces ne comblent que le reste");
  assert.equal(r.changeXpf, 1500n);
});

test("normalizePayments — paiement insuffisant : on n'invente rien, UNDERPAID reste au checkout", () => {
  const r = normalizePayments(2500n, [cash(1000n)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.payments[0].amountXpf, 1000n);
  assert.equal(r.changeXpf, 0n);
});

test("normalizePayments — cohérence avec computeChange (l'écran et le reçu ne peuvent pas diverger)", () => {
  const r = normalizePayments(2500n, [cash(3000n)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(computeChange(r.payments), r.changeXpf);
});

test("normalizePayments — montants négatifs ou nuls ignorés (jamais de rendu fantôme)", () => {
  const r = normalizePayments(2500n, [cash(-500n), cash(2500n)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.changeXpf, 0n);
  assert.equal(r.payments[1].amountXpf, 2500n);
});
