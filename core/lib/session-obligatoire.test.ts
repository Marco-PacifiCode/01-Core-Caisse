// « Pas d'encaissement sans caisse ouverte » — tests de la règle pure + de son branchement.
//
// CE QUE CES TESTS PROTÈGENT
// Une vente sans session n'entre dans AUCUN Z : elle est encaissée, facturée, et absente de la
// clôture de caisse. Mesuré en production le 2026-09-01 : 4 ventes / 28 700 F sur trois salons.
// Le Z du soir est le seul contrôle qu'un salon exerce sur son argent liquide ; une vente qui lui
// échappe rend l'écart inexplicable — indiscernable d'une erreur de comptage ou d'un vol.
//
// Les deux invariants qui portent tout le chantier, et qu'on ne peut pas casser sans faire rougir
// ce fichier :
//   · une remontée DIFFÉRÉE (caisse hors ligne) n'est JAMAIS refusée — sinon la Rôtisserie de
//     Pouembout, en production, ne peut plus synchroniser une seule vente ;
//   · un refus tombe AVANT la moindre écriture — rien à défaire, rien à ressaisir au comptoir.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideSessionVente,
  sessionIdADecision,
  type EntreeDecisionSession,
} from "./session-obligatoire.ts";

const caisse = readFileSync(new URL("./caisse.ts", import.meta.url), "utf8");
const routeSales = readFileSync(new URL("../app/api/sales/route.ts", import.meta.url), "utf8");

function entree(p: Partial<EntreeDecisionSession> = {}): EntreeDecisionSession {
  return {
    sessionProposee: null,
    sessionOuverteId: null,
    remonteeDifferee: false,
    ...p,
  };
}

// ── La règle, cas par cas ────────────────────────────────────────────────────

test("aucune session proposée, aucune caisse ouverte → REFUS (la règle de Marco)", () => {
  assert.deepEqual(decideSessionVente(entree()), { action: "REFUSEE", error: "NO_OPEN_SESSION" });
});

test("session proposée et OUVERTE → on la garde telle quelle (chemin du comptoir)", () => {
  const d = decideSessionVente(entree({ sessionProposee: { id: "s-1", status: "OPEN" }, sessionOuverteId: "s-1" }));
  assert.deepEqual(d, { action: "FOURNIE", sessionId: "s-1" });
});

test("rien de proposé mais une caisse est OUVERTE → le moteur estampille", () => {
  // C'est la cause qu'aucun écran ne peut corriger : les cinq surfaces dérivent le sessionId
  // par un appel S2S terminé par `.catch(() => null)`. Le moteur, lui, sait.
  const d = decideSessionVente(entree({ sessionOuverteId: "s-9" }));
  assert.deepEqual(d, { action: "ESTAMPILLEE", sessionId: "s-9" });
});

test("session proposée mais CLOSED, une autre est ouverte → on estampille l'OUVERTE, jamais la close", () => {
  // Une surface porte ce sessionId depuis le chargement de la page. Entre-temps, clôture.
  // Rattacher là rentrerait de l'argent dans un Z dont l'`expectedXpf` est FIGÉ : l'écart muet
  // serait déplacé, pas supprimé.
  const d = decideSessionVente(entree({ sessionProposee: { id: "s-hier", status: "CLOSED" }, sessionOuverteId: "s-auj" }));
  assert.deepEqual(d, { action: "ESTAMPILLEE", sessionId: "s-auj" });
});

test("session proposée CLOSED et aucune caisse ouverte → REFUS (on ne retombe pas sur la close)", () => {
  const d = decideSessionVente(entree({ sessionProposee: { id: "s-hier", status: "CLOSED" } }));
  assert.deepEqual(d, { action: "REFUSEE", error: "NO_OPEN_SESSION" });
});

// ── L'exemption qui empêche de casser un marchand en production ──────────────

test("🔴 remontée différée sans session → EXEMPTÉE, jamais refusée (Rôtisserie de Pouembout)", () => {
  // Si ce test devient rouge, la synchro quotidienne de la Rôtisserie échoue en silence
  // (`echecs.push`) et ses tickets restent bloqués sur la tablette.
  const d = decideSessionVente(entree({ remonteeDifferee: true }));
  assert.deepEqual(d, { action: "EXEMPTEE", sessionId: null });
});

test("🔴 remontée différée : l'exemption passe AVANT tout, même si une caisse est ouverte ailleurs", () => {
  // Sinon la vente d'hier de la tablette se ferait estampiller la session d'aujourd'hui d'un
  // autre comptoir, et entrerait dans un Z auquel elle n'appartient pas.
  const d = decideSessionVente(entree({ remonteeDifferee: true, sessionOuverteId: "s-auj" }));
  assert.deepEqual(d, { action: "EXEMPTEE", sessionId: null });
});

test("remontée différée avec une session explicite (import de clôture) → cette session est rendue", () => {
  const d = decideSessionVente(entree({ remonteeDifferee: true, sessionProposee: { id: "s-import", status: "CLOSED" } }));
  assert.deepEqual(d, { action: "EXEMPTEE", sessionId: "s-import" });
});

// ── Traduction en valeur écrite ──────────────────────────────────────────────

test("sessionIdADecision : undefined sur un refus, la valeur sinon", () => {
  assert.equal(sessionIdADecision({ action: "REFUSEE", error: "NO_OPEN_SESSION" }), undefined);
  assert.equal(sessionIdADecision({ action: "FOURNIE", sessionId: "a" }), "a");
  assert.equal(sessionIdADecision({ action: "ESTAMPILLEE", sessionId: "b" }), "b");
  assert.equal(sessionIdADecision({ action: "EXEMPTEE", sessionId: null }), null);
});

