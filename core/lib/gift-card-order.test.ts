// Commande de bon en ligne — règles pures (lib/gift-card-order.ts).
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOrderReference, serializeGiftCardOrder, validateGiftCardOrder } from "./gift-card-order.ts";
import { CODE_ALPHABET } from "./gift-card.ts";

const UUID = "11111111-1111-1111-1111-111111111111";
const nominal = (extra: Record<string, unknown> = {}) => ({
  amountXpf: 5000,
  buyerName: "Léa",
  buyerPhone: "77 12 34",
  beneficiaryName: "Camille",
  ...extra,
});
const err = (extra: Record<string, unknown>) => {
  const r = validateGiftCardOrder(nominal(extra));
  return r.ok ? null : r.error;
};

test("nominal → ok, montant en bigint, champs absents à null", () => {
  const r = validateGiftCardOrder(nominal({ serviceId: UUID, serviceLabel: "Soin visage", message: " Bises " }));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.data.amountXpf, 5000n);
    assert.equal(r.data.serviceId, UUID);
    assert.equal(r.data.buyerEmail, null);
    assert.equal(r.data.message, "Bises");
  }
});

test("montant en chaîne de chiffres accepté", () => {
  const r = validateGiftCardOrder(nominal({ amountXpf: "12000" }));
  assert.ok(r.ok && r.data.amountXpf === 12000n);
});

test("corps non objet → INVALID_BODY", () => {
  assert.deepEqual(validateGiftCardOrder(null), { ok: false, error: "INVALID_BODY" });
});

test("INVALID_AMOUNT : < 1000, > 500000, décimal, texte, absent", () => {
  for (const amountXpf of [999, 500001, 1500.5, "12a", undefined]) assert.equal(err({ amountXpf }), "INVALID_AMOUNT");
  assert.equal(err({ amountXpf: 1000 }), null);
  assert.equal(err({ amountXpf: 500000 }), null);
});

test("INVALID_SERVICE", () => assert.equal(err({ serviceId: "x" }), "INVALID_SERVICE"));
test("serviceLabel > 120 refusé", () => assert.equal(err({ serviceLabel: "a".repeat(121) }), "SERVICE_LABEL_TOO_LONG"));
test("BUYER_NAME_REQUIRED", () => {
  assert.equal(err({ buyerName: "" }), "BUYER_NAME_REQUIRED");
  assert.equal(err({ buyerName: "a".repeat(121) }), "BUYER_NAME_REQUIRED");
});
test("INVALID_EMAIL", () => assert.equal(err({ buyerEmail: "pas-un-mail" }), "INVALID_EMAIL"));
test("e-mail seul suffit comme contact", () => assert.equal(err({ buyerPhone: null, buyerEmail: "a@b.nc" }), null));
test("BUYER_CONTACT_REQUIRED", () => assert.equal(err({ buyerPhone: null }), "BUYER_CONTACT_REQUIRED"));
test("téléphone > 40 refusé", () => assert.equal(err({ buyerPhone: "1".repeat(41) }), "INVALID_PHONE"));
test("BENEFICIARY_NAME_REQUIRED", () => assert.equal(err({ beneficiaryName: " " }), "BENEFICIARY_NAME_REQUIRED"));
test("bénéficiaire : e-mail invalide → INVALID_EMAIL", () => assert.equal(err({ beneficiaryEmail: "x@" }), "INVALID_EMAIL"));
test("MESSAGE_TOO_LONG", () => assert.equal(err({ message: "a".repeat(501) }), "MESSAGE_TOO_LONG"));

test("generateOrderReference : CMD- + 6 caractères de l'alphabet des bons", () => {
  for (let i = 0; i < 50; i++) {
    const ref = generateOrderReference();
    assert.match(ref, /^CMD-.{6}$/);
    for (const c of ref.slice(4)) assert.ok(CODE_ALPHABET.includes(c), c);
  }
});

test("serializeGiftCardOrder : bigint → number, dates → ISO ou null", () => {
  const d = new Date("2026-10-03T10:00:00Z");
  const j = serializeGiftCardOrder({
    id: UUID, tenantId: UUID, reference: "CMD-AAAAAA", status: "PENDING", channel: "ONLINE",
    amountXpf: 5000n, serviceId: null, serviceLabel: null, buyerName: "Léa", buyerPhone: null,
    buyerEmail: null, beneficiaryName: "Camille", beneficiaryPhone: null, beneficiaryEmail: null,
    message: null, paymentMode: "ON_SITE", paymentProvider: null, paymentRef: null,
    createdAt: d, updatedAt: d, paidAt: null, saleId: null, giftCardId: null,
    cancelledAt: null, cancelReason: null, cancelledBy: null, cancelledByName: null,
  });
  assert.equal(j.amountXpf, 5000);
  assert.equal(j.createdAt, "2026-10-03T10:00:00.000Z");
  assert.equal(j.paidAt, null);
});
