import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(path.join(core, file), "utf8");
const migrations = ["20261016093000_donnees_caisse_partagees", "20261016094000_caisse_journaliere_unique"];
test("migrations manuelles additives : RLS ENABLE/FORCE et USING/WITH CHECK robustes, FK tenant et RESTRICT", () => {
  const rls = read("prisma/rls.sql");
  const schema = read("prisma/schema.prisma");
  for (const name of migrations) {
    const sql = read(`prisma/migrations/${name}/migration.sql`);
    assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN)\b/i);
    assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/); assert.match(sql, /FORCE ROW LEVEL SECURITY/);
    assert.match(sql, /USING \("tenantId" = NULLIF\(current_setting\(''app.current_tenant'',true\),''''\)::uuid\)/);
    assert.match(sql, /WITH CHECK \("tenantId" = NULLIF/);
    for (const [, table] of sql.matchAll(/CREATE TABLE "([^"]+)"/g)) {
      assert.ok(rls.includes(`'${table}'`), `${table} dans rls.sql`);
      assert.ok(schema.includes(`model ${table} {`));
      assert.ok(sql.includes(`'${table}'`), `${table} dans boucle RLS`);
    }
    for (const fk of sql.matchAll(/FOREIGN KEY \(([^)]+)\) REFERENCES "([^"]+)" \(([^)]+)\) ON DELETE (\w+)/g)) {
      assert.ok(fk[1].startsWith('"tenantId",')); assert.ok(fk[3].startsWith('"tenantId",')); assert.equal(fk[4], "RESTRICT");
    }
    assert.doesNotMatch(sql, /"Poste"/);
  }
  const second = read(`prisma/migrations/${migrations[1]}/migration.sql`);
  assert.match(second, /"tenantId","cashDayId","cycle"\) WHERE "authoritative" = true/);
  for (const table of ["CashDayEvent", "CashDayClosure", "CashDayOpening", "CashDaySession"]) assert.ok(second.includes(`BEFORE UPDATE OR DELETE ON "${table}"`));
});
function routes(dir: string): string[] {
  return readdirSync(path.join(core, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? routes(path.join(dir, entry.name)) : entry.name === "route.ts" ? [path.join(dir, entry.name)] : []);
}
test("nouvelles routes : garde S2S voisine, no-store, Idempotency-Key et aucun accès Poste", () => {
  const helper = read("lib/cash-shared-http.ts");
  assert.match(helper, /if \(!hasServiceKey\(req\)\).*401/);
  assert.match(helper, /"Cache-Control": "no-store"/); assert.match(helper, /headers.get\("Idempotency-Key"\)/);
  const all = ["cash-days", "cash-settings", "parked-baskets", "pickup-orders"].flatMap(name => routes(`app/api/${name}`));
  assert.ok(all.length >= 15);
  for (const file of all) { const source = read(file); assert.match(source, /cashRead|cashWrite|cashHttp/); assert.doesNotMatch(source, /\.poste\.|lib\/postes/); }
  const ledger = read("lib/cash-day-ledger.ts");
  assert.match(ledger, /FOR UPDATE/); assert.match(ledger, /revision: \{ increment: 1n \}/);
  assert.doesNotMatch(ledger, /cashDayEvent\.update|cashDayClosure\.update|\.delete/);
});
test("clôture et finalisations financières : variante transactionnelle, aucun participant ni verrou réseau", () => {
  const manager = read("lib/cash-days.ts"), caisse = read("lib/caisse.ts"), refund = read("lib/partial-refund-db.ts");
  assert.match(manager, /closeSessionTx\(tx,/); assert.match(manager, /openSessionTx\(tx,/);
  assert.doesNotMatch(manager, /withTenant\(|participants|ping|45_?000|inscrirePoste/);
  assert.match(caisse, /await recordSharedSale\(tx,/); assert.match(caisse, /await consumePickupOrder\(tx,/);
  assert.match(refund, /status: "DONE"[\s\S]*deps.recordDrawer\(tx,/);
  assert.match(manager, /baselineExpectedXpf: closureMode === "ONLINE" \? expected : localExpectedXpf/);
  const settings = read("lib/cash-shared-data.ts");
  assert.match(settings, /revision: baseRevision/); assert.match(settings, /revision: revisionOf\(b.baseRevision\)/);
  assert.doesNotMatch(settings, /salePayment\.create|cashMovement\.create/);
});
