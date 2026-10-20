import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { NextRequest } from "next/server";
import { hasServiceKey } from "./service-auth.ts";
import {
  clesNominativesPosees, egalTempsConstant, horsPortee, HorsPorteeError,
  identifierCle, modeCles, reinitialiserClesService, routeNormalisee,
  verifierPortee, viderJournal,
} from "./cles-service.ts";

const T1 = "00000000-0000-0000-0000-000000000001";
const T2 = "00000000-0000-0000-0000-000000000002";
const CLE_A = "factice-test-service-a";
const CLE_B = "factice-test-service-b";
const LEGACY = "factice-test-historique";
const envNoms = ["SERVICE_KEYS_JSON", "SERVICE_KEYS_MODE", "SERVICE_KEY_LEGACY_OK", "CORE_CAISSE_API_KEY"] as const;
let sauvegarde: Array<string | undefined>;
let warns: string[];
let infos: string[];
let erreurs: string[];
const consoleInitiale = { warn: console.warn, info: console.info, error: console.error };
function requete(cle: string | null = CLE_A, chemin = `/api/sales/${T1}/lines`): NextRequest {
  return { headers: new Headers(cle === null ? {} : { "x-core-key": cle }), url: `http://service.invalid${chemin}` } as NextRequest;
}
function config(tenants = [T1]): void {
  process.env.SERVICE_KEYS_JSON = JSON.stringify({ A: { sha256: createHash("sha256").update(CLE_A).digest("hex"), tenants } });
}
beforeEach(() => {
  sauvegarde = envNoms.map((nom) => process.env[nom]);
  for (const nom of envNoms) delete process.env[nom];
  process.env.CORE_CAISSE_API_KEY = LEGACY;
  reinitialiserClesService();
  warns = []; infos = []; erreurs = [];
  console.warn = (ligne) => { warns.push(String(ligne)); };
  console.info = (ligne) => { infos.push(String(ligne)); };
  console.error = (ligne) => { erreurs.push(String(ligne)); };
});
afterEach(() => {
  reinitialiserClesService();
  envNoms.forEach((nom, i) => {
    if (sauvegarde[i] === undefined) delete process.env[nom];
    else process.env[nom] = sauvegarde[i];
  });
  Object.assign(console, consoleInitiale);
});

test("1. Sans configuration : acceptation historique, refus et silence inchangés", () => {
  process.env.SERVICE_KEYS_MODE = "applique";
  assert.equal(hasServiceKey(requete(LEGACY)), true);
  assert.doesNotThrow(() => verifierPortee(T2));
  assert.equal(hasServiceKey(requete("factice-invalide")), false);
  assert.equal(hasServiceKey(requete(null)), false);
  delete process.env.CORE_CAISSE_API_KEY;
  assert.equal(hasServiceKey(requete(LEGACY)), false);
  viderJournal();
  assert.equal(clesNominativesPosees(), false);
  assert.deepEqual([warns, infos, erreurs], [[], [], []]);
});

test("2. Nominative valide, tenant autorisé et requête inconnue", () => {
  config();
  const req = requete();
  assert.equal(hasServiceKey(req), true);
  assert.deepEqual(identifierCle(CLE_A), { nom: "A", tenants: [T1] });
  assert.equal(horsPortee(req, T1), null);
  assert.equal(horsPortee(req, ""), null);
  assert.equal(horsPortee(requete(), T2), null);
});

test("3. Hors portée : journal par défaut, déduplication et application", async () => {
  config();
  assert.equal(modeCles(), "journal");
  process.env.SERVICE_KEYS_MODE = "inconnu";
  assert.equal(modeCles(), "journal");
  const req = requete();
  assert.ok(hasServiceKey(req));
  assert.equal(horsPortee(req, T2), null);
  assert.equal(horsPortee(req, T2), null);
  verifierPortee(T2);
  assert.deepEqual(warns, [`[cles-service] HORS_PORTEE appelant=A tenant=${T2} route=/api/sales/:id/lines`]);
  process.env.SERVICE_KEYS_MODE = " ApPlIqUe ";
  const refus = horsPortee(req, T2);
  assert.equal(refus?.status, 403);
  assert.deepEqual(await refus!.json(), { error: "HORS_PORTEE" });
  assert.throws(() => verifierPortee(T2), (e: unknown) => e instanceof HorsPorteeError && e.name === "HORS_PORTEE" && e.message === "HORS_PORTEE");
  assert.equal(warns.length, 1);
});

test("4. Portée étoile : tous les tenants sont autorisés", () => {
  config(["*"]);
  process.env.SERVICE_KEYS_MODE = "applique";
  const req = requete();
  assert.ok(hasServiceKey(req));
  assert.equal(horsPortee(req, T2), null);
  assert.doesNotThrow(() => verifierPortee(T2));
  assert.deepEqual(warns, []);
});

