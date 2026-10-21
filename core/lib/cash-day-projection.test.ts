import { test } from "node:test";
import assert from "node:assert/strict";
import { businessDay, canonical, factDelta, projectCashDay, safeXpf, taxes, validDay, xpfInteger, type DayClosure, type DayFact } from "./cash-day-projection.ts";

const time = new Date("2026-10-15T01:00:00.000Z");
function fact(sequence: number, kind: string, sourceRef: string, snapshot: unknown, deviceId = "A"): DayFact {
  return { sequence: BigInt(sequence), kind, sourceRef, deviceId, occurredAt: time,
    receivedAt: new Date(time.getTime() + sequence * 1000), cashDeltaXpf: factDelta(kind, snapshot), snapshot };
}
function sale(sequence: number, ref: string, cash: number, card = 0, other = 0, device = "A", lines = [{ lineXpf: String(cash + card + other), tgcRatePpm: 0 }]) {
  return fact(sequence, "SALE_PAID", ref, { totalXpf: String(cash + card + other), lines, parTaux: taxes(lines),
    payments: [{ method: "CASH", amountXpf: String(cash), tenderedXpf: String(cash * 2) }, { method: "CARD", amountXpf: String(card) }, { method: "OTHER", amountXpf: String(other) }] }, device);
}
function closure(overrides: Partial<DayClosure> = {}): DayClosure {
  return { id: "c0", cycle: 0, authoritative: true, countedXpf: 35000n, baselineExpectedXpf: 35000n, cutoffRevision: 1n,
    closureMode: "ONLINE", occurredAt: time, receivedAt: time, actorName: "Test", legacySnapshot: null, ...overrides };
}
const project = (facts: DayFact[], closures: DayClosure[] = [], revision = 1000n, cycle = 0) => projectCashDay({ fond: 25000n, revision, cycle, facts, closures });

