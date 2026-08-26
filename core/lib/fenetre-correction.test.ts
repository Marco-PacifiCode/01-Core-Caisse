// Contrat de la fenêtre de correction (lib/fenetre-correction.ts) — module PUR, aucune DB ni Next.
//
// Toutes les valeurs attendues ci-dessous sont calculées À LA MAIN (règle : décomposer en heure NC
// UTC+11 fixe, ajouter un mois calendaire, clamper le débordement de quantième, recomposer en UTC),
// PAS en rejouant l'algorithme du module testé — sinon le test ne prouverait que sa propre boucle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { limiteDeCorrection, estDansLaFenetre } from "./fenetre-correction.ts";

// ─── 15 mars → 15 avril (l'exemple même de la consigne de Marco) ──────────────────────────────

test("15 mars 2026, 09:00 NC → limite 15 avril 2026, 09:00 NC (un mois calendaire, quel que soit le mois traversé)", () => {
  // 15 mars 09:00 NC = 09:00 - 11h = 22:00 UTC le 14 mars (on emprunte un jour).
  const origine = new Date("2026-03-14T22:00:00.000Z"); // = 2026-03-15T09:00 NC
  const attendu = new Date("2026-04-14T22:00:00.000Z"); // = 2026-04-15T09:00 NC
  assert.equal(limiteDeCorrection(origine).getTime(), attendu.getTime());
});

// ─── Débordement de quantième : 31 janvier → dernier jour de février ──────────────────────────

test("31 janvier 2026 : le quantieme DEBORDE sur mars (28 fev + 3), il n'est pas rabote", () => {
  // 🗣️ Marco, 2026-08-26 : « une erreur faite le 31 n'est pas recuperee le 1er. »
  // Raboter au dernier jour de fevrier donnait 28 jours de fenetre a un paiement
  // du 31 — moins qu'un mois, et moins que le 1er du meme mois. On deborde donc.
  const origine = new Date("2026-01-31T12:00:00.000Z"); // 31 janvier 23:00 NC
  const attendu = new Date("2026-03-03T12:00:00.000Z"); // 3 mars 23:00 NC (31 fev = 28 + 3)
  assert.equal(limiteDeCorrection(origine).getTime(), attendu.getTime());
});

test("31 janvier 2028 (BISSEXTILE) : deborde au 2 mars (29 fev + 2)", () => {
  const origine = new Date("2028-01-31T12:00:00.000Z"); // 31 janvier 23:00 NC
  const attendu = new Date("2028-03-02T12:00:00.000Z"); // 2 mars 23:00 NC
  assert.equal(limiteDeCorrection(origine).getTime(), attendu.getTime());
});

test("LE CAS DE MARCO : une erreur du 31 mars se rattrape encore le 1er mai", () => {
  const origine = new Date("2026-03-31T01:00:00.000Z"); // 31 mars 12:00 NC
  const attendu = new Date("2026-05-01T01:00:00.000Z"); // 1er mai 12:00 NC (31 avril = 30 + 1)
  assert.equal(limiteDeCorrection(origine).getTime(), attendu.getTime());
  assert.equal(estDansLaFenetre(origine, new Date("2026-04-30T22:00:00.000Z")), true);
});

test("29 février 2028 (bissextile), 11h NC → limite 29 mars 2028, 11h NC (pas de débordement à clamper)", () => {
  const origine = new Date("2028-02-29T00:00:00.000Z"); // 11h NC = 0h UTC (11-11=0)
  const attendu = new Date("2028-03-29T00:00:00.000Z");
  assert.equal(limiteDeCorrection(origine).getTime(), attendu.getTime());
});

// ─── Rollover d'année : décembre → janvier ────────────────────────────────────────────────────

