// Contrat de lib/z-report.ts — décision PURE extraite de lib/caisse.ts#closeSession, qui n'est PAS
// testable sous `node --test` (il importe `./tenant`, qui importe `next/headers`). Cette fonction
// est le découpage minimal qui rend vérifiable, sans DB ni contexte Next, le point qui MORD sur la
// levée du refus SESSION_CLOSED (lib/payment-correction.ts, décision Marco 2026-08-26) : une
// correction de moyen de paiement peut désormais modifier les `SalePayment` d'une session déjà
// CLOSED — le Z affiché ne doit alors PAS recalculer son attendu, sous peine de contredire son
// propre `varianceXpf` figé.

import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedXpfPourRapport } from "./z-report.ts";

// ─── Session CLOSE : le Z ne bouge pas ──────────────────────────────────────────────────────────

test("session CLOSED : expectedXpf sort de la BASE (figé à la clôture), PAS du recalcul", () => {
  const session = { status: "CLOSED" as const, expectedXpf: 15_000n };
  // `expectedRecalcule` simule ce qu'une correction de moyen de paiement post-clôture ferait
  // remonter en resommant les SalePayment CASH actuels — délibérément DIFFÉRENT de la base figée.
  const expectedRecalcule = 12_000n;
  assert.equal(
    expectedXpfPourRapport(session, expectedRecalcule),
    15_000n,
    "l'attendu figé en base doit gagner, jamais le recalcul à chaud",
  );
});

test("session CLOSED, expectedXpf en base identique au recalcul (cas normal, aucune correction depuis la clôture) : toujours la base", () => {
  const session = { status: "CLOSED" as const, expectedXpf: 15_000n };
  assert.equal(expectedXpfPourRapport(session, 15_000n), 15_000n);
});

// ─── Exception : vieille session CLOSED sans expectedXpf (antérieure au champ) ────────────────

test("session CLOSED avec expectedXpf NULL (vieille session, champ inexistant à l'époque) : retombe sur le recalcul, pas 0", () => {
  const session = { status: "CLOSED" as const, expectedXpf: null };
  assert.equal(
    expectedXpfPourRapport(session, 12_000n),
    12_000n,
    "0 mentirait plus grossièrement qu'un attendu recalculé",
  );
});

// ─── Session OPEN : toujours le recalcul, jamais la base (qui n'a d'ailleurs aucun sens tant que
//     la session n'est pas close : `session.expectedXpf` est NULL en base pour une session OPEN) ─

test("session OPEN : expectedXpf est TOUJOURS le recalcul (comportement inchangé)", () => {
  const session = { status: "OPEN" as const, expectedXpf: null };
  assert.equal(expectedXpfPourRapport(session, 8_000n), 8_000n);
});

test("session OPEN : même si expectedXpf porte une valeur en base (ne devrait pas arriver), le recalcul gagne quand même", () => {
  // Défense en profondeur : la condition ne teste PAS seulement `expectedXpf != null`, elle exige
  // aussi `status === "CLOSED"` — une session encore ouverte ne fige jamais son attendu.
  const session = { status: "OPEN" as const, expectedXpf: 999_999n };
  assert.equal(expectedXpfPourRapport(session, 8_000n), 8_000n);
});
