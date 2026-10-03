// Ordre des contrôles du chemin « commande de bon en ligne » du checkout (structurel).
//   (i)   pré-contrôle de la commande (findMany + AMOUNT_MISMATCH) AVANT tout salePayment.create ;
//   (ii)  dans la boucle d'émission, l'updateMany de la commande précède la création du bon ;
//   (iii) la route checkout mappe GIFT_CARD_ORDER_AMOUNT_MISMATCH sur 409 ;
//   (iv)  la route gift-card-orders n'accepte qu'un `take` entier.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function checkoutFn(): string {
  const s = src("lib/caisse.ts");
  const a = s.indexOf("export async function checkoutSale(");
  assert.ok(a >= 0, "checkoutSale introuvable");
  const b = s.indexOf("\nexport ", a + 10);
  return s.slice(a, b < 0 ? undefined : b);
}

test("(i) pré-contrôle des commandes avant tout salePayment.create", () => {
  const fn = checkoutFn();
  const pay = fn.indexOf("salePayment.create");
  const mismatch = fn.indexOf("GIFT_CARD_ORDER_AMOUNT_MISMATCH");
  const find = fn.indexOf("tx.giftCardOrder.findMany(");
  assert.ok(pay > 0, "salePayment.create attendu");
  assert.ok(mismatch > 0 && mismatch < pay, "AMOUNT_MISMATCH doit précéder salePayment.create");
  assert.ok(find > 0 && find < pay, "findMany du pré-contrôle doit précéder salePayment.create");
});

test("(ii) branche orderId : updateMany de la commande avant tx.giftCard.create", () => {
  const fn = checkoutFn();
  const loop = fn.indexOf("for (const g of giftCardsToIssue)");
  assert.ok(loop > 0, "boucle d'émission attendue");
  const branch = fn.indexOf("if (g.orderId) {", loop);
  assert.ok(branch > 0, "branche orderId attendue dans la boucle");
  const upd = fn.indexOf("tx.giftCardOrder.updateMany(", branch);
  const create = fn.indexOf("tx.giftCard.create(", branch);
  assert.ok(upd > 0 && create > 0 && upd < create, "updateMany doit précéder tx.giftCard.create");
  assert.ok(fn.indexOf("id: newId", upd) > 0, "le bon doit être créé avec l'id tiré d'avance");
});

test("(iii) route checkout : GIFT_CARD_ORDER_AMOUNT_MISMATCH → 409", () => {
  assert.match(src("app/api/sales/[id]/checkout/route.ts"), /GIFT_CARD_ORDER_AMOUNT_MISMATCH:\s*409\b/);
});

test("(iv) route gift-card-orders : take entier uniquement", () => {
  assert.match(src("app/api/gift-card-orders/route.ts"), /Number\.isInteger\(rawTake\)/);
});
