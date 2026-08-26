// lib/z-report.ts — décision PURE : quel `expectedXpf` afficher dans le Z (lib/caisse.ts#closeSession).
//
// PUR = aucun import runtime (ni @prisma/client, ni next/*, ni ./tenant) : `lib/caisse.ts` importe
// `./tenant`, qui importe `next/headers` — il ne peut donc PAS être chargé sous
// `node --test --experimental-strip-types` sans contexte Next. Ce fichier est le découpage minimal
// qui rend vérifiable, sans DB ni contexte Next, la règle qui suit (cf. lib/z-report.test.ts).
//
// LA RÈGLE (décision Marco, 2026-08-26) : une correction de moyen de paiement reste possible après
// la clôture Z d'une session (elle ne bloque plus, cf. lib/payment-correction.ts#verifierCorrection).
// « ça se voit au recomptage de la caisse de toute façon » — le Z d'une journée close N'EST PAS
// RÉÉCRIT : il reste tel qu'il a été arrêté, l'écart se constate au recomptage. Concrètement,
// l'ATTENDU (le tiroir) d'une session CLOSED doit venir de la BASE (figé à la clôture), jamais d'un
// recalcul à chaud — sinon une correction postérieure à la clôture changerait un Z que l'écran
// affiche pourtant comme définitif. `closingCountedXpf` et `varianceXpf` sont DÉJÀ figés ainsi
// (lib/caisse.ts#closeSession) ; c'est `expectedXpf` qui manquait à l'appel.
//
// Le tiroir du soir est figé ; la VENTILATION DES VENTES (cashSalesXpf/byMethod/totalSalesXpf dans
// `ZReport`), elle, reste VIVANTE — et c'est voulu : elle décrit les ventes, pas le tiroir, et c'est
// précisément elle qu'on veut voir suivre une correction de moyen de paiement même après clôture.
// Cette fonction ne décide QUE de l'attendu du tiroir ; elle n'a rien à dire sur la ventilation.
export function expectedXpfPourRapport(
  session: { status: "OPEN" | "CLOSED"; expectedXpf: bigint | null },
  expectedRecalcule: bigint,
): bigint {
  // Exception : `expectedXpf` peut être `null` sur une session CLOSED ANTÉRIEURE à l'ajout du champ
  // en base — avant cette date, rien ne le peuplait à la clôture. On retombe alors sur le recalcul
  // plutôt que d'afficher 0, qui mentirait plus grossièrement encore qu'un attendu recalculé.
  if (session.status === "CLOSED" && session.expectedXpf != null) return session.expectedXpf;
  return expectedRecalcule;
}
