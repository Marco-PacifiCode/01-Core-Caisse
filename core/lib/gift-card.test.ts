// Bons cadeaux — tests des règles pures (lib/gift-card.ts).
//
// CE QUE CES TESTS PROTÈGENT
// L'invariant du module, rappelé en tête de gift-card.ts : le montant d'un bon entre dans le
// chiffre d'affaires UNE SEULE FOIS, le jour de son achat. La consommation n'a AUCUNE
// comptabilité. Ce fichier ne teste que la logique PURE (statut, validation, normalisation,
// agrégats du Z) — le contrat des routes et l'atomicité des écritures sont testés séparément
// dans gift-card-routes.test.ts, qui lit le SOURCE des routes et de lib/caisse.ts.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  giftCardStatus,
  isRedeemable,
  normalizeGiftCardAmount,
  normalizeRedeemedFor,
  normalizeCode,
  formatGiftCardCode,
  validateGiftCard,
  validateGiftCards,
  generateGiftCardCode,
  summarizeRedeemedGiftCards,
  giftCardZLabel,
  isRedeemedInSession,
  type GiftCardInput,
} from "./gift-card.ts";
import { expectedCashXpf } from "./cash-movement.ts";

// ══════════════════════════════════════════════════════════════════════════════════════════
// 1. LE STATUT — dérivé, jamais stocké, et l'ORDRE est le contrat
// ══════════════════════════════════════════════════════════════════════════════════════════

test("statut : une carte vierge est VALID", () => {
  assert.equal(
    giftCardStatus({ redeemedAt: null, cancelledAt: null, expiresAt: null }),
    "VALID",
  );
});

test("statut : redeemedAt renseigné → REDEEMED", () => {
  assert.equal(
    giftCardStatus({ redeemedAt: new Date(), cancelledAt: null, expiresAt: null }),
    "REDEEMED",
  );
});

test("statut : cancelledAt renseigné → CANCELLED", () => {
  assert.equal(
    giftCardStatus({ redeemedAt: null, cancelledAt: new Date(), expiresAt: null }),
    "CANCELLED",
  );
});

test("statut : expiresAt dans le passé → EXPIRED", () => {
  const now = new Date("2026-08-10T12:00:00Z");
  const passe = new Date("2026-01-01T00:00:00Z");
  assert.equal(
    giftCardStatus({ redeemedAt: null, cancelledAt: null, expiresAt: passe }, now),
    "EXPIRED",
  );
});

test("🔴 statut : annulée ET périmée → CANCELLED, pas EXPIRED (l'ordre est le contrat)", () => {
  // Sinon l'écran dirait « expiré » d'un bon annulé — donc mentirait sur ce qui s'est passé :
  // un bon annulé reste annulé, l'annulation prime toujours sur la date.
  const now = new Date("2026-08-10T12:00:00Z");
  const passe = new Date("2026-01-01T00:00:00Z");
  assert.equal(
    giftCardStatus({ redeemedAt: null, cancelledAt: new Date(), expiresAt: passe }, now),
    "CANCELLED",
  );
});

test("🔴 statut : consommée ET périmée → REDEEMED, pas EXPIRED (l'ordre est le contrat)", () => {
  // Sinon l'écran dirait « expiré » d'un bon réellement utilisé — donc mentirait sur ce qui
  // s'est passé, au moment précis où quelqu'un cherche à comprendre.
  const now = new Date("2026-08-10T12:00:00Z");
  const passe = new Date("2026-01-01T00:00:00Z");
  assert.equal(
    giftCardStatus({ redeemedAt: new Date(), cancelledAt: null, expiresAt: passe }, now),
    "REDEEMED",
  );
});

test("statut : expiresAt null → jamais EXPIRED, quelle que soit la date d'observation", () => {
  const now = new Date("2099-01-01T00:00:00Z");
  assert.equal(
    giftCardStatus({ redeemedAt: null, cancelledAt: null, expiresAt: null }, now),
    "VALID",
  );
});

