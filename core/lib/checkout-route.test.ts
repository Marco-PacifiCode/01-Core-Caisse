// Contrat de POST /api/sales/:id/checkout — volet VENTE À CRÉDIT (échéancier, lot A, 2026-09-15).
//
// La route importe lib/caisse.ts (Prisma) et next/server : non exécutable par ce runner
// (`node --test`, pas de DB/contexte Next) — même limite que void-route.test.ts et
// sale-read-route.test.ts. Le contrat HTTP est donc figé par lecture de source ; la décision PURE
// qu'il délègue (`checkoutUnderpaidGuard`, `parseDueAt`) est, elle, exécutée dans lib/credit.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const routeFile = path.join(libDir, "..", "app", "api", "sales", "[id]", "checkout", "route.ts");

function readRoute(): string {
  assert.ok(existsSync(routeFile), `introuvable : ${routeFile}`);
  return readFileSync(routeFile, "utf8");
}

test("la route valide credit.dueAt AVANT tout encaissement (400, même style que paidAt)", () => {
  const body = readRoute();
  assert.match(body, /parseDueAt\(body\.credit\.dueAt\)/);
  assert.match(body, /credit\.dueAt invalide/);
});

test("la route mappe CREDIT_NOT_NEEDED sur 409 et CREDIT_NEEDS_DEPOSIT sur 422", () => {
  const body = readRoute();
  assert.match(body, /CREDIT_NOT_NEEDED:\s*409/);
  assert.match(body, /CREDIT_NEEDS_DEPOSIT:\s*422/);
});

test("SANS credit dans le body, options ne porte pas la clé `credit` (comportement inchangé)", () => {
  const body = readRoute();
  assert.match(body, /giftCards \|\| paidAt \|\| redeemGiftCards \|\| credit/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// Fidélité (lot C2) — câblage manquant, correctif QA du 2026-09-16 : la route ne transmettait
// ni `loyalty` ni `redeemLoyalty` à `checkoutSale`, aucune route HTTP n'atteignait donc le
// moteur de fidélité (S2 inopérant côté surface). Contrat figé ici par lecture de source, même
// limite que les tests `credit`/`paidAt` ci-dessus (route non exécutable hors contexte Next).
// ══════════════════════════════════════════════════════════════════════════════════════════

test("loyalty.clientFicheId doit être un UUID valide (400 sinon, AVANT tout encaissement)", () => {
  const body = readRoute();
  assert.match(body, /UUID_RE\.test\(clientFicheId\)/);
  assert.match(body, /loyalty\.clientFicheId invalide/);
});

test("loyalty.displayName requis, non vide, borné à 200 caractères (400 sinon)", () => {
  const body = readRoute();
  assert.match(body, /displayName\.length > 200/);
  assert.match(body, /loyalty\.displayName requis/);
});

test("redeemLoyalty.rewardEntryId doit être un UUID valide (400 sinon)", () => {
  const body = readRoute();
  assert.match(body, /UUID_RE\.test\(rewardEntryId\)/);
  assert.match(body, /redeemLoyalty\.rewardEntryId invalide/);
});

test("forme valide : `loyalty` et `redeemLoyalty` sont bien transmis dans `options` à checkoutSale", () => {
  const body = readRoute();
  // La clé options est calculée avant l'appel checkoutSale(...) et inclut loyalty/redeemLoyalty
  // dès que l'un des deux est présent — même discipline que giftCards/credit ci-dessus.
  assert.match(body, /giftCards \|\| paidAt \|\| redeemGiftCards \|\| credit \|\| loyalty \|\| redeemLoyalty/);
  assert.match(body, /\.\.\.\(loyalty \? \{ loyalty \} : \{\}\)/);
  assert.match(body, /\.\.\.\(redeemLoyalty \? \{ redeemLoyalty \} : \{\}\)/);
  assert.match(body, /const result = await checkoutSale\(tenantId, saleId, parsed, options\);/);
});

test("les erreurs de fidélité renvoyées par checkoutSale sont mappées sur 409 (conflit d'état, pas requête malformée)", () => {
  const body = readRoute();
  assert.match(body, /LOYALTY_NOT_REDEEMABLE:\s*409/);
  assert.match(body, /LOYALTY_AMOUNT_MISMATCH:\s*409/);
  assert.match(body, /LOYALTY_ACCOUNT_MISMATCH:\s*409/);
});
