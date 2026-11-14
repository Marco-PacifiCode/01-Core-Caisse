// Démo privée (11/11) : vérifications Core-Auth, clé dédiée, jeu, plan du semis, et contrôles
// STATIQUES de la migration 20261111130000_tenant_maquette (couverture des tables, DELETE bornés,
// seuls les 4 déclencheurs l4 désactivés, caisse_l4_immutable intacte).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { NextRequest } from "next/server";
import { hasServiceKey } from "./service-auth.ts";
import { identifierCle, reinitialiserClesService } from "./cles-service.ts";
import {
  HOTE_DEMO, checkCleMaquette, codeMaquette, estVerrouOccupe, jourMetier, lireMaquette, planifierSemis, statutRefus,
  validerCorpsSemer, verifierPourEffacer, verifierPourSemer, type Jeu,
} from "./maquette.ts";
import { pendingSalesWhere } from "./repair-policy.ts";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const T = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const MAINTENANT = new Date("2026-11-11T00:00:00.000Z");
const FUTUR = "2026-12-11T00:00:00.000Z";
const PASSE = "2026-10-01T00:00:00.000Z";

function coreAuth(corps: unknown, statut = 200): typeof fetch {
  return (async () => new Response(typeof corps === "string" ? corps : JSON.stringify(corps), { status: statut })) as typeof fetch;
}
const deps = (f: typeof fetch) => ({ fetchImpl: f, env: { CORE_AUTH_URL: "http://auth.invalid" }, maintenant: () => MAINTENANT });
const maquette = (hote: string, expiresAt: string, id = T) => ({ id, slug: "x", maquette: { hote, emblemeUrl: null, siteUrl: null, expiresAt } });

// ── Vérifications Core-Auth ──────────────────────────────────────────────────────────────────────

test("semer : maquette non échue sur demo-*.pacificode.nc → ok ; id comparé sans casse", async () => {
  const v = await verifierPourSemer(T, deps(coreAuth(maquette("demo-salon.pacificode.nc", FUTUR, T.toUpperCase()))));
  assert.equal(v.ok, true);
});

test("refus : tenant non maquette, échéances dans le mauvais sens", async () => {
  assert.deepEqual(await verifierPourSemer(T, deps(coreAuth({ id: T, slug: "vrai" }))), { ok: false, refus: "NON_MAQUETTE" });
  assert.deepEqual(await verifierPourEffacer(T, deps(coreAuth({ id: T, maquette: null }))), { ok: false, refus: "NON_MAQUETTE" });
  assert.deepEqual(await verifierPourSemer(T, deps(coreAuth(maquette("demo-a.pacificode.nc", PASSE)))), { ok: false, refus: "EXPIREE" });
  assert.deepEqual(await verifierPourEffacer(T, deps(coreAuth(maquette("demo-a.pacificode.nc", FUTUR)))), { ok: false, refus: "PAS_ENCORE_EXPIREE" });
  assert.equal((await verifierPourEffacer(T, deps(coreAuth(maquette("demo-a.pacificode.nc", PASSE))))).ok, true);
});

test("refus : hôtes non conformes", async () => {
  for (const hote of ["evil.example.com", "demo-x.pacificode.nc.evil.com", "salon.pacificode.nc", "DEMO-x.pacificode.nc", "demo-.pacificode.nc.x"]) {
    assert.deepEqual(await verifierPourSemer(T, deps(coreAuth(maquette(hote, FUTUR)))), { ok: false, refus: "HOTE_NON_CONFORME" }, hote);
    assert.deepEqual(await verifierPourEffacer(T, deps(coreAuth(maquette(hote, PASSE)))), { ok: false, refus: "HOTE_NON_CONFORME" }, hote);
  }
  assert.ok(HOTE_DEMO.test("demo-rotisserie-2.pacificode.nc"));
});

