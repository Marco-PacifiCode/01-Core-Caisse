// Contrat de GET /api/gift-card-orders/:id — test STRUCTUREL (lit le source).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "route.ts"), "utf8");

test("401 sans clé de service", () => {
  assert.match(src, /if \(!hasServiceKey\(req\)\)[^\n]*status: 401/);
});

test("params en Promise (Next 16)", () => {
  assert.match(src, /params: Promise<\{ id: string \}>/);
  assert.match(src, /await ctx\.params/);
});

test("400 : tenantId exigé", () => {
  assert.match(src, /tenantId requis" \}, \{ status: 400 \}/);
});

test("404 si commande absente (lecture cloisonnée par tenant)", () => {
  assert.match(src, /getGiftCardOrder\(tenantId, id\)/);
  assert.match(src, /if \(!order\)[^\n]*NOT_FOUND[^\n]*status: 404/);
});

test("200 { ok:true, order }", () => {
  assert.match(src, /ok: true, order: serializeGiftCardOrder\(order\)/);
});
