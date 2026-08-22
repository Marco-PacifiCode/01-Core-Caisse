// lib/import-cloture.ts — VALIDATION PURE d'un import de clôture Z déjà faite hors ligne (sans
// DB) — même schéma de séparation que lib/void-sale.ts et lib/sync.ts : la logique métier est
// isolée ici, testable sans base ; caisse.ts (`importerCloture`) la branche sur Prisma/withTenant
// pour la persistance et l'idempotence (P2002, relecture — cf. openSession).
//
// CONTEXTE (Rôtisserie de Pouembout) : sa tablette encaisse hors ligne, remonte ses VENTES une
// fois par jour (elles arrivent déjà avec sessionId = null) et ARCHIVE ses clôtures Z EN LOCAL —
// elles n'atteignent jamais ce moteur.
//
// DÉCISION DE CONCEPTION (ne pas la rediscuter) : on n'essaie PAS de rattacher après coup les
// ventes à une session, et on NE RECALCULE PAS le Z côté serveur. La tablette est la source de
// vérité : son Z est une PIÈCE DÉJÀ ÉTABLIE, on l'importe telle quelle. Ce qu'un Z apporte au
// serveur et que les ventes ne donnent pas, c'est le RAPPROCHEMENT DE CAISSE (fond, comptage,
// écart) — c'est la seule chose que ce module calcule.
//
// ⚠️ ROUTE SÉPARÉE, JAMAIS LE CHEMIN VIVANT : openSession/closeSession servent les 3 autres
// marchands en temps réel et ne sont touchés par aucune ligne de ce chantier. L'import est un
// second chemin, isolé, qui crée une session directement CLOSED.

export type ImportClotureInput = {
  sourceType?: string | null;
  sourceId?: string | null;
  posteId?: string | null;
  openedAt?: string | null; // ISO 8601
  closedAt?: string | null; // ISO 8601
  openingFloatXpf?: number | null; // XPF entier
  closingCountedXpf?: number | null; // XPF entier
  // Attendu calculé PAR LA TABLETTE sur ses propres ventes (fond + espèces) — le serveur ne peut
  // pas le recalculer ici, il n'a jamais vu ces ventes. Ce n'est PAS `varianceXpf` : lui reste
  // toujours calculé ci-dessous, jamais repris de l'appelant.
  expectedXpf?: number | null; // XPF entier
  note?: string | null;
};

export type ImportClotureError = "SOURCE_REQUISE" | "DATES_INVALIDES" | "MONTANT_INVALIDE";

export type PreparedClotureImport = {
  sourceType: string;
  sourceId: string;
  posteId: string | null;
  openedAt: Date;
  closedAt: Date;
  openingFloatXpf: bigint;
  closingCountedXpf: bigint;
  expectedXpf: bigint;
  // 🔒 TOUJOURS `closingCountedXpf - expectedXpf`, JAMAIS une valeur fournie par l'appelant :
  // un écart qu'on accepterait tel quel ne serait plus un contrôle, seulement une recopie.
  varianceXpf: bigint;
  note: string | null;
};

export type PrepareClotureImportResult =
  | { ok: false; error: ImportClotureError }
  | ({ ok: true } & PreparedClotureImport);

/** Même tolérance de dérive d'horloge que `createSale` (lib/caisse.ts, FUTURE_DATE). */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * Valide et met en forme un import de clôture Z. N'écrit RIEN : l'idempotence sur
 * (tenantId, sourceType, sourceId) et la persistance sont du ressort de `importerCloture`
 * (lib/caisse.ts) — cette fonction ne connaît même pas le tenant.
 */
export function prepareClotureImport(input: ImportClotureInput): PrepareClotureImportResult {
  const sourceType = input.sourceType?.trim() || "";
  const sourceId = input.sourceId?.trim() || "";
  // Obligatoires : sans eux, pas d'idempotence, et une journée réémise créerait un doublon.
  if (!sourceType || !sourceId) return { ok: false, error: "SOURCE_REQUISE" };

  if (!input.openedAt || !input.closedAt) return { ok: false, error: "DATES_INVALIDES" };
  const openedAt = new Date(input.openedAt);
  const closedAt = new Date(input.closedAt);
  if (Number.isNaN(openedAt.getTime()) || Number.isNaN(closedAt.getTime())) {
    return { ok: false, error: "DATES_INVALIDES" };
  }
  if (closedAt.getTime() < openedAt.getTime()) return { ok: false, error: "DATES_INVALIDES" };
  const limit = Date.now() + FUTURE_TOLERANCE_MS;
  if (openedAt.getTime() > limit || closedAt.getTime() > limit) {
    return { ok: false, error: "DATES_INVALIDES" };
  }

  const { openingFloatXpf, closingCountedXpf, expectedXpf } = input;
  if (
    openingFloatXpf === undefined ||
    openingFloatXpf === null ||
    !Number.isInteger(openingFloatXpf) ||
    closingCountedXpf === undefined ||
    closingCountedXpf === null ||
    !Number.isInteger(closingCountedXpf) ||
    expectedXpf === undefined ||
    expectedXpf === null ||
    !Number.isInteger(expectedXpf)
  ) {
    return { ok: false, error: "MONTANT_INVALIDE" };
  }
  if (openingFloatXpf < 0 || closingCountedXpf < 0) return { ok: false, error: "MONTANT_INVALIDE" };

  const opening = BigInt(openingFloatXpf);
  const closing = BigInt(closingCountedXpf);
  const expected = BigInt(expectedXpf);

  return {
    ok: true,
    sourceType,
    sourceId,
    posteId: input.posteId?.trim() || null,
    openedAt,
    closedAt,
    openingFloatXpf: opening,
    closingCountedXpf: closing,
    expectedXpf: expected,
    varianceXpf: closing - expected,
    note: input.note?.trim() || null,
  };
}
