import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as moduleNode from "node:module";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";

const stripTypeScriptTypes = (moduleNode as unknown as { stripTypeScriptTypes: (source: string) => string }).stripTypeScriptTypes;
const T = "00000000-0000-0000-0000-000000000001";
/** Charger le vrai code avec ses dépendances injectées ; aucune installation nécessaire. */
function charger(fichier: string, noms: string[], deps: Record<string, unknown> = {}) {
  const source = stripTypeScriptTypes(readFileSync(new URL(fichier, import.meta.url), "utf8"))
    .replace(/^import .*;\r?$/gm, "").replace(/\bexport /g, "");
  return vm.runInNewContext(`${source}\n;({ ${noms.join(",")} })`, {
    process: { env: {} }, console, Headers, ...deps,
  });
}
const normaliser = (valeur: unknown) => JSON.parse(JSON.stringify(valeur));

// SABOTAGE : supprimer isolationLevel de l'effacement ou le fixer dans withTenant → ce test casse.
test("seul l'effacement demande RepeatableRead, contexte RLS local et délai SQL conservés", async () => {
  const options: unknown[] = [], sql: string[] = [];
  let crochet = 0;
  const tx = {
    async $executeRaw(parties: TemplateStringsArray, ...valeurs: unknown[]) {
      sql.push(parties.join("?"));
      if (sql.length === 1) assert.deepEqual(valeurs, [T]);
    },
    async $queryRaw(parties: TemplateStringsArray) {
      const requete = parties.join("?");
      sql.push(requete);
      if (requete.includes("information_schema")) return [{ table_name: "SaleLine" }];
      assert.equal(crochet, 1, "le crochet précède l'effacement SQL");
      return [{ compteurs: { Sale: 1, SaleLine: 2 } }];
    },
    async $queryRawUnsafe(requete: string, tenant: string) {
      assert.equal(tenant, T); sql.push(requete); return [{ count: 2 }];
    },
  };
  const { withTenant } = charger("./tenant.ts", ["withTenant"], {
    headers: async () => new Headers(),
    verifierPortee: async () => {},
    prisma: { async $transaction(fn: (tx: unknown) => Promise<unknown>, opts: unknown) {
      options.push(opts); return fn(tx);
    } },
  });
  await withTenant(T, async () => {});
  assert.equal(options[0], undefined, "transaction générale inchangée");
  sql.length = 0;
  const { effacerMaquette } = charger("./maquette-effacement.ts", ["effacerMaquette"], { withTenant });
  assert.deepEqual(normaliser(await effacerMaquette(T, async () => {
    assert.ok(sql.at(-1)!.includes("count(*)"));
    crochet++;
  })), { Sale: 1, SaleLine: 2 });
  assert.deepEqual(normaliser(options[1]), { timeout: 15000, maxWait: 5000, isolationLevel: "RepeatableRead" });
  assert.match(sql[0], /set_config\('app.current_tenant', \?, true\)/);
  assert.match(sql.at(-2)!, /set_config\('statement_timeout', '10s', true\)/);
  assert.match(sql.at(-1)!, /effacer_tenant_maquette/);
  sql.length = 0;
  await effacerMaquette(T);
  assert.equal(crochet, 1, "crochet inactif par défaut");
  assert.equal(sql.length, 3, "pas de précomptage supplémentaire sans crochet");
});

// SABOTAGE : retirer 40001/P2034 de estVerrouOccupe ou son traitement route → 503 attendu casse.
test("route effacer : sérialisation → 503 CAISSE_OCCUPEE ; autres erreurs inchangées", async () => {
  const maquette = charger("./maquette.ts", ["estVerrouOccupe", "codeMaquette"]);
  let erreur: unknown;
  const { POST } = charger("../app/api/maquette/effacer/route.ts", ["POST"], {
    ...maquette,
    checkCleMaquette: () => ({ ok: true }),
    estUuid: () => true,
    verifierPourEffacer: async () => ({ ok: true }),
    effacerMaquette: async () => { throw erreur; },
    log: { error() {} },
    NextResponse: { json: (body: unknown, options: unknown) => ({ body, ...options as object }) },
  });
  for (const e of [{ code: "40001" }, { code: "P2034" }, { meta: { code: "40001" } }]) {
    erreur = e;
    assert.deepEqual(normaliser(await POST({ json: async () => ({ tenantId: T }) })),
      { body: { error: "CAISSE_OCCUPEE" }, status: 503 });
  }
  erreur = new Error("autre");
  assert.deepEqual(normaliser(await POST({ json: async () => ({ tenantId: T }) })),
    { body: { error: "MAQUETTE_EFFACEMENT_ECHEC" }, status: 500 });
});

// SABOTAGE : enlever le contrôle d'une famille de collision, la longueur ou le journal → test rouge.
test("clés : toutes les familles refusées côté maquette, authentification générale inchangée", () => {
  const env: Record<string, string | undefined> = {};
  const lignes: string[] = [];
  const cles = charger("./cles-service.ts", ["motifCleMaquetteRefusee", "egalTempsConstant",
    "cleHistoriqueAcceptee", "entrerAppel", "estCleMaquette", "identifierCle"], {
    process: { env }, AsyncLocalStorage, createHash, timingSafeEqual, Buffer, setInterval, clearInterval,
  });
  const { checkCleMaquette } = charger("./maquette.ts", ["checkCleMaquette"], {
    ...cles, process: { env }, console: { warn: (ligne: string) => lignes.push(ligne) },
  });
  const { hasServiceKey } = charger("./service-auth.ts", ["hasServiceKey"], { ...cles, process: { env } });
  const historique = "h".repeat(32), nominative = "n".repeat(32);
  env.CORE_CAISSE_API_KEY = historique;
  env.SERVICE_KEYS_JSON = JSON.stringify({ A: { sha256: createHash("sha256").update(nominative).digest("hex"), tenants: [T] } });
  for (const [cle, motif] of [[undefined, "absente"], ["c".repeat(31), "courte"],
    [historique, "collision"], [nominative, "collision"]] as const) {
    env.MAQUETTE_API_KEY = cle;
    lignes.length = 0;
    const req = { headers: new Headers({ "x-core-key": cle ?? "invalide" }), url: "http://test.invalid/api/sales" };
    assert.deepEqual(normaliser(checkCleMaquette(req)), { ok: false, status: 401 });
    assert.deepEqual(lignes, [`maquette_cle_refusee motif=${motif}`]);
    assert.equal(hasServiceKey(req), motif === "collision");
  }
  env.MAQUETTE_API_KEY = "m".repeat(32);
  lignes.length = 0;
  const req = { headers: new Headers({ "x-core-key": env.MAQUETTE_API_KEY }), url: "http://test.invalid/api/sales" };
  assert.deepEqual(normaliser(checkCleMaquette(req)), { ok: true });
  assert.equal(hasServiceKey(req), false);
  assert.deepEqual(lignes, []);
});
