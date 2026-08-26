// lib/fenetre-correction.ts — FENÊTRE DE CORRECTION D'UN MOYEN DE PAIEMENT (pur, sans DB) — même
// contrat que lib/money.ts / lib/cash-movement.ts : AUCUN import runtime (ni @prisma/client, ni
// next/*, ni ./tenant), pour tourner directement sous `node --test --experimental-strip-types`.
//
// LA RÈGLE (Marco, 2026-08-26, verbatim) : « le moyen de paiement n'est pas très important. tant
// que le montant ne change pas. corrections jusqu'à 1 mois plus tard. ça se voit au recomptage de
// la caisse de toute façon. »
//
// CE QUE « 1 MOIS » VEUT DIRE ICI :
//
//  1. UN MOIS CALENDAIRE, PAS 31 JOURS. « Un mois plus tard » se lit sur un calendrier, pas sur un
//     compteur de jours : un paiement du 15 mars se corrige jusqu'au 15 avril, quelle que soit la
//     longueur du mois traversé (28, 29, 30 ou 31 jours).
//
//  2. DÉBORDEMENT DE QUANTIÈME : le 31 janvier avance au dernier jour du mois d'arrivée — le 28 (ou
//     le 29 en année bissextile) février — JAMAIS au 3 mars. On ne « rattrape » pas les jours en
//     trop sur le mois suivant.
//
//  3. FUSEAU : NOUVELLE-CALÉDONIE = UTC+11 FIXE, aucune heure d'été. Un `Date` JS ne porte qu'un
//     instant UTC ; calculer le calendrier directement sur ses composantes UTC ferait basculer la
//     limite d'un jour chaque fois que l'heure locale NC et la date UTC de l'instant divergent
//     (l'écart entre les deux traverse minuit UTC/NC à des heures différentes de la journée — c'est
//     visible dès qu'un encaissement tombe près de cette frontière). D'où l'obligation de
//     DÉCOMPOSER l'instant en composantes locales NC, d'ajouter le mois sur CES composantes, puis
//     de RECOMPOSER un instant — jamais l'inverse.
//
//  4. BORNE INCLUSE : à la milliseconde près, la limite est ENCORE acceptée ; au-delà, refus.
//
// `estDansLaFenetre` reçoit `maintenant` en PARAMÈTRE (défaut `new Date()`) et ne le lit JAMAIS
// lui-même au fond du module : un module qui lit l'horloge système ne peut pas être testé sur ses
// bornes (cf. lib/fenetre-correction.test.ts).

const NC_OFFSET_MS = 11 * 60 * 60_000; // UTC+11 FIXE — jamais d'heure d'été en Nouvelle-Calédonie.

/** Composantes calendaires — lues/écrites en heure LOCALE NC (jamais en heure système du process). */
type ComposantesNC = {
  annee: number;
  mois: number; // 0-11, comme Date#getUTCMonth
  jour: number;
  heure: number;
  minute: number;
  seconde: number;
  ms: number;
};

/**
 * Décompose un instant UTC en composantes calendaires NC.
 *
 * ASTUCE : on décale l'instant de +11h puis on relit ses composantes **UTC** — un `Date` UTC décalé
 * de +11h a, dans ses champs `getUTC*`, exactement les valeurs qu'aurait une horloge murale à Nouméa
 * au même instant. C'est l'inverse de `composerNC` ci-dessous.
 */
function decomposerNC(instant: Date): ComposantesNC {
  const local = new Date(instant.getTime() + NC_OFFSET_MS);
  return {
    annee: local.getUTCFullYear(),
    mois: local.getUTCMonth(),
    jour: local.getUTCDate(),
    heure: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    seconde: local.getUTCSeconds(),
    ms: local.getUTCMilliseconds(),
  };
}

/** Recompose un instant UTC à partir de composantes calendaires NC (inverse de `decomposerNC`). */
function composerNC(c: ComposantesNC): Date {
  const commeSiUtc = Date.UTC(c.annee, c.mois, c.jour, c.heure, c.minute, c.seconde, c.ms);
  return new Date(commeSiUtc - NC_OFFSET_MS);
}

/** Nombre de jours du mois `mois` (0-11) de l'année `annee` — le jour 0 du mois suivant. */
function joursDansLeMois(annee: number, mois: number): number {
  return new Date(Date.UTC(annee, mois + 1, 0)).getUTCDate();
}

/**
 * Limite de correction : l'instant `origine` + 1 mois calendaire, en heure NC. Débordement de
 * quantième clampé au dernier jour du mois d'arrivée (règle 2 ci-dessus).
 */
export function limiteDeCorrection(origine: Date): Date {
  const c = decomposerNC(origine);
  let mois = c.mois + 1;
  let annee = c.annee;
  if (mois > 11) {
    mois = 0;
    annee += 1;
  }
  // QUANTIÈME QUI DÉBORDE : on DÉBORDE sur le mois suivant, on ne rabote pas.
  // 🗣️ Marco, 2026-08-26 : « une erreur faite le 31 n'est pas récupérée le 1er. »
  // Raboter donnait au 31 mars une limite au 30 avril — moins d'un mois, alors
  // qu'un paiement du 1er avril avait jusqu'au 1er mai. La fenêtre est « au moins
  // un mois », jamais moins. `composerNC` s'appuie sur `Date.UTC`, qui normalise
  // un quantième hors bornes (31 avril → 1er mai). Jumeau de
  // `01-Core-Compta/core/lib/fenetre-correction.ts` : les deux changent ENSEMBLE.
  return composerNC({ ...c, annee, mois, jour: c.jour });
}

/**
 * `maintenant` est-il encore dans la fenêtre d'un mois calendaire depuis `origine` ? Borne incluse
 * (règle 4). `maintenant` est INJECTÉ (jamais lu au fond du module) — c'est ce qui rend les bornes
 * testables sans horloge réelle.
 */
export function estDansLaFenetre(origine: Date, maintenant: Date = new Date()): boolean {
  return maintenant.getTime() <= limiteDeCorrection(origine).getTime();
}
