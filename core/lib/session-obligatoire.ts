// « Pas d'encaissement sans caisse ouverte » — la RÈGLE, à l'état pur.
//
// PUR = aucun import runtime (ni @prisma/client, ni next/*, ni ./tenant) : le runner du repo
// (`node --test --experimental-strip-types "lib/**/*.test.ts"`) exécute ces fichiers directement.
// Même contrat que lib/money.ts, lib/cash-movement.ts, lib/fenetre-correction.ts.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// CE QUE CE MODULE FERME, ET POURQUOI IL N'EST PAS QU'UN `if`
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// 🗣️ Marco, 2026-09-01 : « un encaissement ne devrait pas être possible sans ouvrir de caisse.
//    aujourd'hui chez Ellément, son premier rdv n'est pas inscrit en caisse. »
//    Et, une fois le périmètre tranché : « il faut seulement que la caisse soit ouverte pour
//    encaisser à partir de maintenant. »
//
// `Sale.sessionId` est NULLABLE et personne ne le remplissait de force : une vente créée sans
// session n'entre dans AUCUN Z (`closeSession` filtre `sessionId = <la session>`), alors qu'elle
// est bel et bien encaissée et facturée. L'argent existe partout sauf dans la clôture de caisse.
//
// ⚠️ LE TROU A DEUX CAUSES, ET UNE SEULE SE VOIT. Ne fermer que la première laisserait l'autre
// entière :
//
//  1. AUCUNE SESSION N'EST OUVERTE. C'est le cas d'Ellément : ticket créé à 10h22, session
//     ouverte à 10h25 — trois minutes. La gérante a encaissé son premier rendez-vous avant
//     d'ouvrir sa caisse. Visible, racontable, et c'est celui auquel on pense.
//
//  2. UNE SESSION EST OUVERTE, MAIS L'ÉCRAN NE LE SAIT PAS. Les cinq surfaces dérivent le
//     `sessionId` côté client (`app/app/admin/page.tsx`) par un appel service-à-service
//     `GET /api/sessions`, terminé par `.catch(() => null)`. Un moteur qui hoquette, une clé
//     S2S en défaut, une page chargée AVANT l'ouverture de la caisse : la surface envoie `null`
//     alors que la session existe. Aucun écran ne peut corriger ça — l'écran est justement
//     celui qui se trompe. Seul le moteur sait.
//
// D'où la forme de la règle : le `sessionId` de l'appelant n'est plus une CONSIGNE, c'est une
// PROPOSITION. Le moteur tranche, et il ne refuse qu'en dernier recours — quand il n'y a
// réellement aucune caisse ouverte à laquelle rattacher la vente.
//
// 🛑 CE QUI N'EST PAS DE LA COMPÉTENCE DE CE MODULE, ET QUI COMPTE AUTANT : le refus ne doit
// JAMAIS être un cul-de-sac au comptoir. Une cliente carte à la main, et le logiciel qui répond
// « impossible, la caisse n'est pas ouverte », c'est pire que le trou qu'on ferme. `REFUSEE` est
// donc un signal ADRESSÉ À L'ÉCRAN — « propose d'ouvrir la caisse, puis rejoue » — et pas une fin
// de non-recevoir. Le refus tombe AVANT toute écriture : aucun ticket créé, aucun paiement
// enregistré, aucune facture émise, rien à défaire, rien à ressaisir.

/** Ce que l'appelant a proposé comme session, tel qu'on l'a relu en base. */
export type SessionProposee = {
  id: string;
  /** `"OPEN"` | `"CLOSED"` — redéclaré en chaîne pour garder ce module pur (l'enum vit dans Prisma). */
  status: string;
};