test("5. Historique comptée avec clés nominatives, désactivable", () => {
  config();
  assert.ok(hasServiceKey(requete(LEGACY)));
  verifierPortee(T2);
  verifierPortee(T2);
  viderJournal();
  assert.deepEqual(infos, [`[cles-service] SYNTHESE appelant=historique tenant=${T2} route=/api/sales/:id/lines verdict=historique n=1`]);
  process.env.SERVICE_KEY_LEGACY_OK = "0";
  assert.equal(hasServiceKey(requete(LEGACY)), false);
  assert.ok(hasServiceKey(requete()));
});

test("6. JSON invalide ou mal formé ignoré, avertissement unique, portée vide inutilisable", () => {
  for (const brut of ["{", "[]", "null", '{"A":null}', '{"A":{"sha256":"invalide","tenants":[]}}']) {
    process.env.SERVICE_KEYS_JSON = brut;
    assert.equal(identifierCle(CLE_A), null);
    assert.equal(clesNominativesPosees(), false);
    assert.ok(hasServiceKey(requete(LEGACY)));
  }
  assert.deepEqual(erreurs, ["[cles-service] SERVICE_KEYS_JSON illisible"]);
  config([]);
  assert.equal(identifierCle(CLE_A), null);
  assert.equal(clesNominativesPosees(), false);
  config();
  assert.ok(identifierCle(CLE_A));
});

test("7. Longueurs différentes : refus sans exception", () => {
  config();
  assert.equal(egalTempsConstant("factice-court", LEGACY), false);
  assert.equal(egalTempsConstant(LEGACY, LEGACY), true);
  assert.doesNotThrow(() => assert.equal(hasServiceKey(requete("x")), false));
});

test("8. Compteurs agrégés, une fois par requête, vidage explicite et seuil 1000", () => {
  config();
  for (let i = 0; i < 3; i++) {
    assert.ok(hasServiceKey(requete()));
    verifierPortee(T1); verifierPortee(T1);
  }
  assert.deepEqual(infos, []);
  viderJournal();
  assert.deepEqual(infos, [`[cles-service] SYNTHESE appelant=A tenant=${T1} route=/api/sales/:id/lines verdict=ok n=3`]);
  viderJournal();
  assert.equal(infos.length, 1);
  for (let i = 0; i < 1000; i++) {
    assert.ok(hasServiceKey(requete()));
    verifierPortee(T1);
  }
  assert.equal(infos.length, 2);
  assert.match(infos[1], /verdict=ok n=1000$/);
  assert.deepEqual(warns, []);
});

test("9. Routes : UUID et segments numériques normalisés", () => {
  assert.equal(routeNormalisee(`/api/sales/${T1}/lines/123`), "/api/sales/:id/lines/:id");
  assert.equal(routeNormalisee("http://["), "");
  assert.equal(routeNormalisee("/api/sales/abc123"), "/api/sales/abc123");
});

test("10. NON-FUITE : requêtes entrelacées, portée et contexte parent isolés", async () => {
  config();
  const obj = JSON.parse(process.env.SERVICE_KEYS_JSON!);
  obj.B = { sha256: createHash("sha256").update(CLE_B).digest("hex"), tenants: [T2] };
  process.env.SERVICE_KEYS_JSON = JSON.stringify(obj);
  const reqA = requete(CLE_A);
  const reqB = requete(CLE_B);
  const a = (async () => {
    await Promise.resolve();
    assert.ok(hasServiceKey(reqA));
    await new Promise((r) => setTimeout(r, 5));
    verifierPortee(T1);
    assert.equal(horsPortee(reqA, T1), null);
    await new Promise((r) => setTimeout(r, 20));
    verifierPortee(T2);
  })();
  const b = (async () => {
    await Promise.resolve();
    assert.ok(hasServiceKey(reqB));
    await new Promise((r) => setTimeout(r, 15));
    verifierPortee(T2);
    assert.equal(horsPortee(reqB, T2), null);
    assert.deepEqual(warns, []);
  })();
  await Promise.all([a, b]);
  assert.deepEqual(warns, [`[cles-service] HORS_PORTEE appelant=A tenant=${T2} route=/api/sales/:id/lines`]);
  const avant = [...warns];
  process.env.SERVICE_KEYS_MODE = "applique";
  assert.doesNotThrow(() => verifierPortee(T1));
  assert.doesNotThrow(() => verifierPortee(T2));
  assert.deepEqual(warns, avant);
  viderJournal();
  assert.equal(infos.length, 2);
  assert.ok(infos.some((ligne) => ligne.includes(`appelant=A tenant=${T1}`)));
  assert.ok(infos.some((ligne) => ligne.includes(`appelant=B tenant=${T2}`)));
});

test("11. RUNTIME : aucune déclaration edge dans app, middleware ou proxy", () => {
  const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  function parcourir(dossier: string): string[] {
    return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
      const fichier = path.join(dossier, e.name);
      return e.isDirectory() ? parcourir(fichier) : /\.tsx?$/.test(e.name) ? [fichier] : [];
    });
  }
  const fichiers = [...parcourir(path.join(core, "app")), ...["middleware.ts", "proxy.ts"].map((f) => path.join(core, f)).filter(existsSync)];
  for (const fichier of fichiers) {
    assert.doesNotMatch(readFileSync(fichier, "utf8"), /\bruntime\s*(?:=|:)\s*["']edge["']/, fichier);
  }
});