test("Core-Auth en échec sous toutes ses formes → STADE_INCONNU (503), rien n'est fait", async () => {
  const echecs: Array<[string, typeof fetch]> = [
    ["réseau", (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch],
    ["500", coreAuth({ error: "x" }, 500)],
    ["404", coreAuth({ error: "x" }, 404)],
    ["401", coreAuth({ error: "x" }, 401)],
    ["JSON illisible", coreAuth("<html>")],
    ["null", coreAuth("null")],
    ["autre tenant", coreAuth(maquette("demo-a.pacificode.nc", FUTUR, "00000000-0000-0000-0000-000000000009"))],
    ["sans id", coreAuth({ maquette: { hote: "demo-a.pacificode.nc", expiresAt: FUTUR } })],
    ["maquette mal formée", coreAuth({ id: T, maquette: { hote: 3, expiresAt: FUTUR } })],
    ["échéance illisible", coreAuth({ id: T, maquette: { hote: "demo-a.pacificode.nc", expiresAt: "demain" } })],
    ["maquette non objet", coreAuth({ id: T, maquette: "oui" })],
  ];
  for (const [nom, f] of echecs) {
    for (const v of [await verifierPourSemer(T, deps(f)), await verifierPourEffacer(T, deps(f))]) {
      assert.deepEqual(v, { ok: false, refus: "STADE_INCONNU" }, nom);
    }
  }
  assert.equal(statutRefus("STADE_INCONNU", "semer"), 503);
  assert.equal(statutRefus("PAS_ENCORE_EXPIREE", "effacer"), 409);
  assert.equal(statutRefus("NON_MAQUETTE", "effacer"), 403);
  await assert.rejects(lireMaquette("pas-un-uuid", deps(coreAuth({}))), /MAQUETTE_TENANT_INVALIDE/);
});

test("lireMaquette appelle la projection publique SANS clé", async () => {
  let vu: { url: string; init?: RequestInit } | null = null;
  const f = (async (url: string, init?: RequestInit) => { vu = { url, init }; return new Response(JSON.stringify(maquette("demo-a.pacificode.nc", FUTUR))); }) as unknown as typeof fetch;
  await lireMaquette(T, deps(f));
  assert.equal(vu!.url, `http://auth.invalid/api/tenant?tenantId=${T}`);
  assert.equal(new Headers(vu!.init?.headers).get("x-core-key"), null);
});

// ── Clés ─────────────────────────────────────────────────────────────────────────────────────────

const ENV_NOMS = ["MAQUETTE_API_KEY", "CORE_CAISSE_API_KEY", "SERVICE_KEYS_JSON", "SERVICE_KEY_LEGACY_OK"] as const;
let sauvegarde: Array<string | undefined> = [];
beforeEach(() => { sauvegarde = ENV_NOMS.map((n) => process.env[n]); for (const n of ENV_NOMS) delete process.env[n]; reinitialiserClesService(); });
afterEach(() => { ENV_NOMS.forEach((n, i) => { if (sauvegarde[i] === undefined) delete process.env[n]; else process.env[n] = sauvegarde[i]; }); reinitialiserClesService(); });
const req = (cle: string | null, chemin = "/api/maquette/semer") =>
  ({ headers: new Headers(cle === null ? {} : { "x-core-key": cle }), url: `http://service.invalid${chemin}` }) as unknown as NextRequest;
const empreinte = (c: string) => createHash("sha256").update(c).digest("hex");

test("clé maquette : absente → 401 ; égale à une clé générale → 401 ; clé générale → 401 ; bonne → ok", () => {
  process.env.CORE_CAISSE_API_KEY = "factice-generale-01234567890123456789";
  process.env.SERVICE_KEYS_JSON = JSON.stringify({ A: { sha256: empreinte("factice-nominative-01234567890123456789"), tenants: [T] } });
  assert.deepEqual(checkCleMaquette(req("factice-generale-01234567890123456789")), { ok: false, status: 401 });
  process.env.MAQUETTE_API_KEY = "factice-generale-01234567890123456789";
  assert.deepEqual(checkCleMaquette(req("factice-generale-01234567890123456789")), { ok: false, status: 401 });
  process.env.MAQUETTE_API_KEY = "factice-nominative-01234567890123456789";
  assert.deepEqual(checkCleMaquette(req("factice-nominative-01234567890123456789")), { ok: false, status: 401 });
  process.env.MAQUETTE_API_KEY = "factice-maquette-01234567890123456789";
  assert.deepEqual(checkCleMaquette(req("factice-generale-01234567890123456789")), { ok: false, status: 401 });
  assert.deepEqual(checkCleMaquette(req("factice-nominative-01234567890123456789")), { ok: false, status: 401 });
  assert.deepEqual(checkCleMaquette(req(null)), { ok: false, status: 401 });
  assert.deepEqual(checkCleMaquette(req("factice-maquettE")), { ok: false, status: 401 });
  assert.deepEqual(checkCleMaquette(req("factice-maquette-01234567890123456789")), { ok: true });
});

test("clé maquette REFUSÉE par le contrôle général et la lecture nominative", () => {
  process.env.CORE_CAISSE_API_KEY = "factice-generale-01234567890123456789";
  process.env.MAQUETTE_API_KEY = "factice-maquette-01234567890123456789";
  // Même déclarée par erreur comme clé historique ou nominative, elle ne passe pas… sauf collision,
  // auquel cas elle n'est plus une clé maquette (401 sur /api/maquette/*) et reste une clé générale.
  assert.equal(hasServiceKey(req("factice-maquette-01234567890123456789", "/api/sales")), false);
  assert.equal(identifierCle("factice-maquette-01234567890123456789"), null);
  assert.equal(hasServiceKey(req("factice-generale-01234567890123456789", "/api/sales")), true, "un vrai appelant n'est pas touché");
  process.env.SERVICE_KEYS_JSON = JSON.stringify({ A: { sha256: empreinte("factice-nominative-01234567890123456789"), tenants: [T] } });
  assert.deepEqual(identifierCle("factice-nominative-01234567890123456789"), { nom: "A", tenants: [T] });
  assert.equal(hasServiceKey(req("factice-maquette-01234567890123456789", "/api/sales")), false);
});

test("collision de configuration : la clé générale garde ses droits, la maquette n'ouvre rien", () => {
  process.env.CORE_CAISSE_API_KEY = "factice-generale-01234567890123456789";
  process.env.MAQUETTE_API_KEY = "factice-generale-01234567890123456789";
  assert.equal(hasServiceKey(req("factice-generale-01234567890123456789", "/api/sales")), true);
  assert.deepEqual(checkCleMaquette(req("factice-generale-01234567890123456789")), { ok: false, status: 401 });
});

// ── Jeu ──────────────────────────────────────────────────────────────────────────────────────────

const JEU = { articles: [{ nom: "Poulet rôti", prix: 1800, tgc: 11 }, { nom: "Frites", prix: 500, tgc: 11 }, { nom: "Boisson", prix: 300, tgc: 22 }], ticketsParJour: { min: 3, max: 8 } };

test("jeu valide (jours par défaut 30), tenantId normalisé", () => {
  const r = validerCorpsSemer({ tenantId: T.toUpperCase(), jeu: JEU });
  assert.ok(r.ok);
  assert.equal(r.valeur.tenantId, T);
  assert.equal(r.valeur.jeu.jours, 30);
});

test("jeu hors bornes ou champ inconnu → 400", () => {
  const ko: unknown[] = [
    null, [], { tenantId: T }, { tenantId: "x", jeu: JEU }, { tenantId: T, jeu: JEU, autre: 1 },
    { tenantId: T, jeu: { ...JEU, inconnu: true } },
    { tenantId: T, jeu: { ...JEU, articles: [] } },
    { tenantId: T, jeu: { ...JEU, articles: Array.from({ length: 61 }, () => JEU.articles[0]) } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "", prix: 1, tgc: 0 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "x".repeat(81), prix: 1, tgc: 0 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "a", prix: 0, tgc: 0 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "a", prix: 10_000_001, tgc: 0 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "a", prix: 99.5, tgc: 0 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "a", prix: "100", tgc: 0 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "a", prix: 100, tgc: 31 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "a", prix: 100, tgc: -1 }] } },
    { tenantId: T, jeu: { ...JEU, articles: [{ nom: "a", prix: 100, tgc: 0, stock: 1 }] } },
    { tenantId: T, jeu: { ...JEU, ticketsParJour: { min: -1, max: 2 } } },
    { tenantId: T, jeu: { ...JEU, ticketsParJour: { min: 5, max: 4 } } },
    { tenantId: T, jeu: { ...JEU, ticketsParJour: { min: 0, max: 41 } } },
    { tenantId: T, jeu: { ...JEU, ticketsParJour: { min: 0, max: 4, x: 1 } } },
    { tenantId: T, jeu: { ...JEU, jours: 0 } },
    { tenantId: T, jeu: { ...JEU, jours: 31 } },
  ];
  for (const corps of ko) assert.equal(validerCorpsSemer(corps).ok, false, JSON.stringify(corps));
});

