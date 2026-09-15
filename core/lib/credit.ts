// lib/credit.ts — VENTE À CRÉDIT (échéancier, lot A, 2026-09-15) : décisions PURES, sans DB — même
// patron que lib/money.ts / lib/void-sale.ts / lib/z-report.ts : zéro import runtime → testable
// sans Prisma/Next (cf. lib/credit.test.ts). lib/caisse.ts et la route checkout branchent ces
// fonctions sur les vrais paiements/totaux.
//
// DÉCISIONS MARCO (15/09) :
//   - 1er versement : montant LIBRE, strictement > 0, encaissé le jour même. La vente passe PAID
//     comme aujourd'hui — ce n'est PAS un nouveau statut, juste un ticket soldé en dessous du total.
//   - `dueAt` porte la date de la DERNIÈRE échéance (YYYY-MM-DD), transmise à Core-Compta.
//   - Les échéances ULTÉRIEURES sont un encaissement MANUEL — HORS de ce lot A.
//   - Le Z compte UNIQUEMENT ce qui est encaissé, et affiche une ligne « dont à crédit »
//     (cf. lib/z-report.ts#creditXpfPourRapport).

/** Portée par `CheckoutOptions.credit` (lib/caisse.ts) — absent = comportement inchangé. */
export type CreditOptions = { dueAt: string };

const DUE_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valide la FORME de `credit.dueAt` (format + date calendaire réelle — `2026-02-30` est rejeté,
 * `Date.UTC` le normaliserait en silence en `2026-03-02`). `null` = invalide. Utilisée par la
 * route (400) ET par `dueAtNoonUtcIso` ci-dessous.
 */
export function parseDueAt(dueAt: string): Date | null {
  if (!DUE_AT_RE.test(dueAt)) return null;
  const [y, m, d] = dueAt.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/**
 * ISO 8601 à MIDI UTC pour le jour `dueAt` — c'est cette chaîne qui part à Core-Compta
 * (`CreateInvoiceInput.dueAt`, lib/clients.ts). ANCRAGE MIDI (piège +11, cf. mémoire
 * `prisma-db-date-pas-de-decalage-utc`) : la Nouvelle-Calédonie est UTC+11, un `new
 * Date("YYYY-MM-DD")` (minuit UTC) affiché en local retomberait sur la VEILLE. Midi UTC = 23h
 * locale, encore dans le bon jour calendaire. `null` si `dueAt` est invalide (ne devrait pas
 * arriver : la route l'a déjà validé en 400 avant d'appeler `checkoutSale`).
 */
export function dueAtNoonUtcIso(dueAt: string): string | null {
  const d = parseDueAt(dueAt);
  return d ? d.toISOString() : null;
}

export type CreditGuardResult =
  | { ok: true }
  | { ok: false; error: "UNDERPAID"; totalXpf: bigint; paidXpf: bigint }
  | { ok: false; error: "CREDIT_NOT_NEEDED" }
  | { ok: false; error: "CREDIT_NEEDS_DEPOSIT" };

/**
 * Garde UNDERPAID de `checkoutSale` (lib/caisse.ts, section ENCAISSEMENT) — extraite ici pour être
 * testable sans DB.
 *
 * SANS `credit` : comportement STRICTEMENT inchangé — `UNDERPAID` dès que `paidXpf < totalXpf`.
 * AVEC `credit` : la vente peut passer PAID sous-payée —
 *   - `paidXpf >= totalXpf` → `CREDIT_NOT_NEEDED` (rien à créditer, la vente est déjà soldée) ;
 *   - `paidXpf <= 0`        → `CREDIT_NEEDS_DEPOSIT` (un crédit exige un 1er versement > 0) ;
 *   - `0 < paidXpf < totalXpf` → accepté.
 */
export function checkoutUnderpaidGuard(
  totalXpf: bigint,
  paidXpf: bigint,
  credit: CreditOptions | undefined,
): CreditGuardResult {
  if (!credit) {
    if (paidXpf < totalXpf) return { ok: false, error: "UNDERPAID", totalXpf, paidXpf };
    return { ok: true };
  }
  if (paidXpf >= totalXpf) return { ok: false, error: "CREDIT_NOT_NEEDED" };
  if (paidXpf <= 0n) return { ok: false, error: "CREDIT_NEEDS_DEPOSIT" };
  return { ok: true };
}
