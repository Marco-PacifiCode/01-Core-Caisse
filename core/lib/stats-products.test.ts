import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePeriod, totalsByProduct } from "./stats-products.ts";

test("période : jours Nouméa inclus, bornes UTC décalées de 11 h", () => {
  const p = parsePeriod("2026-03-01", "2026-03-31");
  assert.ok(!("error" in p));
  assert.equal(p.startUtc.toISOString(), "2026-02-28T13:00:00.000Z");
  assert.equal(p.endUtc.toISOString(), "2026-03-31T13:00:00.000Z");
});

test("période : from/to obligatoires et valides, to >= from", () => {
  for (const [f, t] of [[null, "2026-01-01"], ["2026-01-01", null], ["2026-02-30", "2026-03-01"], ["x", "y"], ["2026-03-02", "2026-03-01"]] as const)
    assert.ok("error" in parsePeriod(f, t), `${f} ${t}`);
});

test("période : 13 mois acceptés, au-delà refusé", () => {
  assert.ok(!("error" in parsePeriod("2025-01-01", "2026-01-31")));
  assert.ok("error" in parsePeriod("2025-01-01", "2026-02-01"));
  assert.ok("error" in parsePeriod("2020-01-01", "2026-01-01"));
});

test("totaux par produit sur toute la période, qty décroissante", () => {
  const t = totalsByProduct([
    { month: "2026-01", productId: "a", label: "A", qty: 2, amountXpf: 200n },
    { month: "2026-01", productId: "b", label: "B", qty: 5, amountXpf: 50n },
    { month: "2026-02", productId: "a", label: "A", qty: 4, amountXpf: 400n },
  ]);
  assert.deepEqual(t.map(x => [x.productId, x.qty, x.amountXpf]), [["a", 6, 600n], ["b", 5, 50n]]);
});

test("route : clé de service, withTenant, xpf() sur les montants", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "api", "stats", "products", "route.ts"), "utf8");
  assert.match(src, /hasServiceKey\(req\)/);
  assert.match(src, /withTenant\(\s*tenantId/);
  assert.match(src, /horsPortee\(req, tenantId\)/);
  assert.match(src, /amountXpf:\s*xpf\(r\.amountXpf\)/);
});