// Matrice 6.3 : chaque ligne sur deux appareils, avant/après coupure, avec et sans rejeu.
const cases: { name: string; facts: DayFact[]; cash: bigint; gross: bigint; refund?: bigint; tax?: bigint; gift?: bigint; cancelled?: number }[] = [
  { name: "espèces 1000 dus, 2000 reçus, 1000 rendus", facts: [sale(1, "cash", 1000)], cash: 1000n, gross: 1000n },
  { name: "carte 1000", facts: [sale(1, "card", 0, 1000)], cash: 0n, gross: 1000n },
  { name: "mixte CASH 400 CARD 600", facts: [sale(1, "mixed", 400, 600)], cash: 400n, gross: 1000n },
  { name: "annulation payée et annulation locale sans deuxième sortie", facts: [sale(1, "voided", 1000), fact(2, "SALE_VOID", "voided", { saleRef: "voided" }), fact(3, "LOCAL_VOID", "local", { saleRef: "local" })], cash: 0n, gross: 0n, cancelled: 2 },
  { name: "avoir espèces 200, vente brute 1000", facts: [sale(1, "refund", 1000), fact(2, "PARTIAL_REFUND_DONE", "refund-action", { payments: [{ method: "CASH", amountXpf: "200" }] })], cash: 800n, gross: 1000n, refund: 200n },
  { name: "avoir carte 200 sans effet tiroir", facts: [sale(1, "refund-card", 1000), fact(2, "PARTIAL_REFUND_DONE", "refund-card-action", { payments: [{ method: "CARD", amountXpf: "200" }] })], cash: 1000n, gross: 1000n },
  { name: "avoir d'une vente d'un autre jour : sortie 200", facts: [fact(1, "PARTIAL_REFUND_DONE", "old-sale-refund", { payments: [{ method: "CASH", amountXpf: "200" }] })], cash: -200n, gross: 0n, refund: 200n },
  { name: "bon émis CASH 1000 et consommation informative 1000", facts: [sale(1, "gift-issued", 1000), fact(2, "GIFT_CARD_REDEEMED", "gift-id", { amountXpf: "1000" })], cash: 1000n, gross: 1000n, gift: 1000n },
  { name: "bon émis CARD 1000 et consommation informative 1000", facts: [sale(1, "gift-issued-card", 0, 1000), fact(2, "GIFT_CARD_REDEEMED", "gift-card-id", { amountXpf: "1000" })], cash: 0n, gross: 1000n, gift: 1000n },
  { name: "ticket 1060 à 6% et 1110 à 11%", facts: [sale(1, "tax-mixed", 2170, 0, 0, "A", [{ lineXpf: "1060", tgcRatePpm: 60000 }, { lineXpf: "1110", tgcRatePpm: 110000 }])], cash: 2170n, gross: 2170n, tax: 170n },
  { name: "2 tickets de 10 à 6% : TGC 1+1 et non 1", facts: [sale(1, "tax-a", 10, 0, 0, "A", [{ lineXpf: "10", tgcRatePpm: 60000 }]), sale(2, "tax-b", 10, 0, 0, "B", [{ lineXpf: "10", tgcRatePpm: 60000 }])], cash: 20n, gross: 20n, tax: 2n },
  { name: "commande 3000 ancien acompte 500 : ticket entier 3000", facts: [sale(1, "pickup", 3000)], cash: 3000n, gross: 3000n },
  { name: "commande 3000 acompte 0 : ticket entier 3000", facts: [sale(1, "pickup-zero", 3000)], cash: 3000n, gross: 3000n },
  { name: "historique OTHER PacifiClic 1000 bancaire seulement", facts: [sale(1, "legacy-qr", 0, 0, 1000)], cash: 0n, gross: 1000n },
];
for (const c of cases) for (const device of ["A", "B"]) for (const after of [false, true]) for (const replay of [false, true]) {
  test(`6.3 ${c.name}, appareil ${device}, ${after ? "après" : "avant"} clôture, rejeu=${replay}`, () => {
    const events = c.facts.map(f => ({ ...f, deviceId: device }));
    const facts = replay ? [...events, ...events] : events;
    const out = project(facts, after ? [closure({ countedXpf: 25000n, baselineExpectedXpf: 25000n, cutoffRevision: 0n })] : []);
    assert.equal(out.totauxCourants.expectedXpf, 25000n + c.cash);
    assert.equal(out.totauxCourants.totalSalesXpf, c.gross);
    assert.equal(out.totauxCourants.refundCashXpf, c.refund ?? 0n);
    assert.equal(out.totauxCourants.cancelledCount, c.cancelled ?? 0);
    assert.equal(out.totauxCourants.giftCardRedeemedXpf, c.gift ?? 0n);
    if (c.tax !== undefined) assert.equal(Object.values(out.totauxCourants.parTaux).reduce((s, t) => s + t.tgcXpf, 0n), c.tax);
    if (after) { assert.equal(out.regularisation, c.cash); assert.equal(out.ecartZ, -c.cash); }
  });
}
test("6.2 signe impératif : 25000+10000, compté 35000, puis 2000 tardifs → 0 → -2000", () => {
  const facts = [sale(1, "known", 10000), sale(2, "late", 2000)];
  const c = closure();
  const before = project(facts, [c], 1n), after = project(facts, [c], 2n);
  assert.equal(before.ecartZ, 0n); assert.equal(after.totauxCourants.expectedXpf, 37000n);
  assert.equal(after.ecartCloture, 0n); assert.equal(after.regularisation, 2000n); assert.equal(after.ecartZ, -2000n);
  assert.equal(c.baselineExpectedXpf, 35000n); assert.equal(c.countedXpf, 35000n);
  assert.equal(after.regulariseLe?.toISOString(), facts[1].receivedAt.toISOString());
});
test("carte tardive change CA, pas l'écart ; remboursement tardif 200 augmente l'écart", () => {
  const a = sale(1, "a", 10000), b = sale(2, "b", 0, 2000), r = fact(3, "PARTIAL_REFUND_DONE", "r", { payments: [{ method: "CASH", amountXpf: "200" }] });
  assert.equal(project([a, b], [closure()]).ecartZ, 0n);
  assert.equal(project([a, b, r], [closure()]).ecartZ, 200n);
});
test("OFFLINE/IMPORT garde le théorique et repère aussi les faits reçus avant import mais absents du snapshot", () => {
  for (const closureMode of ["OFFLINE", "IMPORT"]) {
    const c = closure({ closureMode, cutoffRevision: 2n, legacySnapshot: { knownSourceRefs: ["SALE_PAID:a"] } });
    const out = project([sale(1, "a", 10000), sale(2, "b", 2000)], [c]);
    assert.equal(out.ecartCloture, 0n); assert.equal(out.ecartZ, -2000n);
    assert.equal(out.totauxCloture.expectedXpf, 35000n); assert.equal(out.remonteesApresCloture.length, 1);
  }
});
test("réouverture : même fond, nouveau comptage sur journée entière, Z précédent conservé", () => {
  const facts = [sale(1, "morning", 10000), fact(2, "REOPEN", "reopen", { cycle: 1, actorName: "Test" }), sale(3, "afternoon", 2000)];
  const first = closure(), recount = closure({ id: "recount", authoritative: false, countedXpf: 99999n });
  const second = closure({ id: "c1", cycle: 1, cutoffRevision: 3n, baselineExpectedXpf: 37000n, countedXpf: 37000n });
  const z = project(facts, [first, recount, second], 3n, 1);
  assert.equal(z.fond, 25000n); assert.equal(z.compte, 37000n); assert.equal(z.ecartZ, 0n);
  assert.equal(z.recomptages.length, 2); assert.equal(z.reouvertures.length, 1);
  assert.equal(first.countedXpf, 35000n);
});
test("mouvements 500 IN, 300 OUT ; pas de dépenses/acompte/stock dans le tiroir", () => {
  const facts = [fact(1, "MOVEMENT", "in", { kind: "CASH_IN", amountXpf: "500" }), fact(2, "MOVEMENT", "out", { kind: "CASH_OUT", amountXpf: "300" })];
  assert.equal(project(facts).totauxCourants.expectedXpf, 25200n);
  assert.throws(() => factDelta("DEPOSIT", { amountXpf: "500" }));
  assert.throws(() => factDelta("MOVEMENT", { kind: "REFUND", amountXpf: "200", refundActionId: "r" }));
});
test("combinaison deux appareils/alias et replay : 25000 + 400 + 1000 - 200 + 500 - 300 = 26400", () => {
  const facts = [sale(1, "mixed", 400, 600), sale(2, "cash", 1000, 0, 0, "B"), sale(3, "void", 1000), fact(4, "SALE_VOID", "void", { saleRef: "void" }),
    fact(5, "PARTIAL_REFUND_DONE", "refund", { payments: [{ method: "CASH", amountXpf: "200" }] }),
    fact(6, "MOVEMENT", "in", { kind: "CASH_IN", amountXpf: "500" }), fact(7, "MOVEMENT", "out", { kind: "CASH_OUT", amountXpf: "300" })];
  assert.equal(project([...facts, ...facts]).totauxCourants.expectedXpf, 26400n);
});
test("séquence et non heure métier : une heure égale/antérieure reste tardive après cutoff", () => {
  const a = sale(1, "a", 10000), b = { ...sale(2, "b", 2000), occurredAt: new Date("2026-10-14T14:00:00Z") };
  assert.equal(project([a, b], [closure()]).remonteesApresCloture[0].sourceRef, "b");
});
test("XPF BigInt exact au-delà du JS sûr, JSON canonique et dates Nouméa", () => {
  assert.equal(xpfInteger("9007199254740993"), 9007199254740993n); assert.throws(() => safeXpf(9007199254740993n));
  for (const v of [1.1, 100, "1.0", "-1", "9223372036854775808"]) assert.throws(() => xpfInteger(v));
  assert.equal(canonical({ z: 1n, a: "x" }), canonical({ a: "x", z: "1" }));
  assert.equal(businessDay(new Date("2026-10-14T13:00:00Z")), "2026-10-15");
  assert.throws(() => validDay("2026-02-30"));
});
test("snapshot incohérent/ref différent : refus sans calcul silencieux", () => {
  const f = sale(1, "a", 1000);
  assert.throws(() => project([{ ...f, cashDeltaXpf: 2000n }]));
  assert.throws(() => project([f, sale(2, "a", 2000)]));
});