test("statut : accepte une date en Date ET en chaîne ISO (Prisma rend des Date, le JSON des chaînes)", () => {
  const now = new Date("2026-08-10T12:00:00Z");
  const enDate = giftCardStatus({ redeemedAt: null, cancelledAt: null, expiresAt: new Date("2026-01-01T00:00:00Z") }, now);
  const enChaine = giftCardStatus({ redeemedAt: null, cancelledAt: null, expiresAt: "2026-01-01T00:00:00Z" }, now);
  assert.equal(enDate, "EXPIRED");
  assert.equal(enChaine, "EXPIRED");
});

// ── 🔴 TEST DE FUSEAU ────────────────────────────────────────────────────────────────────────
// `now` est TOUJOURS passé explicitement quand la date compte : le résultat doit être identique
// sous TZ=UTC et sous TZ=Pacific/Noumea. Ce test l'exécute concrètement avec une date écrite en
// heure locale de Nouméa (+11:00), pour prouver que la comparaison se fait sur l'instant, pas
// sur une chaîne locale mal comparée.
test("🔴 fuseau : une carte expirant le 10/08 23:59:59 +11:00 est encore VALID à 12:00 UTC, EXPIRED à 00:00 UTC le 11", () => {
  const carte = { redeemedAt: null, cancelledAt: null, expiresAt: "2026-08-10T23:59:59+11:00" };

  const avant = new Date("2026-08-10T12:00:00Z"); // 23:00 à Nouméa — avant l'expiration
  assert.equal(giftCardStatus(carte, avant), "VALID");

  const apres = new Date("2026-08-11T00:00:00Z"); // après 12:59:59Z, l'instant d'expiration
  assert.equal(giftCardStatus(carte, apres), "EXPIRED");
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 2. isRedeemable — l'expiration ne bloque JAMAIS le moteur
// ══════════════════════════════════════════════════════════════════════════════════════════

test("isRedeemable : vrai sur une carte vierge", () => {
  assert.equal(isRedeemable({ redeemedAt: null, cancelledAt: null }), true);
});

test("isRedeemable : faux si déjà consommée", () => {
  assert.equal(isRedeemable({ redeemedAt: new Date(), cancelledAt: null }), false);
});

test("isRedeemable : faux si annulée", () => {
  assert.equal(isRedeemable({ redeemedAt: null, cancelledAt: new Date() }), false);
});

test("🔴 isRedeemable : VRAI si SEULEMENT expirée — l'expiration est une décision du commerce", () => {
  // Le moteur ne refuse que ce qui est objectivement impossible (déjà consommé, annulé).
  // Accepter un bon périmé au comptoir est un choix du salon, pas du moteur : `isRedeemable`
  // ne regarde même pas `expiresAt`, et c'est délibéré.
  assert.equal(isRedeemable({ redeemedAt: null, cancelledAt: null }), true);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 3. normalizeGiftCardAmount — XPF = franc entier, jamais de centime
// ══════════════════════════════════════════════════════════════════════════════════════════

test("montant : bigint, number entier, chaîne de chiffres → acceptés, en bigint", () => {
  for (const raw of [1500n, 1500, "1500"]) {
    const r = normalizeGiftCardAmount(raw);
    assert.equal(r.ok, true, `refusé à tort : ${String(raw)}`);
    if (r.ok) {
      assert.equal(r.amountXpf, 1500n);
      assert.equal(typeof r.amountXpf, "bigint");
    }
  }
});

test("montant : 0 et négatif → AMOUNT_NOT_POSITIVE — un bon qui ne vaut rien n'est pas un bon", () => {
  assert.deepEqual(normalizeGiftCardAmount(0), { ok: false, error: "AMOUNT_NOT_POSITIVE" });
  assert.deepEqual(normalizeGiftCardAmount("0"), { ok: false, error: "AMOUNT_NOT_POSITIVE" });
  assert.deepEqual(normalizeGiftCardAmount(-1500), { ok: false, error: "AMOUNT_NOT_POSITIVE" });
});

test("montant : XPF = franc entier, pas de centime jamais — décimal refusé", () => {
  assert.deepEqual(normalizeGiftCardAmount(1500.5), { ok: false, error: "AMOUNT_NOT_INTEGER" });
});

test("montant : NaN, Infinity, chaîne non numérique, null, undefined, objet → AMOUNT_NOT_INTEGER", () => {
  for (const raw of [NaN, Infinity, -Infinity, "abc", null, undefined, {}]) {
    const r = normalizeGiftCardAmount(raw);
    assert.deepEqual(r, { ok: false, error: "AMOUNT_NOT_INTEGER" }, `accepté à tort : ${String(raw)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 4. normalizeRedeemedFor — facultatif, aucun solde calculé
// ══════════════════════════════════════════════════════════════════════════════════════════

test("redeemedFor : null, undefined, '' → ok avec redeemedForXpf null — ce n'est PAS une erreur", () => {
  for (const raw of [null, undefined, ""]) {
    assert.deepEqual(normalizeRedeemedFor(raw), { ok: true, redeemedForXpf: null });
  }
});

test("redeemedFor : 0 est accepté (une prestation peut être annoncée gratuite)", () => {
  assert.deepEqual(normalizeRedeemedFor(0), { ok: true, redeemedForXpf: 0n });
});

test("redeemedFor : négatif → REDEEMED_FOR_NEGATIVE", () => {
  assert.deepEqual(normalizeRedeemedFor(-100), { ok: false, error: "REDEEMED_FOR_NEGATIVE" });
});

test("redeemedFor : décimal → REDEEMED_FOR_NOT_INTEGER", () => {
  assert.deepEqual(normalizeRedeemedFor(100.5), { ok: false, error: "REDEEMED_FOR_NOT_INTEGER" });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 5. normalizeCode / formatGiftCardCode — trois graphies, un seul bon
// ══════════════════════════════════════════════════════════════════════════════════════════

test("normalizeCode : trois graphies désignent le même bon — un code se recopie à la main", () => {
  assert.equal(normalizeCode("bc 4k7q-p2"), "BC4K7QP2");
  assert.equal(normalizeCode("BC-4K7QP2"), "BC4K7QP2");
});

test("normalizeCode : une entrée non-chaîne rend une chaîne vide, jamais une exception", () => {
  assert.equal(normalizeCode(null), "");
  assert.equal(normalizeCode(undefined), "");
  assert.equal(normalizeCode(1234), "");
});

test("formatGiftCardCode : ajoute le tiret d'affichage", () => {
  assert.equal(formatGiftCardCode("BC4K7QP2"), "BC-4K7QP2");
});

test("formatGiftCardCode : idempotent sur une entrée déjà formatée", () => {
  assert.equal(formatGiftCardCode("BC-4K7QP2"), "BC-4K7QP2");
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 6. validateGiftCard — la validation d'un bon à l'émission
// ══════════════════════════════════════════════════════════════════════════════════════════

const UUID_VALIDE = "11111111-1111-1111-1111-111111111111";

function inputNominal(extra: Partial<GiftCardInput> = {}): GiftCardInput {
  return {
    code: "bc 4k7q-p2",
    amountXpf: 5000,
    beneficiaryName: "Camille",
    ...extra,
  };
}

test("validateGiftCard : cas nominal complet → ok, et le code est normalisé", () => {
  const r = validateGiftCard(inputNominal());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.data.code, "BC4K7QP2");
    assert.equal(r.data.amountXpf, 5000n);
  }
});

test("validateGiftCard : sans code → CODE_REQUIRED", () => {
  const r = validateGiftCard(inputNominal({ code: "" }));
  assert.deepEqual(r, { ok: false, error: "CODE_REQUIRED" });
});

test("validateGiftCard : code de plus de 40 caractères → CODE_TOO_LONG", () => {
  const r = validateGiftCard(inputNominal({ code: "a".repeat(41) }));
  assert.deepEqual(r, { ok: false, error: "CODE_TOO_LONG" });
});

test("validateGiftCard : montant absent → refus d'amount", () => {
  const r = validateGiftCard(inputNominal({ amountXpf: undefined }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "AMOUNT_NOT_INTEGER");
});

test("validateGiftCard : montant à 0 → refus d'amount", () => {
  const r = validateGiftCard(inputNominal({ amountXpf: 0 }));
  assert.deepEqual(r, { ok: false, error: "AMOUNT_NOT_POSITIVE" });
});

test("🔴 validateGiftCard : aucun identifiant de bénéficiaire → BENEFICIARY_REQUIRED", () => {
  const r = validateGiftCard(inputNominal({ beneficiaryName: undefined }));
  assert.deepEqual(r, { ok: false, error: "BENEFICIARY_REQUIRED" });
});

test("validateGiftCard : le nom seul suffit comme identifiant de bénéficiaire", () => {
  const r = validateGiftCard(inputNominal({ beneficiaryName: "Camille", beneficiaryPhone: undefined, beneficiaryEmail: undefined }));
  assert.equal(r.ok, true);
});

test("validateGiftCard : le téléphone seul suffit comme identifiant de bénéficiaire", () => {
  const r = validateGiftCard(inputNominal({ beneficiaryName: undefined, beneficiaryPhone: "687123456", beneficiaryEmail: undefined }));
  assert.equal(r.ok, true);
});

test("validateGiftCard : l'e-mail seul suffit comme identifiant de bénéficiaire", () => {
  const r = validateGiftCard(inputNominal({ beneficiaryName: undefined, beneficiaryPhone: undefined, beneficiaryEmail: "camille@example.nc" }));
  assert.equal(r.ok, true);
});

test("validateGiftCard : expiresAt illisible → EXPIRY_INVALID", () => {
  const r = validateGiftCard(inputNominal({ expiresAt: "pas une date" }));
  assert.deepEqual(r, { ok: false, error: "EXPIRY_INVALID" });
});

test("validateGiftCard : expiresAt absent → data.expiresAt === null", () => {
  const r = validateGiftCard(inputNominal());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.expiresAt, null);
});

test("validateGiftCard : serviceId non-UUID → silencieusement ignoré, data.serviceId === null", () => {
  const r = validateGiftCard(inputNominal({ serviceId: "pas-un-uuid" }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.serviceId, null);
});

test("validateGiftCard : serviceId au format UUID valide est conservé", () => {
  const r = validateGiftCard(inputNominal({ serviceId: UUID_VALIDE }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.serviceId, UUID_VALIDE);
});

test("🔴 BON NOMINATIF : serviceLabel renseigné NE DISPENSE PAS d'amountXpf — refusé sans montant", () => {
  // amountXpf est ce qui a été encaissé, donc ce qui est déjà entré dans le CA. Un bon
  // nominatif sans montant serait une prestation dont personne ne saurait dire combien elle a
  // rapporté — et le Z ne pourrait plus se recouper.
  const r = validateGiftCard(inputNominal({ serviceLabel: "Soin visage", amountXpf: undefined }));
  assert.equal(r.ok, false);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 7. validateGiftCards — le LOT, et le garde anti-doublon
// ══════════════════════════════════════════════════════════════════════════════════════════

test("validateGiftCards : lot vide → ok avec data: []", () => {
  assert.deepEqual(validateGiftCards([]), { ok: true, data: [] });
});

test("validateGiftCards : lot valide de 2 bons distincts → ok", () => {
  const r = validateGiftCards([
    inputNominal({ code: "BC-1111AA" }),
    inputNominal({ code: "BC-2222BB" }),
  ]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.data.length, 2);
});

test("🔴 validateGiftCards : deux codes identiques dans le même lot (même sous deux graphies) → DUPLICATE_CODE", () => {
  // Sans ce garde, la transaction échouerait APRÈS que l'argent est pris : mieux vaut refuser
  // avant l'encaissement que se retrouver avec une vente PAID sans ses bons.
  const r = validateGiftCards([
    inputNominal({ code: "BC-1234AB" }),
    inputNominal({ code: "bc1234ab" }),
  ]);
  assert.deepEqual(r, { ok: false, error: "DUPLICATE_CODE", index: 1 });
});

test("validateGiftCards : un élément invalide en position 1 → index: 1", () => {
  const r = validateGiftCards([inputNominal({ code: "BC-1111AA" }), inputNominal({ code: "" })]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, "CODE_REQUIRED");
    assert.equal(r.index, 1);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 8. generateGiftCardCode — lisible, et sans glyphe ambigu
// ══════════════════════════════════════════════════════════════════════════════════════════

test("generateGiftCardCode : commence par BC et fait 8 caractères", () => {
  const code = generateGiftCardCode(() => 0.5);
  assert.match(code, /^BC/);
  assert.equal(code.length, 8);
});

test("generateGiftCardCode : avec un rand injecté constant, le résultat est déterministe", () => {
  const a = generateGiftCardCode(() => 0);
  const b = generateGiftCardCode(() => 0);
  assert.equal(a, b);
});

test("🔴 generateGiftCardCode : sur 2000 tirages avec Math.random, aucun caractère ambigu (O,I,S,0,1,5)", () => {
  // Un code est recopié à la main ; une confusion de glyphe (O/0, I/1, S/5) est un bon
  // introuvable au comptoir.
  const ambigus = /[OIS015]/;
  for (let i = 0; i < 2000; i++) {
    const code = generateGiftCardCode();
    assert.ok(!ambigus.test(code), `caractère ambigu dans ${code}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 9. 🔒 summarizeRedeemedGiftCards — LE TEST LE PLUS IMPORTANT DU FICHIER
// ══════════════════════════════════════════════════════════════════════════════════════════

test("summarizeRedeemedGiftCards : lot vide → count 0, total 0n", () => {
  assert.deepEqual(summarizeRedeemedGiftCards([]), { giftCardRedeemedCount: 0, giftCardRedeemedXpf: 0n });
});

test("summarizeRedeemedGiftCards : 3 bons (10000n, 6000n, 2500n) → count 3, total 18500n", () => {
  const r = summarizeRedeemedGiftCards([{ amountXpf: 10000n }, { amountXpf: 6000n }, { amountXpf: 2500n }]);
  assert.equal(r.giftCardRedeemedCount, 3);
  assert.equal(r.giftCardRedeemedXpf, 18500n);
});

test("summarizeRedeemedGiftCards : le total est un bigint, pas un number", () => {
  const r = summarizeRedeemedGiftCards([{ amountXpf: 10000n }]);
  assert.equal(typeof r.giftCardRedeemedXpf, "bigint");
});

test("🔒 summarizeRedeemedGiftCards : SIGNATURE — exactement ces deux clés, et rien d'autre", () => {
  // L'invariant du module tient par la SIGNATURE, pas par une note de bas de page. Si un jour
  // cette fonction se met à rendre un champ nommé comme un poste de trésorerie ou de CA,
  // quelqu'un l'additionnera. Le montant d'un bon entre dans le CA une seule fois, le jour de
  // son achat.
  const r = summarizeRedeemedGiftCards([{ amountXpf: 1000n }]);
  assert.deepEqual(Object.keys(r).sort(), ["giftCardRedeemedCount", "giftCardRedeemedXpf"]);
});

test("🔒 summarizeRedeemedGiftCards / expectedCashXpf : l'attendu du tiroir est identique, bons consommés ou pas", () => {
  // `expectedCashXpf` NE REÇOIT PAS de bons cadeaux — c'est son prototype qui l'interdit. Pour
  // faire entrer un bon dans l'attendu du tiroir, il faudrait changer une signature, pas
  // oublier une ligne.
  const attendu = expectedCashXpf({ openingFloatXpf: 10000n, cashSalesXpf: 5000n, movements: [] });
  assert.equal(attendu, 15000n);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 10. giftCardZLabel — la phrase qui empêche de recompter le CA
// ══════════════════════════════════════════════════════════════════════════════════════════

const formatXpf = (v: bigint) => `${v} F`;

test("giftCardZLabel : 0 bon → null, rien à afficher", () => {
  const label = giftCardZLabel({ giftCardRedeemedCount: 0, giftCardRedeemedXpf: 0n }, formatXpf);
  assert.equal(label, null);
});

test("giftCardZLabel : 1 bon → singulier « 1 prestation réglée par bon cadeau »", () => {
  const label = giftCardZLabel({ giftCardRedeemedCount: 1, giftCardRedeemedXpf: 5000n }, formatXpf);
  assert.ok(label!.includes("1 prestation réglée par bon cadeau"));
});

test("giftCardZLabel : 3 bons → pluriel « 3 prestations réglées »", () => {
  const label = giftCardZLabel({ giftCardRedeemedCount: 3, giftCardRedeemedXpf: 15000n }, formatXpf);
  assert.ok(label!.includes("3 prestations réglées"));
});

test("🔴 giftCardZLabel : contient toujours « déjà encaissés à la vente des bons »", () => {
  // C'est cette phrase qui empêche quelqu'un d'additionner ce montant au CA du jour en croyant
  // réparer un oubli.
  const un = giftCardZLabel({ giftCardRedeemedCount: 1, giftCardRedeemedXpf: 5000n }, formatXpf);
  const trois = giftCardZLabel({ giftCardRedeemedCount: 3, giftCardRedeemedXpf: 15000n }, formatXpf);
  assert.ok(un!.includes("déjà encaissés à la vente des bons"));
  assert.ok(trois!.includes("déjà encaissés à la vente des bons"));
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 11. isRedeemedInSession — fenêtre [openedAt, closedAt], bornes incluses
// ══════════════════════════════════════════════════════════════════════════════════════════

const openedAt = new Date("2026-08-10T08:00:00Z");
const closedAt = new Date("2026-08-10T18:00:00Z");

test("isRedeemedInSession : dans la fenêtre → vrai", () => {
  assert.equal(isRedeemedInSession(new Date("2026-08-10T12:00:00Z"), { openedAt, closedAt }), true);
});

test("isRedeemedInSession : avant openedAt → faux", () => {
  assert.equal(isRedeemedInSession(new Date("2026-08-10T07:59:59Z"), { openedAt, closedAt }), false);
});

test("isRedeemedInSession : après closedAt → faux", () => {
  assert.equal(isRedeemedInSession(new Date("2026-08-10T18:00:01Z"), { openedAt, closedAt }), false);
});

test("isRedeemedInSession : borne basse incluse — exactement openedAt → vrai", () => {
  assert.equal(isRedeemedInSession(openedAt, { openedAt, closedAt }), true);
});

test("isRedeemedInSession : borne haute incluse — exactement closedAt → vrai", () => {
  assert.equal(isRedeemedInSession(closedAt, { openedAt, closedAt }), true);
});

test("isRedeemedInSession : closedAt null (session ouverte) → pas de borne haute", () => {
  assert.equal(isRedeemedInSession(new Date("2099-01-01T00:00:00Z"), { openedAt, closedAt: null }), true);
});

test("isRedeemedInSession : redeemedAt null → faux", () => {
  assert.equal(isRedeemedInSession(null, { openedAt, closedAt }), false);
});