// ── Plan du semis ────────────────────────────────────────────────────────────────────────────────

test("plan : déterministe (graine = tenantId), aujourd'hui exclu, bornes respectées, XPF entiers", () => {
  const jeu: Jeu = { ...JEU, jours: 30 };
  const maintenant = new Date("2026-11-11T05:00:00.000Z");
  const a = planifierSemis(jeu, T, maintenant);
  assert.deepEqual(planifierSemis(jeu, T.toUpperCase(), maintenant), a);
  assert.notDeepEqual(planifierSemis(jeu, "00000000-0000-4000-8000-000000000001", maintenant), a);
  assert.equal(a.length, 30);
  assert.equal(a.at(-1)!.businessDay, "2026-11-10");
  assert.equal(a[0].businessDay, "2026-10-12");
  const aujourdhui = jourMetier(maintenant);
  for (const j of a) {
    assert.notEqual(j.businessDay, aujourdhui);
    assert.ok(j.tickets.length >= 3 && j.tickets.length <= 8);
    assert.equal(jourMetier(j.ouverture), j.businessDay);
    assert.equal(jourMetier(j.cloture), j.businessDay);
    for (const t of j.tickets) {
      assert.equal(jourMetier(t.a), j.businessDay);
      assert.ok(t.a > j.ouverture && t.a < j.cloture);
      assert.ok(t.lignes.length >= 1 && t.lignes.length <= 3);
      assert.ok(Number.isSafeInteger(t.totalXpf) && t.totalXpf > 0);
      assert.equal(t.totalXpf, t.lignes.reduce((s, l) => s + l.unitXpf * l.qty, 0));
      assert.ok(["CASH", "CARD"].includes(t.moyen));
    }
  }
  assert.equal(planifierSemis({ ...jeu, ticketsParJour: { min: 0, max: 0 }, jours: 2 }, T, maintenant).flatMap((j) => j.tickets).length, 0);
});

