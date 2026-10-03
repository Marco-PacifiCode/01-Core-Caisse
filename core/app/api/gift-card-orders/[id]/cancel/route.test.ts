// Contrat de POST /api/gift-card-orders/:id/cancel — test STRUCTUREL (lit le source + la couche base).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "route.ts"), "utf8");
const db = readFileSync(path.join(here, "..", "..", "..", "..", "..", "lib", "gift-card-orders-db.ts"), "utf8");

test("401 sans clé de service", () => {
  assert.match(src, /if \(!hasServiceKey\(req\)\)[^\n]*status: 401/);
});

test("400 : tenantId exigé", () => {
  assert.match(src, /tenantId requis" \}, \{ status: 400 \}/);
});

test("404 NOT_FOUND / 409 NOT_PENDING", () => {
  assert.match(src, /result\.error === "NOT_FOUND" \? 404 : 409/);
  assert.match(db, /"NOT_PENDING"/);
  assert.match(db, /"NOT_FOUND"/);
});

test("🔴 annulation = UPDATE conditionnel à status PENDING (pas de SELECT puis UPDATE)", () => {
  const s = db.indexOf("export async function cancelGiftCardOrder");
  const corps = db.slice(s);
  assert.match(corps, /updateMany\(\{\s*where: \{ id, tenantId, status: "PENDING" \}/);
  assert.ok(corps.indexOf("updateMany") < corps.indexOf("findFirst"), "l'UPDATE conditionnel doit précéder toute lecture");
});

test("200 { ok:true, order }", () => {
  assert.match(src, /ok: true, order: serializeGiftCardOrder\(result\.order\)/);
});