test("une décision de refus ne produit JAMAIS de sessionId écrivable", () => {
  // Formulation en négatif : c'est la propriété qui garantit qu'un refus ne peut pas se
  // transformer en écriture `sessionId: null` par mégarde d'un appelant.
  const refus = decideSessionVente(entree());
  assert.equal(sessionIdADecision(refus), undefined);
});

// ── Branchement dans createSale (structurel : caisse.ts n'est pas exécutable sous node --test) ──
// `lib/caisse.ts` importe @prisma/client et ./tenant → il ne tourne pas dans ce runner. On
// verrouille donc le CÂBLAGE par lecture du source, comme le fait déjà lib/postes.test.ts.

test("createSale appelle bien la règle — la garde n'est pas seulement écrite, elle est branchée", () => {
  assert.match(caisse, /from "\.\/session-obligatoire"/);
  const bloc = caisse.slice(caisse.indexOf("export async function createSale"));
  assert.match(bloc, /decideSessionVente\(/);
});

test("🔴 createSale COUPE sur un refus — la garde est un `return`, pas une intention", () => {
  // ⚠️ CE TEST A ÉTÉ FAUX PENDANT UNE HEURE, ET C'EST INSTRUCTIF. Il cherchait la chaîne
  // `error: "NO_OPEN_SESSION"` — qui apparaît AUSSI dans la SIGNATURE de `createSale` (le type
  // de retour). Le repère était donc trouvé même après suppression complète de la garde : une
  // mutation qui supprimait les trois lignes du `return` restait VERTE (mesuré par le QA).
  // On s'ancre désormais sur l'INSTRUCTION, jamais sur un mot qui traîne aussi dans un type.
  const bloc = caisse.slice(caisse.indexOf("export async function createSale"));
  const iDecision = bloc.indexOf("decideSessionVente(");
  const iCreate = bloc.indexOf("await tx.sale.create(");
  const mRefus = /if \(decision\.action === "REFUSEE"\) \{\s*return \{ ok: false as const, error: "NO_OPEN_SESSION" as const \};\s*\}/.exec(
    bloc,
  );
  assert.ok(mRefus, "createSale doit couper sur une décision REFUSEE, par un return");
  assert.ok(iDecision > 0 && iCreate > 0, "les deux repères doivent exister");
  assert.ok(iDecision < iCreate, "la décision doit précéder la création");
  assert.ok(mRefus.index < iCreate, "le refus doit précéder la création — aucune vente écrite");
});

test("createSale écrit le sessionId DÉCIDÉ, plus jamais celui de l'appelant tel quel", () => {
  const bloc = caisse.slice(caisse.indexOf("export async function createSale"));
  const create = bloc.slice(bloc.indexOf("await tx.sale.create("), bloc.indexOf("await tx.sale.create(") + 900);
  assert.doesNotMatch(create, /sessionId:\s*input\.sessionId\s*\?\?\s*null/);
  assert.match(create, /sessionId:\s*sessionIdDecide/);
});

test("la session proposée est RELUE en base (statut compris), jamais crue sur parole", () => {
  const bloc = caisse.slice(caisse.indexOf("export async function createSale"));
  assert.match(bloc, /cashSession\.findFirst/);
  assert.match(bloc, /select:\s*\{\s*id:\s*true,\s*status:\s*true\s*\}/);
});

test("la caisse ouverte est cherchée POUR LE POSTE de la vente, pas n'importe laquelle", () => {
  // Même invariant que currentSession : sur un marchand multi-postes, rendre la session d'un
  // autre comptoir ferait rattacher la vente au mauvais tiroir.
  const bloc = caisse.slice(caisse.indexOf("export async function createSale"));
  const i = bloc.indexOf('status: "OPEN"');
  assert.ok(i > 0, "createSale doit chercher une session OPEN");
  assert.match(bloc.slice(i - 200, i + 200), /posteId/);
});

test("🔴 l'exemption de remontée différée est câblée sur occurredAt ET sur horsSession", () => {
  // Deux marqueurs indépendants, volontairement : `occurredAt` est déjà envoyé par la Rôtisserie
  // mais son type le rend FACULTATIF (`horodatage?: string` → `?? null`). Un seul marqueur
  // laisserait passer un ticket sans horodatage, et sa synchro serait refusée.
  const bloc = caisse.slice(caisse.indexOf("export async function createSale"));
  assert.match(bloc, /remonteeDifferee:\s*[^\n]*occurredAt/);
  assert.match(bloc, /horsSession/);
});

// ── Route HTTP ───────────────────────────────────────────────────────────────

test("POST /api/sales rend 409 sur NO_OPEN_SESSION (et pas un 400 noyé dans les autres)", () => {
  // 409 = « l'état du serveur s'y oppose », pas « ta requête est malformée ». C'est ce que
  // l'écran doit pouvoir distinguer pour proposer d'ouvrir la caisse plutôt qu'afficher une
  // erreur de saisie.
  assert.match(routeSales, /result\.error === "NO_OPEN_SESSION" \? 409 : 400/);
});

test("POST /api/sales accepte horsSession, et il est booléen", () => {
  assert.match(routeSales, /horsSession\?:\s*boolean/);
  assert.match(routeSales, /horsSession:\s*body\.horsSession\s*===\s*true/);
});
