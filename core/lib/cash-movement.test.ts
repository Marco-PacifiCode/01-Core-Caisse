// Mouvements de tiroir — tests des règles pures (lib/cash-movement.ts).
//
// CE QUE CES TESTS PROTÈGENT
// Le Z du soir est le seul contrôle qu'un salon exerce sur son argent liquide. Avant ce chantier,
// un remboursement en espèces produisait un écart MUET — indiscernable d'une erreur de caisse ou
// d'un vol. Le calcul ci-dessous est ce qui rend cet écart explicable.
//
// L'invariant qui a motivé tout le modèle, et qui est testé ici explicitement : les mouvements
// changent l'ATTENDU DU TIROIR et ne touchent JAMAIS au CHIFFRE D'AFFAIRES. C'est ce qui distingue
// cette solution de la « vente négative » (écartée), qui aurait fait baisser le CA du jour.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  movementSign,
  summarizeMovements,
  expectedCashXpf,
  normalizeMovementAmount,
  normalizeMovementReason,
  normalizeMovementRef,
  isCashMovementKind,
  CASH_MOVEMENT_KINDS,
  type CashMovementLike,
} from "./cash-movement.ts";

// ══════════════════════════════════════════════════════════════════════════════════════════
// 1. LE SENS — le signe vient du `kind`, jamais du montant
// ══════════════════════════════════════════════════════════════════════════════════════════

test("sens : un apport entre, un remboursement et un prélèvement sortent", () => {
  assert.equal(movementSign("CASH_IN"), 1n);
  assert.equal(movementSign("REFUND"), -1n);
  assert.equal(movementSign("CASH_OUT"), -1n);
});