test("codes d'erreur de la base", () => {
  assert.equal(codeMaquette(new Error("ERROR: MAQUETTE_FAIT_ANTERIEUR : tenant x")), "MAQUETTE_FAIT_ANTERIEUR");
  assert.equal(codeMaquette(new Error("autre")), null);
  assert.equal(estVerrouOccupe(new Error("canceling statement due to lock timeout")), true);
  assert.equal(estVerrouOccupe({ message: "Raw query failed. Code: `55P03`" }), true);
  assert.equal(estVerrouOccupe(new Error("IMMUTABLE_CASH_FACT")), false);
});

// ── Exclusion (point D) : les ventes semées ne partent jamais vers Compta/Stock ───────────────────

test("ventes semées : comptaSyncedAt ET stockSyncedAt posés, aucun appel sortant, hors file de reprise", () => {
  const src = readFileSync(path.join(ICI, "maquette-semis.ts"), "utf8").split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.match(src, /comptaSyncedAt: new Date\(\), stockSyncedAt: new Date\(\)/);
  assert.match(src, /kind: "SERVICE"/, "aucune ligne PRODUCT (rien à décrémenter dans Core-Stock)");
  for (const interdit of [/checkoutSale/, /comptaClient|stockClient|paiementClient|commsClient/, /fetch\(/, /from "\.\/(sync|compta|stock|clients?)"/]) {
    assert.doesNotMatch(src, interdit);
  }
  // La file de reprise ne prend QUE les ventes PAID dont une des deux dates est nulle.
  const filtre = JSON.stringify(pendingSalesWhere());
  assert.ok(filtre.includes('"OR":[{"comptaSyncedAt":null},{"stockSyncedAt":null}]'), filtre);
});

// ── Contrôles statiques de la migration ──────────────────────────────────────────────────────────

const MIGRATIONS = path.join(ICI, "..", "prisma", "migrations");
const SQL = readFileSync(path.join(MIGRATIONS, "20261111130000_tenant_maquette", "migration.sql"), "utf8");
const corpsEffacer = () => {
  const debut = SQL.indexOf("CREATE OR REPLACE FUNCTION effacer_tenant_maquette");
  return SQL.slice(debut, SQL.indexOf("$fn$;", debut));
};
const entre = (texte: string, balise: string) => texte.slice(texte.indexOf(`-- BEGIN:${balise}`), texte.indexOf(`-- END:${balise}`));

test("effacement : chaque DELETE est borné par \"tenantId\" = p_tenant", () => {
  const corps = corpsEffacer();
  const deletes = corps.match(/DELETE\s+FROM[^;]*;/gi) ?? [];
  assert.ok(deletes.length >= 26);
  for (const d of deletes) assert.match(d, /^DELETE FROM "[A-Za-z]+" WHERE "tenantId" = p_tenant;$/, d);
  for (const u of corps.match(/UPDATE\s+[^;]*;/gi) ?? []) assert.match(u, /WHERE "tenantId" = p_tenant\b/, u);
  assert.doesNotMatch(corps, /TRUNCATE/i);
});

test("effacement : seuls les 4 déclencheurs l4 sont désactivés, et tous réactivés", () => {
  const corps = corpsEffacer();
  const attendus = ["CashDayEvent cash_event_immutable", "CashDayClosure cash_closure_immutable", "CashDayOpening cash_opening_immutable", "CashDaySession cash_alias_immutable"];
  const desactives = [...corps.matchAll(/ALTER TABLE "(\w+)" DISABLE TRIGGER (\w+);/g)].map((m) => `${m[1]} ${m[2]}`);
  const reactives = [...corps.matchAll(/ALTER TABLE "(\w+)" ENABLE TRIGGER (\w+);/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(desactives, attendus);
  assert.deepEqual(reactives, attendus);
  assert.equal((corps.match(/DISABLE TRIGGER/g) ?? []).length, 4, "aucun DISABLE TRIGGER ALL/USER");
  assert.doesNotMatch(corps, /session_replication_role/);
  // Les 4 verrous de table pris d'un coup, sans attente, AVANT le premier ALTER.
  const lock = corps.indexOf('LOCK TABLE "CashDayEvent", "CashDayClosure", "CashDayOpening", "CashDaySession" IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
  assert.ok(lock > 0 && lock < corps.indexOf("ALTER TABLE"), "LOCK … NOWAIT avant tout ALTER");
  // lock_timeout / statement_timeout posés AVANT le premier ALTER.
  const premierAlter = corps.indexOf("ALTER TABLE");
  assert.ok(corps.indexOf("set_config('lock_timeout', '500ms', true)") > 0 && corps.indexOf("set_config('lock_timeout', '500ms', true)") < premierAlter);
  assert.ok(corps.indexOf("set_config('statement_timeout', '30s', true)") > 0 && corps.indexOf("set_config('statement_timeout', '30s', true)") < premierAlter);
  // Le contexte du tenant est posé avant les contrôles.
  assert.ok(corps.indexOf("set_config('app.current_tenant', p_tenant::text, true)") < corps.indexOf("FROM \"TenantMaquette\""));
});

test("effacement : couvre TOUTES les tables de schema.prisma portant tenantId (un oubli casse ce test)", () => {
  const schema = readFileSync(path.join(ICI, "..", "prisma", "schema.prisma"), "utf8");
  const avecTenant = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .filter((m) => /^\s+tenantId\s/m.test(m[2])).map((m) => m[1]).filter((n) => n !== "TenantMaquette").sort();
  const corps = corpsEffacer();
  const effacees = [...entre(corps, "effacement").matchAll(/DELETE FROM "(\w+)"/g)].map((m) => m[1]);
  const comptees = [...entre(corps, "tables").matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...effacees].sort(), avecTenant);
  assert.deepEqual([...comptees].sort(), avecTenant);
  assert.deepEqual(comptees, effacees, "comptage et effacement dans le même ordre");
  // Inscription : refus sur la MOINDRE ligne de n'importe quelle table portant tenantId.
  const debutInscr = SQL.indexOf("CREATE OR REPLACE FUNCTION inscrire_tenant_maquette");
  const inscription = [...entre(SQL.slice(debutInscr, SQL.indexOf("$fn$;", debutInscr)), "inscription").matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...inscription].sort(), avecTenant, "inscription : toutes les tables portant tenantId");
  // Enfants avant parents.
  const avant = (a: string, b: string) => assert.ok(effacees.indexOf(a) < effacees.indexOf(b), `${a} avant ${b}`);
  for (const [a, b] of [["CashDayEvent", "Sale"], ["CashDayEvent", "PartialRefund"], ["CashDayEvent", "CashDay"], ["CashDayClosure", "CashSession"],
    ["CashDayOpening", "CashSession"], ["CashDaySession", "CashDay"], ["PartialRefund", "Sale"], ["SaleLine", "Sale"], ["SalePayment", "Sale"],
    ["Sale", "CashDay"], ["Sale", "CashSession"], ["Sale", "PickupOrder"], ["CashMovement", "CashSession"], ["CashSessionReopen", "CashSession"],
    ["CashDay", "CashSession"], ["LoyaltyEntry", "LoyaltyAccount"]]) avant(a, b);
  // Le registre n'est retiré qu'APRÈS l'effacement et la réactivation.
  assert.ok(corps.indexOf('DELETE FROM "TenantMaquette"') > corps.indexOf("-- END:reactivation"));
});

test("cron de reprise : sélection, neutralisations et compteur excluent les maquettes", () => {
  const src = readFileSync(path.join(ICI, "repair-sweep.ts"), "utf8");
  assert.match(src, /where: sansMaquettes\(pendingSalesWhere\(\), maquettes\)/);
  assert.match(src, /where: sansMaquettes\(\{ status: "VOID".*\}, maquettes\)/);
  assert.match(src, /count\(\{ where: sansMaquettes\(stuckSalesWhere\(\), maquettes\) \}\)/);
  assert.equal((src.match(/cronPrisma\.sale\.(findMany|count)\(/g) ?? []).length, 3, "aucune autre requête multi-tenant non filtrée");
  // Lecture du registre en échec : l'erreur remonte (pas de try/catch qui garderait tout).
  assert.match(src, /const maquettes = await tenantsMaquette\(cronPrisma\);/);
  assert.doesNotMatch(src.slice(src.indexOf("sweepPendingSales"), src.indexOf("tenantsMaquette(cronPrisma)") + 40), /catch/);
  assert.match(SQL, /GRANT SELECT ON "TenantMaquette" TO core_caisse_cron;/);
  assert.doesNotMatch(SQL, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO core_caisse_cron/);
});

test("inscription : refus si ventes, remboursements ou faits l4 ; aucun droit d'écriture direct", () => {
  const debut = SQL.indexOf("CREATE OR REPLACE FUNCTION inscrire_tenant_maquette");
  const corps = SQL.slice(debut, SQL.indexOf("$fn$;", debut));
  assert.match(corps, /SECURITY DEFINER/);
  assert.match(corps, /MAQUETTE_INSCRIPTION_REFUSEE/);
  assert.match(SQL, /REVOKE ALL ON "TenantMaquette" FROM core_caisse_app;\s*GRANT SELECT ON "TenantMaquette" TO core_caisse_app;/);
  assert.doesNotMatch(SQL, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*"TenantMaquette"/);
  for (const f of ["inscrire_tenant_maquette", "effacer_tenant_maquette"]) {
    assert.match(SQL, new RegExp(`REVOKE ALL ON FUNCTION ${f}\\(uuid\\) FROM PUBLIC;`));
    assert.doesNotMatch(SQL, new RegExp(`GRANT EXECUTE ON FUNCTION ${f}\\(uuid\\) TO PUBLIC`));
  }
});

// Définition FIGÉE (copie à l'octet des lignes 61-65 de la migration 20261016094000).
const L4_FIGE = [
  "CREATE FUNCTION caisse_l4_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_CASH_FACT'; END $$;",
  'CREATE TRIGGER cash_event_immutable BEFORE UPDATE OR DELETE ON "CashDayEvent" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();',
  'CREATE TRIGGER cash_closure_immutable BEFORE UPDATE OR DELETE ON "CashDayClosure" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();',
  'CREATE TRIGGER cash_opening_immutable BEFORE UPDATE OR DELETE ON "CashDayOpening" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();',
  'CREATE TRIGGER cash_alias_immutable BEFORE UPDATE OR DELETE ON "CashDaySession" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();',
];

test("caisse_l4_immutable et ses 4 déclencheurs : identiques à l'octet, définis UNE seule fois", () => {
  const origine = readFileSync(path.join(MIGRATIONS, "20261016094000_caisse_journaliere_unique", "migration.sql"), "utf8").split(/\r?\n/);
  assert.deepEqual(origine.slice(60, 65), L4_FIGE);
  const fichiers = [
    ...readdirSync(MIGRATIONS).filter((d) => d !== "20261016094000_caisse_journaliere_unique" && !d.endsWith(".toml"))
      .map((d) => path.join(MIGRATIONS, d, "migration.sql")),
    path.join(ICI, "..", "prisma", "rls.sql"),
  ];
  for (const f of fichiers) {
    const sql = readFileSync(f, "utf8");
    assert.doesNotMatch(sql, /(CREATE|REPLACE|DROP|ALTER)\s+(OR\s+REPLACE\s+)?FUNCTION\s+caisse_l4_immutable/i, f);
    assert.doesNotMatch(sql, /(CREATE|DROP)\s+TRIGGER\s+(IF\s+EXISTS\s+)?cash_\w+_immutable/i, f);
    assert.doesNotMatch(sql, /ALTER\s+TRIGGER\s+cash_\w+_immutable/i, f);
  }
});

// SABOTAGE : enlever le contrôle collision/courte → refus ou journal exact ci-dessous en échec.
test("configuration maquette : refus uniforme, une seule ligne sans valeur, accès général conservé", () => {
  const longue = "factice-cle-longue-01234567890123456789";
  const nominale = "factice-nominale-01234567890123456789";
  process.env.CORE_CAISSE_API_KEY = longue;
  process.env.SERVICE_KEYS_JSON = JSON.stringify({ A: { sha256: empreinte(nominale), tenants: [T] } });
  const lignes: string[] = [], warn = console.warn;
  console.warn = (ligne) => { lignes.push(String(ligne)); };
  try {
    for (const [cle, motif] of [[undefined, "absente"], ["x".repeat(31), "courte"], [longue, "collision"], [nominale, "collision"]] as const) {
      if (cle === undefined) delete process.env.MAQUETTE_API_KEY;
      else process.env.MAQUETTE_API_KEY = cle;
      lignes.length = 0;
      assert.deepEqual(checkCleMaquette(req(cle ?? "invalide")), { ok: false, status: 401 });
      assert.deepEqual(lignes, [`maquette_cle_refusee motif=${motif}`]);
      if (motif === "collision") {
        assert.equal(hasServiceKey(req(cle!, "/api/sales")), true);
        assert.equal(lignes.length, 1, "le contrôle général ne journalise pas un refus maquette");
      }
    }
    process.env.MAQUETTE_API_KEY = "m".repeat(32);
    lignes.length = 0;
    assert.deepEqual(checkCleMaquette(req("m".repeat(32))), { ok: true });
    assert.deepEqual(checkCleMaquette(req("invalide")), { ok: false, status: 401 });
    assert.deepEqual(lignes, []);
  } finally { console.warn = warn; }
});

// SABOTAGE : retirer 40001/P2034 de estVerrouOccupe → le contrat 503 CAISSE_OCCUPEE casse.
test("sérialisation SQL et Prisma : même traitement que caisse occupée", () => {
  assert.equal(estVerrouOccupe({ code: "40001" }), true);
  assert.equal(estVerrouOccupe({ code: "P2034" }), true);
  assert.equal(estVerrouOccupe({ meta: { code: "40001" } }), true);
  assert.equal(estVerrouOccupe(new Error("autre erreur")), false);
});