test("15 décembre 2026 → limite 15 janvier 2027 (l'année avance avec le mois)", () => {
  const origine = new Date("2026-12-15T00:00:00.000Z"); // 11h NC
  const attendu = new Date("2027-01-15T00:00:00.000Z");
  assert.equal(limiteDeCorrection(origine).getTime(), attendu.getTime());
});

// ─── LE PIÈGE DU FUSEAU : la date UTC de l'instant diffère de sa date NC ──────────────────────
//
// UTC+11 fixe : quand l'instant tombe à un moment où l'heure NC (UTC+11) a déjà franchi minuit
// alors que l'heure UTC ne l'a pas encore fait, calculer le calendrier sur les composantes UTC
// brutes (sans décaler d'abord de +11h) daterait le paiement de la VEILLE en heure NC — décalant
// la limite d'un mois calendaire entier si la frontière tombe en fin de mois.

test("un encaissement à 00:30 heure NC (donc 13:30 UTC la VEILLE) est daté du bon jour NC, pas de la veille en UTC", () => {
  // 2026-02-01T00:30 NC = 2026-01-31T13:30 UTC (00:30 - 11h, en empruntant un jour : 13:30 la veille).
  const origine = new Date("2026-01-31T13:30:00.000Z");
  // Origine réelle en NC : 1er février. +1 mois calendaire = 1er mars, à la même heure locale.
  // 2026-03-01T00:30 NC = 2026-02-28T13:30 UTC.
  const attendu = new Date("2026-02-28T13:30:00.000Z");
  assert.equal(
    limiteDeCorrection(origine).getTime(),
    attendu.getTime(),
    "la limite doit être calée sur le 1er mars NC (+1 mois depuis le 1er février NC), pas sur le 31 janvier UTC",
  );
});

test("un encaissement a 23h heure NC ne perd pas un jour (aucun decalage de fuseau)", () => {
  // Meme heure locale de part et d'autre : on prend un quantieme QUI EXISTE dans
  // le mois cible (le 15), pour que ce test ne mesure QUE le fuseau — le
  // debordement de quantieme a ses propres tests ci-dessus.
  const origine = new Date("2026-01-15T12:00:00.000Z"); // 15 janvier 23:00 NC
  const attendu = new Date("2026-02-15T12:00:00.000Z"); // 15 fevrier 23:00 NC
  assert.equal(limiteDeCorrection(origine).getTime(), attendu.getTime());
});

// ─── Bornes de estDansLaFenetre — INCLUSE à la milliseconde ───────────────────────────────────

test("estDansLaFenetre : à la limite exacte, ENCORE accepté (borne incluse)", () => {
  const origine = new Date("2026-03-14T22:00:00.000Z"); // 15 mars 09:00 NC
  const limite = limiteDeCorrection(origine); // 15 avril 09:00 NC
  assert.equal(estDansLaFenetre(origine, limite), true);
});

test("estDansLaFenetre : 1 ms après la limite, REFUSÉ", () => {
  const origine = new Date("2026-03-14T22:00:00.000Z");
  const limite = limiteDeCorrection(origine);
  const uneMsApres = new Date(limite.getTime() + 1);
  assert.equal(estDansLaFenetre(origine, uneMsApres), false);
});

test("estDansLaFenetre : 1 ms avant la limite, accepté", () => {
  const origine = new Date("2026-03-14T22:00:00.000Z");
  const limite = limiteDeCorrection(origine);
  const uneMsAvant = new Date(limite.getTime() - 1);
  assert.equal(estDansLaFenetre(origine, uneMsAvant), true);
});

test("estDansLaFenetre : `maintenant` est INJECTÉ — un défaut `new Date()` existe mais n'est jamais lu au fond du module", () => {
  // La signature accepte `maintenant` en second paramètre optionnel : appeler sans lui ne doit pas
  // lever, et la fonction reste appelable en mode « horloge réelle » pour l'appelant qui le souhaite.
  const origine = new Date(Date.now() - 1000);
  assert.equal(typeof estDansLaFenetre(origine), "boolean");
});
