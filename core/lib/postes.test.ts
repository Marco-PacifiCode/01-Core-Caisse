// Postes de caisse et horodatage fourni par l'appelant (2026-08-15).
//
// POURQUOI CES ASSERTIONS EXISTENT
// Ce moteur sert TROIS marchands en production — Ellément, V-Cut, Onéiti — qui
// n'envoient ni `posteId` ni `occurredAt`. L'ajout du multi-postes ne devait
// rien changer pour eux. Ces tests gardent cette promesse.
//
// CE QU'ILS ATTRAPENT RÉELLEMENT :
//  · `currentSession` qui redeviendrait « n'importe quelle session ouverte » →
//    sur un marchand à deux comptoirs, les ventes d'une caisse se rattacheraient
//    au tiroir de l'autre, et les deux clôtures Z seraient fausses ;
//  · la garde d'unicité qui cesserait de filtrer sur le poste → soit deux postes
//    ne peuvent plus ouvrir ensemble (retour au blocage), soit un marchand
//    mono-caisse peut ouvrir plusieurs sessions (règle relâchée) ;
//  · `createdAt` écrit inconditionnellement → une vente sans `occurredAt`
//    perdrait son `@default(now())` ;
//  · une date future acceptée → une vente datée d'un exercice à venir.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const lire = (...p: string[]) => readFileSync(path.join(libDir, ...p), "utf8");

const caisse = lire("caisse.ts");
const schema = lire("..", "prisma", "schema.prisma");
const routeSessions = lire("..", "app", "api", "sessions", "route.ts");
const routeSales = lire("..", "app", "api", "sales", "route.ts");
const routeCheckout = lire("..", "app", "api", "sales", "[id]", "checkout", "route.ts");

// ── Schéma ───────────────────────────────────────────────────────────────────

test("le poste est NULLABLE sur CashSession et Sale (les marchands existants n'en ont pas)", () => {
  assert.match(schema, /posteId\s+String\?/);
  // Deux occurrences : une par modèle.
  assert.equal((schema.match(/posteId\s+String\?/g) || []).length, 2);
});

// ── Unicité de session ───────────────────────────────────────────────────────

test("l'unicité de session ouverte est filtrée PAR POSTE", () => {
  assert.match(caisse, /status:\s*"OPEN",\s*posteId\s*\}/);
});

test("openSession rattrape la course sur l'index unique au lieu de remonter une erreur brute", () => {
  const bloc = caisse.slice(caisse.indexOf("export async function openSession"));
  assert.match(bloc.slice(0, 2500), /P2002/);
  assert.match(bloc.slice(0, 2500), /SESSION_ALREADY_OPEN/);
});

test("currentSession cherche la session DU poste, pas n'importe laquelle", () => {
  const bloc = caisse.slice(caisse.indexOf("export async function currentSession"));
  assert.match(bloc.slice(0, 900), /posteId:\s*posteId\s*\?\?\s*null/);
});

// ── Horodatage ───────────────────────────────────────────────────────────────

test("createdAt n'est écrit QUE si occurredAt est fourni (sinon @default(now()))", () => {
  // Écriture conditionnelle par étalement : sans `occurredAt`, la clé est absente.
  assert.match(caisse, /\.\.\.\(input\.occurredAt \? \{ createdAt: input\.occurredAt \} : \{\}\)/);
});

test("une vente datée dans le futur est refusée", () => {
  assert.match(caisse, /FUTURE_DATE/);
  const bloc = caisse.slice(caisse.indexOf("export async function createSale"));
  assert.match(bloc.slice(0, 1200), /occurredAt.*getTime\(\)\s*>\s*Date\.now\(\)/s);
});

test("paidAt fourni est retenu, une date future retombe sur l'heure du serveur", () => {
  assert.match(caisse, /options\?\.paidAt && options\.paidAt\.getTime\(\) <= Date\.now\(\)/);
});

// ── Routes ───────────────────────────────────────────────────────────────────

test("les trois routes acceptent les nouveaux champs", () => {
  assert.match(routeSessions, /posteId\?: string/);
  assert.match(routeSales, /posteId\?: string/);
  assert.match(routeSales, /occurredAt\?: string/);
  assert.match(routeCheckout, /paidAt\?: string/);
});

test("une date illisible est refusée au lieu de devenir silencieusement maintenant", () => {
  assert.match(routeSales, /Number\.isNaN\(d\.getTime\(\)\)/);
  assert.match(routeCheckout, /Number\.isNaN\(d\.getTime\(\)\)/);
});

test("checkout n'ajoute d'options que s'il y a quelque chose à transmettre", () => {
  // Sans giftCards, paidAt, redeemGiftCards ni credit, l'appel doit rester identique à celui
  // d'avant : `undefined`, et non un objet vide qui changerait la signature observée.
  //
  // ⚠️ La liste des porteurs s'allonge (2026-09-04 : consommation d'un bon cadeau pendant
  //    l'encaissement ; 2026-09-15 : vente à crédit ; 2026-09-16 : fidélité lot C2) ; ce qui NE
  //    doit pas changer, c'est qu'aucun d'eux n'est présent ⇒ `undefined`. On épingle donc la
  //    PRÉSENCE de ces quatre porteurs dans la condition et la forme du ternaire, pas le nombre
  //    total de termes (d'autres peuvent s'ajouter après `credit`).
  assert.match(routeCheckout, /giftCards \|\| paidAt \|\| redeemGiftCards \|\| credit/);
  assert.match(routeCheckout, /\?\s*\{[\s\S]*?\}\s*:\s*undefined;/);
});

test("checkout : la condition COMPLÈTE porte bien les SIX porteurs, dans l'ordre (garde de régression doublée, cf. checkout-route.test.ts)", () => {
  // ⚠️ Assertion STRICTE, volontairement dupliquée depuis checkout-route.test.ts : la protection
  // contre un porteur oublié (cf. contre-QA 2026-09-16, `loyalty`/`redeemLoyalty` absents de la
  // condition alors que le câblage existait déjà plus haut dans la route) ne doit PAS tenir à un
  // seul fichier de test.
  assert.match(
    routeCheckout,
    /giftCards \|\| paidAt \|\| redeemGiftCards \|\| credit \|\| loyalty \|\| redeemLoyalty\s*\?/,
  );
});

// ── Rétrocompatibilité, la promesse centrale ─────────────────────────────────

test("posteId est toujours optionnel côté appelant", () => {
  // `posteId?:` dans les types d'entrée, et `?? null` à l'écriture : un appelant
  // qui l'ignore écrit NULL, ce qui est le comportement d'origine.
  assert.match(caisse, /posteId\?: string \| null/);
  assert.match(caisse, /posteId: input\.posteId \?\? null/);
});
