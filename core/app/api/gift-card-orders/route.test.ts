// Contrat de la route /api/gift-card-orders — test STRUCTUREL (lit le source), même raison que
// lib/gift-card-routes.test.ts : le runner `node --test` ne peut pas exécuter un route handler.
// Exécution : node --test --experimental-strip-types "app/api/gift-card-orders/**/*.test.ts"

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "route.ts"), "utf8");
const body = (name: string) => {
  const s = src.indexOf(`export async function ${name}`);
  assert.ok(s > -1, `${name} introuvable`);
  const rest = src.slice(s);
  const e = rest.indexOf("\nexport ", 1);
  return e > -1 ? rest.slice(0, e) : rest;
};

test("401 sans clé de service (GET et POST)", () => {
  for (const m of ["GET", "POST"]) {
    assert.match(body(m), /if \(!hasServiceKey\(req\)\)[^\n]*status: 401/);
  }
});

test("400 : tenantId exigé (UUID) et validation par validateGiftCardOrder", () => {
  const post = body("POST");
  assert.match(post, /UUID_RE\.test\(tenantId\)/);
  assert.match(post, /validateGiftCardOrder\(body\)/);
  assert.match(post, /error: validated\.error \}, \{ status: 400 \}/);
});

test("201 { ok:true, order } à la création", () => {
  assert.match(body("POST"), /ok: true, order: serializeGiftCardOrder\(result\.order\) \}, \{ status: 201 \}/);
});

test("429 quand le moteur refuse (TOO_MANY_PENDING)", () => {
  assert.match(body("POST"), /status: 429/);
});

test("GET : take borné à 200, filtre de statut whitelisté, { ok:true, orders }", () => {
  const get = body("GET");
  assert.match(get, /Math\.min\(rawTake, 200\)/);
  assert.match(get, /STATUSES\.includes/);
  assert.match(get, /ok: true, orders:/);
});

test("runtime nodejs", () => assert.match(src, /export const runtime = "nodejs"/));