export type EntreeDecisionSession = {
  /**
   * La session que l'appelant a demandée, RELUE EN BASE (id + statut), ou `null` s'il n'en a
   * proposé aucune / si celle qu'il a proposée n'existe pas pour ce tenant.
   *
   * ⚠️ On relit, on ne fait pas confiance : une surface dérive ce `sessionId` au chargement de
   * la page et peut le porter des heures. Entre-temps la session a pu être CLÔTURÉE. La croire
   * sur parole rattacherait une vente d'aujourd'hui à un Z d'hier — dont l'`expectedXpf` est
   * FIGÉ (`closeSession`) et ne bougera plus. On aurait déplacé l'écart muet, pas supprimé.
   */
  sessionProposee: SessionProposee | null;
  /** La session réellement OUVERTE du tenant (pour ce poste), ou `null`. */
  sessionOuverteId: string | null;
  /**
   * La vente est-elle une REMONTÉE DIFFÉRÉE (caisse hors ligne) ?
   *
   * 🛑 C'est l'exemption qui empêche cette garde de casser un marchand en production. La
   * Rôtisserie de Pouembout n'a pas de réseau sur place : elle encaisse hors ligne sur deux
   * tablettes, tient son Z EN LOCAL, et remonte ses ventes une fois par jour — `sessionId` nul,
   * délibérément (`Rotisserie-Pouembout/surface/app/api/synchro/route.ts`). Sa clôture arrive
   * par un chemin séparé (`POST /api/sessions/import`), qui crée une `CashSession` déjà CLOSED
   * et ne rattache aucune vente : « la tablette est la source de vérité, son Z est une pièce
   * déjà établie ».
   *
   * Exiger d'elle une session serveur OUVERTE serait exiger l'impossible : au moment où la
   * synchro tourne, il est le soir, la caisse est fermée depuis des heures, et il n'y a jamais
   * eu de session serveur. Sa synchro échouerait en silence (`echecs.push`), les tickets
   * resteraient bloqués sur la tablette, et personne ne verrait rien avant la compta du mois.
   */
  remonteeDifferee: boolean;
};

export type DecisionSession =
  /** L'appelant a proposé une session ouverte et valide : on la garde. Cas nominal du comptoir. */
  | { action: "FOURNIE"; sessionId: string }
  /** L'appelant n'a rien proposé (ou du périmé), mais une caisse est ouverte : le moteur l'estampille. */
  | { action: "ESTAMPILLEE"; sessionId: string }
  /** Remontée différée : le rattachement appartient à la source, pas à ce moteur. */
  | { action: "EXEMPTEE"; sessionId: string | null }
  /** Aucune caisse ouverte : on refuse AVANT d'écrire quoi que ce soit. À l'écran de proposer l'ouverture. */
  | { action: "REFUSEE"; error: "NO_OPEN_SESSION" };

/**
 * Décide à quelle session de caisse rattacher une vente qui naît.
 *
 * L'ORDRE DES QUATRE RÈGLES EST LA DÉCISION — pas un détail d'écriture :
 *
 *  1. **Remontée différée d'abord.** Une caisse hors ligne n'est pas jugeable par l'état du
 *     serveur « maintenant » : sa vente a eu lieu il y a des heures, ailleurs, et son Z est déjà
 *     clos. On lui rend ce qu'elle a proposé (souvent rien) et on ne refuse jamais. Placer cette
 *     règle en 2e ou en 3e la rendrait inatteignable dès qu'une caisse serveur serait ouverte
 *     par ailleurs — et la Rôtisserie se ferait estampiller la session d'un autre comptoir.
 *
 *  2. **Une session proposée et OUVERTE fait foi.** C'est le chemin du comptoir (le pavé de
 *     vente n'est même pas monté sans session) et celui des postes multiples : l'appelant sait
 *     de quel tiroir il parle, et le moteur n'a aucune raison de le corriger.
 *
 *  3. **Sinon, la caisse ouverte du moment.** C'est ici que se referme la cause n°2, celle qu'on
 *     ne voit pas : la surface a proposé `null` (ou une session close et périmée) alors qu'une
 *     caisse est bel et bien ouverte. Le moteur ne lui demande pas son avis, il estampille.
 *
 *  4. **Aucune caisse ouverte → refus.** Et seulement là. C'est la règle de Marco, littéralement.
 */
export function decideSessionVente(e: EntreeDecisionSession): DecisionSession {
  if (e.remonteeDifferee) {
    return { action: "EXEMPTEE", sessionId: e.sessionProposee?.id ?? null };
  }
  if (e.sessionProposee && e.sessionProposee.status === "OPEN") {
    return { action: "FOURNIE", sessionId: e.sessionProposee.id };
  }
  if (e.sessionOuverteId) {
    return { action: "ESTAMPILLEE", sessionId: e.sessionOuverteId };
  }
  return { action: "REFUSEE", error: "NO_OPEN_SESSION" };
}

/**
 * Le `sessionId` à écrire, ou `undefined` quand la décision est un refus.
 *
 * Sépare volontairement « quelle décision » de « quelle valeur » : le premier se raconte dans un
 * Z et dans un journal, le second s'écrit en base. Les confondre obligerait chaque appelant à
 * refaire le `switch`, et c'est comme ça qu'une branche finit par manquer.
 */
export function sessionIdADecision(d: DecisionSession): string | null | undefined {
  return d.action === "REFUSEE" ? undefined : d.sessionId;
}
