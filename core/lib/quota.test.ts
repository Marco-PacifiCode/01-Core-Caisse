// Quota de postes de caisse — tests des règles pures (lib/quota.ts).
//
// CE QUE CES TESTS PROTÈGENT
// 1. Un poste qui vendait hier ouvre aujourd'hui, quel que soit le plafond.
// 2. Sans droit, sans plafond, ou Core-Auth en panne : aucun verrou.
// 3. La forme réelle de la réponse Core-Auth (`niveau` ENTIER) est comprise — une première
//    version attendait un texte, rejetait donc tous les droits, et le verrou ne se déclenchait jamais.
//
// Exécution : cd core && npm test
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { decisionInscription, droitDepuisReponse, lireDroit, refusPostes, viderCacheQuota } from "./quota.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const fetchOrigine = globalThis.fetch;
const reponse = (plafond: number | null) => ({
  tenantId: TENANT,
  droits: [{ cle: "CAISSE", niveau: 1, plafond, quoi: "postes de caisse" }],
});

beforeEach(() => {
  viderCacheQuota();
  process.env.CORE_AUTH_API_KEY = "cle-de-test";
});
afterEach(() => {
  globalThis.fetch = fetchOrigine;
});

test("poste déjà enregistré et actif : rien à faire, même au-dessus du plafond", () => {
  assert.deepEqual(decisionInscription({ poste: { actif: true }, aHistorique: false, plafond: 1, actifs: 5 }), { action: "rien" });
});

test("poste nouveau : inscrit sous le plafond, refusé au plafond", () => {
  assert.deepEqual(decisionInscription({ poste: null, aHistorique: false, plafond: 3, actifs: 2 }), { action: "inscrire", horsQuota: false });
  assert.deepEqual(decisionInscription({ poste: null, aHistorique: false, plafond: 1, actifs: 1 }), { action: "refuser" });
  assert.deepEqual(decisionInscription({ poste: null, aHistorique: false, plafond: 3, actifs: 7 }), { action: "refuser" });
});

test("sans plafond : toujours inscrit", () => {
  assert.deepEqual(decisionInscription({ poste: null, aHistorique: false, plafond: null, actifs: 40 }), { action: "inscrire", horsQuota: false });
  assert.deepEqual(decisionInscription({ poste: { actif: false }, aHistorique: false, plafond: null, actifs: 40 }), { action: "inscrire", horsQuota: false });
});

test("poste inconnu du registre mais qui a déjà travaillé : JAMAIS refusé, marqué hors quota s'il dépasse", () => {
  assert.deepEqual(decisionInscription({ poste: null, aHistorique: true, plafond: 1, actifs: 1 }), { action: "inscrire", horsQuota: true });
  assert.deepEqual(decisionInscription({ poste: null, aHistorique: true, plafond: 1, actifs: 0 }), { action: "inscrire", horsQuota: false });
});

test("poste désactivé puis rallumé : repasse par le plafond", () => {
  assert.deepEqual(decisionInscription({ poste: { actif: false }, aHistorique: false, plafond: 1, actifs: 1 }), { action: "refuser" });
  assert.deepEqual(decisionInscription({ poste: { actif: false }, aHistorique: false, plafond: 2, actifs: 1 }), { action: "inscrire", horsQuota: false });
});

test("message de refus : singulier et pluriel", () => {
  const un = refusPostes("CAISSE", 1, 1, "postes de caisse");
  assert.equal(un.error, "quota_atteint");
  assert.equal(un.message, "Votre formule couvre 1 poste de caisse. Pour en ajouter un, passez au niveau supérieur ou désactivez un poste.");
  assert.match(refusPostes("CAISSE", 3, 3, null).message, /^Votre formule couvre 3 postes de caisse\./);
});

test("droitDepuisReponse lit la forme réelle de Core-Auth (niveau entier)", () => {
  assert.deepEqual(droitDepuisReponse(reponse(3), TENANT, "CAISSE"), { niveau: 1, plafond: 3, quoi: "postes de caisse" });
  assert.deepEqual(droitDepuisReponse(reponse(null), TENANT, "CAISSE"), { niveau: 1, plafond: null, quoi: "postes de caisse" });
  assert.equal(droitDepuisReponse({ tenantId: TENANT, droits: [] }, TENANT, "CAISSE"), null);
  assert.throws(() => droitDepuisReponse({ tenantId: "autre", droits: [] }, TENANT, "CAISSE"));
  // Ligne à moitié lisible : jamais appliquée (sinon un plafond 0 mal formé fermerait la caisse).
  assert.throws(() => droitDepuisReponse({ tenantId: TENANT, droits: [{ cle: "CAISSE", niveau: "invalide", plafond: 0, quoi: null }] }, TENANT, "CAISSE"));
});

test("lireDroit rend le plafond envoyé par Core-Auth", async () => {
  globalThis.fetch = (async () => Response.json(reponse(3))) as typeof fetch;
  assert.deepEqual(await lireDroit(TENANT, "CAISSE"), { niveau: 1, plafond: 3, quoi: "postes de caisse" });
});

test("ouverture : Core-Auth en panne, en erreur, réponse invalide ou clé absente → pas de droit, pas d'exception", async () => {
  globalThis.fetch = (async () => { throw new Error("injoignable"); }) as typeof fetch;
  assert.equal(await lireDroit(TENANT, "CAISSE"), null);

  viderCacheQuota();
  globalThis.fetch = (async () => new Response("non", { status: 500 })) as typeof fetch;
  assert.equal(await lireDroit(TENANT, "CAISSE"), null);

  viderCacheQuota();
  globalThis.fetch = (async () => Response.json({ n: "importe quoi" })) as typeof fetch;
  assert.equal(await lireDroit(TENANT, "CAISSE"), null);

  viderCacheQuota();
  delete process.env.CORE_AUTH_API_KEY;
  assert.equal(await lireDroit(TENANT, "CAISSE"), null);

  // Un journal qui lève ne doit pas faire lever la lecture.
  viderCacheQuota();
  process.env.CORE_AUTH_API_KEY = "cle-de-test";
  globalThis.fetch = (async () => { throw Object.create(null); }) as typeof fetch;
  assert.equal(await lireDroit(TENANT, "CAISSE", { journal: () => { throw new Error("journal cassé"); } }), null);
});