test("correction CASH vers CARD : fait signé idempotent, CA inchangé et annulation cohérente", () => {
  const paid = sale(1, "corrected", 1000);
  const correction = fact(2, "PAYMENT_CORRECTION", "correction:out", { saleRef: "corrected",
    payments: [{ method: "CASH", amountXpf: "-1000" }, { method: "CARD", amountXpf: "1000" }] });
  assert.equal(project([paid], [], 1n).totauxCourants.expectedXpf, 26000n);
  const out = project([paid, correction, correction]).totauxCourants;
  assert.equal(out.expectedXpf, 25000n); assert.equal(out.totalSalesXpf, 1000n);
  assert.equal(out.byMethod.CASH, 0n); assert.equal(out.byMethod.CARD, 1000n);
  const cancelled = project([paid, correction, fact(3, "SALE_VOID", "corrected", { saleRef: "corrected" })]);
  assert.equal(cancelled.totauxCourants.expectedXpf, 25000n);
  assert.equal(cancelled.totauxCourants.totalSalesXpf, 0n);
});

test("négatif réservé au couple équilibré de PAYMENT_CORRECTION", () => {
  const payments = [{ method: "CASH", amountXpf: "-1000" }, { method: "CARD", amountXpf: "1000" }];
  assert.throws(() => factDelta("SALE_PAID", { totalXpf: "0", lines: [], parTaux: [], payments }));
  assert.throws(() => factDelta("PARTIAL_REFUND_DONE", { payments }));
  assert.throws(() => factDelta("MOVEMENT", { kind: "CASH_OUT", amountXpf: "-1000" }));
  for (const invalid of [
    { payments },
    { saleRef: "s", payments: [payments[0]] },
    { saleRef: "s", payments: [payments[0], { method: "CARD", amountXpf: "999" }] },
    { saleRef: "s", payments: [payments[0], { method: "CASH", amountXpf: "1000" }] },
    { saleRef: "s", payments: [{ method: "CARD", amountXpf: "1000" }, payments[0]] },
  ]) assert.throws(() => factDelta("PAYMENT_CORRECTION", invalid));
});

