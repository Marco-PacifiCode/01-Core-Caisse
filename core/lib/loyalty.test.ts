// Fidélité — tests des règles pures (lib/loyalty.ts), lot C1.
//
// CE QUE CES TESTS PROTÈGENT
// Un JOURNAL, pas un solde en cache : ce fichier ne teste que les fonctions PURES qui calculent
// points, récompenses et remises — jamais d'écriture, jamais d'horloge implicite. Les cas
// chiffrés viennent du plan Salon-Reference §5 (C1), plus le complément Marco du 15/09 sur les
// bons cadeaux qui ne rapportent jamais de points.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateProgram,
  nextActivatedAt,
  pointsForSale,
  rewardDiscountXpf,
  expiresAtFor,
  isRewardAvailable,
} from "./loyalty.ts";

// ══════════════════════════════════════════════════════════════════════════════════════════
// pointsForSale
// ══════════════════════════════════════════════════════════════════════════════════════════

test("pointsForSale : assiette SERVICES exclut le produit et retranche le bon (remise)", () => {
  const lines = [
    { kind: "SERVICE", lineXpf: 5000n },
    { kind: "PRODUCT", lineXpf: 2000n },
    { kind: "OTHER", lineXpf: -3000n }, // bon/remise consommé sur le ticket
  ];
  // assiette = 5000 - 3000 = 2000 ; 1 point / 100F → 20
  assert.equal(pointsForSale(lines, 4000n, 4000n, "SERVICES", 1), 20);
});

test("pointsForSale : plafonné à l'encaissé (vente à crédit)", () => {
  const lines = [
    { kind: "SERVICE", lineXpf: 5000n },
    { kind: "PRODUCT", lineXpf: 2000n },
    { kind: "OTHER", lineXpf: -3000n },
  ];
  // assiette 2000, mais seulement 1000F encaissés → plafonné à 1000 → 10 points
  assert.equal(pointsForSale(lines, 4000n, 1000n, "SERVICES", 1), 10);
});

test("pointsForSale : assiette ALL retranche les ventes de bon cadeau (décision Marco 15/09)", () => {
  // Ticket 3 000 F de prestations + 10 000 F de vente de bon cadeau (ligne OTHER, comme posée
  // par la surface dans finance-actions.ts#checkoutTicket) ; total encaissé = 13 000 F.
  const lines = [
    { kind: "SERVICE", lineXpf: 3000n },
    { kind: "OTHER", lineXpf: 10000n }, // vente du bon cadeau
  ];
  const totalXpf = 13000n;
  const giftCardSalesXpf = 10000n; // somme des GiftCard.amountXpf émis par CETTE vente
  assert.equal(pointsForSale(lines, totalXpf, totalXpf, "ALL", 1, giftCardSalesXpf), 30);
});

test("pointsForSale : assiette ALL sans bon cadeau reste le total", () => {
  const lines = [{ kind: "SERVICE", lineXpf: 3000n }];
  assert.equal(pointsForSale(lines, 3000n, 3000n, "ALL", 1), 30);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// rewardDiscountXpf
// ══════════════════════════════════════════════════════════════════════════════════════════

test("rewardDiscountXpf : 10 % d'une base de 4 500 F → 450", () => {
  const snapshot = { rewardKind: "PERCENT", rewardPercent: 10, rewardAmountXpf: null, rewardBase: "SERVICES" };
  const lines = [{ kind: "SERVICE", lineXpf: 4500n }];
  assert.equal(rewardDiscountXpf(snapshot, lines), 450n);
});

test("rewardDiscountXpf : montant 10 000 F sur une base de 4 500 F → 4 499 (reliquat perdu)", () => {
  const snapshot = { rewardKind: "AMOUNT", rewardPercent: null, rewardAmountXpf: 10000n, rewardBase: "SERVICES" };
  const lines = [{ kind: "SERVICE", lineXpf: 4500n }];
  assert.equal(rewardDiscountXpf(snapshot, lines), 4499n);
});

test("rewardDiscountXpf : base de 1 F → 0", () => {
  const snapshot = { rewardKind: "AMOUNT", rewardPercent: null, rewardAmountXpf: 10000n, rewardBase: "SERVICES" };
  const lines = [{ kind: "SERVICE", lineXpf: 1n }];
  assert.equal(rewardDiscountXpf(snapshot, lines), 0n);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// validateProgram
// ══════════════════════════════════════════════════════════════════════════════════════════

test("validateProgram : VISITS sans visitsPerReward est refusé", () => {
  const res = validateProgram({ mode: "VISITS" });
  assert.equal(res.ok, false);
});

test("validateProgram : rewardPercent à 100 est refusé", () => {
  const res = validateProgram({
    mode: "VISITS",
    visitsPerReward: 5,
    rewardKind: "PERCENT",
    rewardPercent: 100,
  });
  assert.equal(res.ok, false);
});

test("validateProgram : VISITS complet et valide est accepté", () => {
  const res = validateProgram({
    mode: "VISITS",
    visitsPerReward: 5,
    rewardKind: "PERCENT",
    rewardPercent: 10,
  });
  assert.equal(res.ok, true);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// expiresAtFor / nextActivatedAt / isRewardAvailable
//
// `rewardsToCreate` a été RETIRÉE (2026-09-16, correctif QA) : c'était un quotient entier
// (`Math.floor(sum/perReward)`) qui MENT sur un solde NÉGATIF (arrondit vers -∞). Le moteur
// d'émission des récompenses (`lib/loyalty-db.ts#issueRewardsWhileNetReached`) ne divise plus
// jamais — il consomme le NET par tranches tant qu'il atteint le seuil. Ne pas réintroduire un
// quotient ici : un solde de fidélité est signé (REWARD, REVERSAL et ADJUST peuvent être
// négatifs), et un quotient entier ne s'applique correctement qu'à un solde qui ne descend
// jamais sous zéro.
// ══════════════════════════════════════════════════════════════════════════════════════════

test("expiresAtFor(31/01, 1) tombe au 28 ou 29/02", () => {
  const occurredAt = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));
  const expires = expiresAtFor(occurredAt, 1);
  assert.ok(expires);
  assert.equal(expires!.getUTCMonth(), 1); // février
  assert.ok(expires!.getUTCDate() === 28 || expires!.getUTCDate() === 29);
});

test("expiresAtFor(null) → null", () => {
  assert.equal(expiresAtFor(new Date(), null), null);
});

test("nextActivatedAt : OFF -> VISITS pose now", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  assert.equal(nextActivatedAt(null, "OFF", "VISITS", now), now);
});

test("nextActivatedAt : VISITS -> POINTS garde la date précédente", () => {
  const prev = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-09-15T00:00:00Z");
  assert.equal(nextActivatedAt(prev, "VISITS", "POINTS", now), prev);
});

test("isRewardAvailable : ni consommée ni expirée → true", () => {
  assert.equal(isRewardAvailable({ redeemedAt: null, expiresAt: null }), true);
});

test("isRewardAvailable : redeemedAt renseigné → false", () => {
  assert.equal(isRewardAvailable({ redeemedAt: new Date(), expiresAt: null }), false);
});

test("isRewardAvailable : expirée → false", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  const passe = new Date("2026-01-01T00:00:00Z");
  assert.equal(isRewardAvailable({ redeemedAt: null, expiresAt: passe }, now), false);
});
