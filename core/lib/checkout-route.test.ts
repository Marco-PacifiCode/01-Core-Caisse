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