test("sens : les trois natures connues sont couvertes, aucune n'est oubliée", () => {
  // Si quelqu'un ajoute une nature sans décider de son sens, ce test le force à y penser.
  for (const k of CASH_MOVEMENT_KINDS) {
    const s = movementSign(k);
    assert.ok(s === 1n || s === -1n, `sens indéfini pour ${k}`);
  }
  assert.equal(CASH_MOVEMENT_KINDS.length, 3);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 2. L'ATTENDU DU TIROIR — c'est le chiffre que la caissière compare à ce qu'elle compte
// ══════════════════════════════════════════════════════════════════════════════════════════

test("attendu : sans aucun mouvement, le calcul est INCHANGÉ (non-régression)", () => {
  // Le comportement historique doit survivre à ce chantier au franc près : la très grande
  // majorité des sessions n'aura jamais un seul mouvement.
  const attendu = expectedCashXpf({ openingFloatXpf: 10000n, cashSalesXpf: 45000n, movements: [] });
  assert.equal(attendu, 55000n);
});

test("attendu : un remboursement de 3 000 F en espèces BAISSE l'attendu de 3 000 F", () => {
  // LE cas de Marco : « le tiroir est court le soir sans aucune ligne pour l'expliquer ».
  const sans = expectedCashXpf({ openingFloatXpf: 10000n, cashSalesXpf: 45000n, movements: [] });
  const avec = expectedCashXpf({
    openingFloatXpf: 10000n,
    cashSalesXpf: 45000n,
    movements: [{ kind: "REFUND", amountXpf: 3000n }],
  });

  assert.equal(sans - avec, 3000n);
  assert.equal(avec, 52000n);
});

test("attendu : le Z tombe JUSTE quand la caissière compte ce qu'il reste vraiment", () => {
  // Mise en situation complète : fond 10 000, ventes espèces 45 000, avoir remboursé 3 000.
  // Le tiroir contient 52 000. L'écart doit être ZÉRO — c'est tout l'objet du chantier.
  const attendu = expectedCashXpf({
    openingFloatXpf: 10000n,
    cashSalesXpf: 45000n,
    movements: [{ kind: "REFUND", amountXpf: 3000n }],
  });
  const compté = 52000n;

  assert.equal(compté - attendu, 0n, "avant ce chantier, l'écart aurait été de -3000 F, inexpliqué");
});

test("attendu : apports et prélèvements jouent dans le bon sens", () => {
  const attendu = expectedCashXpf({
    openingFloatXpf: 10000n,
    cashSalesXpf: 0n,
    movements: [
      { kind: "CASH_IN", amountXpf: 5000n }, // apport de fond
      { kind: "CASH_OUT", amountXpf: 2000n }, // prélèvement
      { kind: "REFUND", amountXpf: 1000n }, // remboursement
    ],
  });
  assert.equal(attendu, 12000n); // 10000 + 5000 − 2000 − 1000
});

test("attendu : les montants sont des bigint — aucun centime ne peut entrer", () => {
  const attendu = expectedCashXpf({
    openingFloatXpf: 10000n,
    cashSalesXpf: 45000n,
    movements: [{ kind: "REFUND", amountXpf: 3000n }],
  });
  assert.equal(typeof attendu, "bigint");
  assert.equal(attendu % 1n, 0n);
});

test("attendu : un tiroir au-delà de 2^31 ne déborde pas", () => {
  const attendu = expectedCashXpf({
    openingFloatXpf: 3_000_000_000n,
    cashSalesXpf: 1_000_000_000n,
    movements: [{ kind: "REFUND", amountXpf: 500_000_000n }],
  });
  assert.equal(attendu, 3_500_000_000n);
});

test("attendu : l'ordre des mouvements ne change rien (l'addition est commutative, prouvons-le)", () => {
  const m: CashMovementLike[] = [
    { kind: "REFUND", amountXpf: 3000n },
    { kind: "CASH_IN", amountXpf: 5000n },
    { kind: "CASH_OUT", amountXpf: 1000n },
  ];
  const a = expectedCashXpf({ openingFloatXpf: 0n, cashSalesXpf: 0n, movements: m });
  const b = expectedCashXpf({ openingFloatXpf: 0n, cashSalesXpf: 0n, movements: [...m].reverse() });
  assert.equal(a, b);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 3. 🔴 L'INVARIANT QUI JUSTIFIE TOUT LE MODÈLE — le CA ne bouge pas
// ══════════════════════════════════════════════════════════════════════════════════════════

test("🔴 les mouvements n'entrent PAS dans le chiffre d'affaires — c'est le point du chantier", () => {
  // L'option écartée (« vente négative ») aurait fait baisser totalSalesXpf du montant remboursé.
  // Ici, `expectedCashXpf` ne reçoit même pas le CA : il ne PEUT pas le modifier. Ce test fige
  // cette séparation — si quelqu'un fait un jour transiter le CA par cette fonction, il tombe.
  const args = { openingFloatXpf: 10000n, cashSalesXpf: 45000n, movements: [{ kind: "REFUND" as const, amountXpf: 3000n }] };
  assert.ok(!("totalSalesXpf" in args), "le CA n'est pas une entrée du calcul de trésorerie");

  // Et l'agrégat ne rend que des postes de trésorerie, aucun poste de vente.
  const t = summarizeMovements(args.movements);
  assert.deepEqual(Object.keys(t).sort(), ["cashInXpf", "cashOutXpf", "netXpf", "refundsXpf"]);
});

test("agrégat : les trois postes restent SÉPARÉS et POSITIFS (le Z les affiche tels quels)", () => {
  // « Remboursements : −3 000 F » se lit ; un net opaque de −4 000 n'explique rien.
  const t = summarizeMovements([
    { kind: "REFUND", amountXpf: 3000n },
    { kind: "REFUND", amountXpf: 1500n },
    { kind: "CASH_OUT", amountXpf: 2000n },
    { kind: "CASH_IN", amountXpf: 500n },
  ]);

  assert.equal(t.refundsXpf, 4500n);
  assert.equal(t.cashOutXpf, 2000n);
  assert.equal(t.cashInXpf, 500n);
  assert.equal(t.netXpf, -6000n); // 500 − 4500 − 2000
});

test("agrégat : aucun mouvement = trois zéros et un net nul (pas d'undefined)", () => {
  const t = summarizeMovements([]);
  assert.deepEqual(t, { refundsXpf: 0n, cashOutXpf: 0n, cashInXpf: 0n, netXpf: 0n });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 4. LA VALIDATION — ce qui entre dans un Z ne se rattrape pas
// ══════════════════════════════════════════════════════════════════════════════════════════

test("montant : un entier positif passe, en nombre, en chaîne ou en bigint", () => {
  // Les surfaces envoient du JSON : un BigInt n'y survit pas, il arrive en nombre ou en chaîne.
  for (const raw of [3000, "3000", " 3000 ", 3000n]) {
    const r = normalizeMovementAmount(raw);
    assert.equal(r.ok, true, `refusé à tort : ${String(raw)}`);
    if (r.ok) {
      assert.equal(r.amountXpf, 3000n);
      assert.equal(typeof r.amountXpf, "bigint");
    }
  }
});

test("montant : ZÉRO est refusé — un mouvement nul n'explique aucun écart", () => {
  assert.deepEqual(normalizeMovementAmount(0), { ok: false, error: "AMOUNT_NOT_POSITIVE" });
  assert.deepEqual(normalizeMovementAmount("0"), { ok: false, error: "AMOUNT_NOT_POSITIVE" });
});

test("montant : un NÉGATIF est refusé — le sens vient du kind, pas du signe", () => {
  // Accepter −3000 sur un REFUND inverserait le sens en silence et ferait MONTER l'attendu.
  assert.deepEqual(normalizeMovementAmount(-3000), { ok: false, error: "AMOUNT_NOT_POSITIVE" });
  assert.deepEqual(normalizeMovementAmount("-3000"), { ok: false, error: "AMOUNT_NOT_POSITIVE" });
});

test("montant : un CENTIME est refusé — XPF entier, la règle de l'écosystème", () => {
  assert.deepEqual(normalizeMovementAmount(3000.5), { ok: false, error: "AMOUNT_NOT_INTEGER" });
  assert.deepEqual(normalizeMovementAmount("3000.5"), { ok: false, error: "AMOUNT_NOT_INTEGER" });
  assert.deepEqual(normalizeMovementAmount("3 000"), { ok: false, error: "AMOUNT_NOT_INTEGER" });
});

test("montant : 3000.0 arrive en nombre ENTIER et passe — mais 0.1+0.2 ne passe pas", () => {
  // JSON.parse("3000.0") rend 3000 : c'est un entier, il n'y a pas de centime à refuser.
  const a = normalizeMovementAmount(3000.0);
  assert.equal(a.ok, true);
  // En revanche tout ce qui traîne une décimale flottante est refusé.
  assert.deepEqual(normalizeMovementAmount(0.1 + 0.2), { ok: false, error: "AMOUNT_NOT_INTEGER" });
});

test("montant : NaN, Infinity, null, objet, au-delà du sûr → refusés sans exception", () => {
  for (const raw of [NaN, Infinity, -Infinity, null, undefined, {}, [], true, "", "abc", 2 ** 53]) {
    const r = normalizeMovementAmount(raw);
    assert.equal(r.ok, false, `accepté à tort : ${String(raw)}`);
  }
});

test("kind : seules les trois natures connues sont acceptées", () => {
  assert.equal(isCashMovementKind("REFUND"), true);
  assert.equal(isCashMovementKind("CASH_OUT"), true);
  assert.equal(isCashMovementKind("CASH_IN"), true);
  for (const bad of ["refund", "SALE", "", null, 3, {}]) assert.equal(isCashMovementKind(bad), false);
});

test("motif : obligatoire en pratique — vide et blancs rendent null (la route refuse alors)", () => {
  assert.equal(normalizeMovementReason(""), null);
  assert.equal(normalizeMovementReason("   "), null);
  assert.equal(normalizeMovementReason(null), null);
  assert.equal(normalizeMovementReason(42), null);
});

test("motif : mis sur une seule ligne et tronqué à 200 caractères", () => {
  assert.equal(normalizeMovementReason("  Avoir\nrendu  "), "Avoir rendu");
  assert.equal(normalizeMovementReason("x".repeat(500))!.length, 200);
});

test("ref : une chaîne vide vaut ABSENTE — sinon l'unique bloquerait au deuxième mouvement", () => {
  // @@unique([tenantId, ref]) : NULL est distinct de NULL en PostgreSQL, mais "" ne l'est pas.
  // Deux prélèvements sans référence enregistrés avec "" ⇒ le second serait rejeté en base.
  assert.equal(normalizeMovementRef(""), null);
  assert.equal(normalizeMovementRef("   "), null);
  assert.equal(normalizeMovementRef(undefined), null);
  assert.equal(normalizeMovementRef("AVO-2026-0001"), "AVO-2026-0001");
  assert.equal(normalizeMovementRef("  AVO-2026-0001  "), "AVO-2026-0001");
});