test("OFFLINE : vente connue du même jour séquencée après cutoff incluse dans les totaux de clôture", () => {
  // ÉCHOUE AUJOURD'HUI — défaut A (Mixy Truck, 2026-10-21), la décision sur le rapport figé appartient à Marco.
  const c = closure({ closureMode: "OFFLINE", cutoffRevision: 1n,
    legacySnapshot: { knownSourceRefs: ["SALE_PAID:a", "SALE_PAID:b"] } });
  const out = project([sale(1, "a", 10000), sale(2, "b", 2000, 0, 0, "B")], [c]);
  assert.equal(out.totauxCloture.totalSalesXpf, 12000n);
});

test("avoir carte 200 inclus dans le total des remboursements de clôture sans effet tiroir", () => {
  // ÉCHOUE AUJOURD'HUI — défaut B (Mixy Truck, 2026-10-21), la décision sur le rapport figé appartient à Marco.
  const facts = [sale(1, "refund-card", 0, 1000),
    fact(2, "PARTIAL_REFUND_DONE", "refund-card-action", { payments: [{ method: "CARD", amountXpf: "200" }] })];
  const out = project(facts, [closure({ cutoffRevision: 2n, countedXpf: 25000n, baselineExpectedXpf: 25000n })]);
  assert.equal(out.totauxCloture.expectedXpf, 25000n);
  assert.equal(out.totauxCloture.refundsXpf, 200n);
});
