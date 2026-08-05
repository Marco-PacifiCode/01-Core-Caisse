// Mouvements de tiroir — règles PURES (sens, agrégation, validation).
//
// PUR = aucun import runtime (ni @prisma/client, ni next/*, ni ./tenant) : le runner du repo
// (`node --test --experimental-strip-types "lib/**/*.test.ts"`) exécute ces fichiers directement,
// sans client Prisma généré ni contexte Next. Même contrat que lib/money.ts et lib/sync.ts.
//
// CE QUE CE MODULE TIENT, ET QUI EST LE CŒUR DU CHANTIER « ÉCART DE CAISSE » :
// l'attendu du Z cesse d'ignorer l'argent qui sort du tiroir autrement que par une vente, SANS
// que le chiffre d'affaires bouge d'un franc. Trésorerie et CA sont deux grandeurs différentes ;
// elles le restent ici.

/** Redéclaré en union de chaînes pour garder ce module PUR (l'enum vit dans Prisma). */
export type CashMovementKind = "REFUND" | "CASH_OUT" | "CASH_IN";

export const CASH_MOVEMENT_KINDS: readonly CashMovementKind[] = ["REFUND", "CASH_OUT", "CASH_IN"];

export type CashMovementLike = {
  kind: CashMovementKind;
  amountXpf: bigint;
};

/**
 * Le SENS d'un mouvement. `amountXpf` est TOUJOURS positif en base : c'est le `kind` qui dit si
 * l'argent entre ou sort. On ne stocke jamais de montant négatif — le reste de ce moteur suppose
 * des montants positifs (`normalizePayments` écrase les ≤ 0) et on ne fabrique pas d'exception.
 */
export function movementSign(kind: CashMovementKind): 1n | -1n {
  return kind === "CASH_IN" ? 1n : -1n;
}

export type MovementTotals = {
  refundsXpf: bigint; // remboursements d'avoirs (positif = montant sorti)
  cashOutXpf: bigint; // prélèvements (positif = montant sorti)
  cashInXpf: bigint; // apports (positif = montant entré)
  netXpf: bigint; // effet NET sur le tiroir : cashIn − refunds − cashOut
};

/**
 * Agrège les mouvements d'une session. Les trois postes restent SÉPARÉS et positifs pour
 * l'affichage du Z (« Remboursements : −3 000 F » se lit mieux qu'un net opaque), et `netXpf`
 * porte l'effet réel sur le tiroir.
 */
export function summarizeMovements(movements: readonly CashMovementLike[]): MovementTotals {
  let refundsXpf = 0n;
  let cashOutXpf = 0n;
  let cashInXpf = 0n;

  for (const m of movements) {
    if (m.kind === "REFUND") refundsXpf += m.amountXpf;
    else if (m.kind === "CASH_OUT") cashOutXpf += m.amountXpf;
    else cashInXpf += m.amountXpf;
  }

  return { refundsXpf, cashOutXpf, cashInXpf, netXpf: cashInXpf - refundsXpf - cashOutXpf };
}

/**
 * L'ATTENDU du tiroir à la clôture.
 *
 *   attendu = fond de caisse + espèces des ventes + apports − remboursements − prélèvements
 *
 * Avant ce chantier, les trois derniers termes n'existaient pas : un remboursement en espèces
 * produisait un écart muet, indiscernable d'une erreur de caisse.
 *
 * ⚠️ `totalSalesXpf` (le chiffre d'affaires) N'ENTRE PAS dans ce calcul et n'est pas touché par
 * les mouvements. C'est la propriété qui justifiait ce modèle plutôt qu'une « vente négative ».
 */
export function expectedCashXpf(args: {
  openingFloatXpf: bigint;
  cashSalesXpf: bigint;
  movements: readonly CashMovementLike[];
}): bigint {
  return args.openingFloatXpf + args.cashSalesXpf + summarizeMovements(args.movements).netXpf;
}

export type MovementRefusal =
  | "AMOUNT_NOT_POSITIVE" // 0 ou négatif : un mouvement nul n'explique rien, un négatif ment sur le sens
  | "AMOUNT_NOT_INTEGER" // XPF = entier. Pas de centime, jamais.
  | "KIND_UNKNOWN"
  | "REASON_REQUIRED"; // un écart de caisse sans justification n'est pas expliqué, il est déplacé

/**
 * Valide et normalise une demande de mouvement venue du réseau. Rend le montant en `bigint` ou
 * un refus nommé — jamais une exception, jamais un `Number`.
 *
 * Accepte l'entier, la chaîne numérique et le `bigint` (les surfaces envoient du JSON, où un
 * BigInt ne survit pas). Refuse tout ce qui a une partie décimale, y compris `3000.0` reçu en
 * nombre — un centime qui entre ici ressortirait dans un Z.
 */
export function normalizeMovementAmount(raw: unknown): { ok: true; amountXpf: bigint } | { ok: false; error: MovementRefusal } {
  let v: bigint;

  if (typeof raw === "bigint") {
    v = raw;
  } else if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, error: "AMOUNT_NOT_INTEGER" };
    if (!Number.isInteger(raw)) return { ok: false, error: "AMOUNT_NOT_INTEGER" };
    if (!Number.isSafeInteger(raw)) return { ok: false, error: "AMOUNT_NOT_INTEGER" };
    v = BigInt(raw);
  } else if (typeof raw === "string") {
    const t = raw.trim();
    if (!/^-?\d+$/.test(t)) return { ok: false, error: "AMOUNT_NOT_INTEGER" };
    v = BigInt(t);
  } else {
    return { ok: false, error: "AMOUNT_NOT_INTEGER" };
  }

  if (v <= 0n) return { ok: false, error: "AMOUNT_NOT_POSITIVE" };
  return { ok: true, amountXpf: v };
}

export function isCashMovementKind(raw: unknown): raw is CashMovementKind {
  return typeof raw === "string" && (CASH_MOVEMENT_KINDS as readonly string[]).includes(raw);
}

/** Nettoie un motif : trim, une seule ligne, 200 caractères. `null` si vide → refus en amont. */
export function normalizeMovementReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return t.replace(/\r\n|\r|\n/g, " ").slice(0, 200);
}

/** Une `ref` vide vaut ABSENTE (`null`) : sinon `@@unique(tenantId, ref)` bloquerait au 2e "". */
export function normalizeMovementRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t.slice(0, 64) : null;
}
