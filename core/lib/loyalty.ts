// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/loyalty.ts — logique PURE de la fidélité (lot C1, plan Salon-Reference 2026-09-15).
//
// UN JOURNAL, PAS UN SOLDE EN CACHE. Ce module ne touche aucune base : les soldes (compteur de
// visites, points, récompenses disponibles) se dérivent à la lecture à partir des lignes de
// LoyaltyEntry (voir prisma/schema.prisma). Rien ici n'écrit, rien ne lit d'horloge implicite —
// chaque fonction qui a besoin de « maintenant » le reçoit en paramètre.
//
// PAS DE NOUVEL ENUM : `mode`, `pointsBase`, `rewardKind`, `rewardBase` sont des `String` côté
// Prisma (une valeur d'enum PostgreSQL ne se retire jamais). Ce module est la SEULE source de
// vérité de leurs valeurs autorisées et de leurs bornes.
//
// CONTRAT DE PURETÉ (identique à lib/money.ts et lib/gift-card.ts) : AUCUN import runtime — ni
// `@prisma/client`, ni `next/*`, ni `./tenant`. Le runner de tests est
// `node --test --experimental-strip-types`, qui exécute ce fichier directement.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type LoyaltyMode = "OFF" | "COUNTER" | "VISITS" | "POINTS";
export type LoyaltyBase = "SERVICES" | "ALL";
export type RewardKind = "PERCENT" | "AMOUNT";

export const LOYALTY_LINE_PREFIX = "Fidélité · ";

// ── validateProgram ──────────────────────────────────────────────────────────────────────────

export type LoyaltyProgramInput = {
  mode: string;
  visitsPerReward?: number | null;
  pointsPerHundredXpf?: number | null;
  pointsBase?: string | null;
  pointsPerReward?: number | null;
  rewardKind?: string | null;
  rewardPercent?: number | null;
  rewardAmountXpf?: bigint | null;
  rewardBase?: string | null;
  rewardValidityMonths?: number | null;
  clientPortalVisible?: boolean | null;
};

export type LoyaltyProgramData = {
  mode: LoyaltyMode;
  visitsPerReward: number | null;
  pointsPerHundredXpf: number | null;
  pointsBase: LoyaltyBase;
  pointsPerReward: number | null;
  rewardKind: RewardKind | null;
  rewardPercent: number | null;
  rewardAmountXpf: bigint | null;
  rewardBase: LoyaltyBase;
  rewardValidityMonths: number | null;
  clientPortalVisible: boolean;
};

export type ValidateProgramResult =
  | { ok: true; data: LoyaltyProgramData }
  | { ok: false; error: string };

/**
 * Valide et normalise les réglages du programme de fidélité. `COUNTER` et `OFF` ignorent les
 * champs de récompense — ils ne sont ni exigés ni bornés dans ces modes.
 */
export function validateProgram(input: LoyaltyProgramInput): ValidateProgramResult {
  const mode = input.mode;
  if (mode !== "OFF" && mode !== "COUNTER" && mode !== "VISITS" && mode !== "POINTS") {
    return { ok: false, error: "MODE_INVALID" };
  }

  const pointsBase = input.pointsBase ?? "SERVICES";
  if (pointsBase !== "SERVICES" && pointsBase !== "ALL") {
    return { ok: false, error: "POINTS_BASE_INVALID" };
  }
  const rewardBase = input.rewardBase ?? "SERVICES";
  if (rewardBase !== "SERVICES" && rewardBase !== "ALL") {
    return { ok: false, error: "REWARD_BASE_INVALID" };
  }

  let visitsPerReward: number | null = null;
  let pointsPerHundredXpf: number | null = null;
  let pointsPerReward: number | null = null;
  let rewardKind: RewardKind | null = null;
  let rewardPercent: number | null = null;
  let rewardAmountXpf: bigint | null = null;

  if (mode === "VISITS") {
    if (input.visitsPerReward == null) return { ok: false, error: "VISITS_PER_REWARD_REQUIRED" };
    if (
      !Number.isInteger(input.visitsPerReward) ||
      input.visitsPerReward < 2 ||
      input.visitsPerReward > 50
    ) {
      return { ok: false, error: "VISITS_PER_REWARD_OUT_OF_RANGE" };
    }
    visitsPerReward = input.visitsPerReward;
  }

  if (mode === "POINTS") {
    if (input.pointsPerHundredXpf == null) {
      return { ok: false, error: "POINTS_PER_HUNDRED_XPF_REQUIRED" };
    }
    if (
      !Number.isInteger(input.pointsPerHundredXpf) ||
      input.pointsPerHundredXpf < 1 ||
      input.pointsPerHundredXpf > 100
    ) {
      return { ok: false, error: "POINTS_PER_HUNDRED_XPF_OUT_OF_RANGE" };
    }
    pointsPerHundredXpf = input.pointsPerHundredXpf;

    if (input.pointsPerReward == null) return { ok: false, error: "POINTS_PER_REWARD_REQUIRED" };
    if (
      !Number.isInteger(input.pointsPerReward) ||
      input.pointsPerReward < 1 ||
      input.pointsPerReward > 1000000
    ) {
      return { ok: false, error: "POINTS_PER_REWARD_OUT_OF_RANGE" };
    }
    pointsPerReward = input.pointsPerReward;
  }

  if (mode === "VISITS" || mode === "POINTS") {
    if (input.rewardKind !== "PERCENT" && input.rewardKind !== "AMOUNT") {
      return { ok: false, error: "REWARD_KIND_REQUIRED" };
    }
    rewardKind = input.rewardKind;

    if (rewardKind === "PERCENT") {
      if (input.rewardPercent == null) return { ok: false, error: "REWARD_PERCENT_REQUIRED" };
      if (
        !Number.isInteger(input.rewardPercent) ||
        input.rewardPercent < 1 ||
        input.rewardPercent > 99
      ) {
        return { ok: false, error: "REWARD_PERCENT_OUT_OF_RANGE" };
      }
      rewardPercent = input.rewardPercent;
    } else {
      if (input.rewardAmountXpf == null) return { ok: false, error: "REWARD_AMOUNT_XPF_REQUIRED" };
      if (input.rewardAmountXpf < 1n || input.rewardAmountXpf > 1000000n) {
        return { ok: false, error: "REWARD_AMOUNT_XPF_OUT_OF_RANGE" };
      }
      rewardAmountXpf = input.rewardAmountXpf;
    }
  }

  let rewardValidityMonths: number | null = null;
  if (input.rewardValidityMonths != null) {
    if (
      !Number.isInteger(input.rewardValidityMonths) ||
      input.rewardValidityMonths < 1 ||
      input.rewardValidityMonths > 60
    ) {
      return { ok: false, error: "REWARD_VALIDITY_MONTHS_OUT_OF_RANGE" };
    }
    rewardValidityMonths = input.rewardValidityMonths;
  }

  return {
    ok: true,
    data: {
      mode,
      visitsPerReward,
      pointsPerHundredXpf,
      pointsBase,
      pointsPerReward,
      rewardKind,
      rewardPercent,
      rewardAmountXpf,
      rewardBase,
      rewardValidityMonths,
      clientPortalVisible: input.clientPortalVisible ?? false,
    },
  };
}

// ── nextActivatedAt ──────────────────────────────────────────────────────────────────────────

/** `now` au passage OFF -> mode actif ; inchangé sinon (y compris entre deux modes actifs). */
export function nextActivatedAt(
  prev: Date | null,
  prevMode: string,
  nextMode: string,
  now: Date,
): Date | null {
  if (prevMode === "OFF" && nextMode !== "OFF") return now;
  return prev;
}

// ── pointsForSale ────────────────────────────────────────────────────────────────────────────

export type LoyaltyLineLike = { kind: string; lineXpf: bigint };

/**
 * Points gagnés sur un ticket. Assiette `SERVICES` = lignes `SERVICE` + lignes négatives (un bon
 * ou une remise réduit l'assiette). Assiette `ALL` = `totalXpf` MOINS `giftCardSalesXpf`.
 * Plafonnée à ce qui a été réellement encaissé (`encaisseXpf`) : un ticket à crédit ne fait
 * gagner des points que sur le premier versement (cf. plan §6 piège 6).
 *
 * `giftCardSalesXpf` — DÉCISION MARCO (complément du 2026-09-15, après le lancement de C1) : un
 * bon cadeau ne rapporte JAMAIS de points, quelle que soit l'assiette. L'assiette `SERVICES`
 * l'exclut déjà d'elle-même (une vente de bon n'est pas une ligne `SERVICE`). Pour `ALL`, il faut
 * un paramètre EXPLICITE plutôt qu'une déduction depuis `lines` :
 *
 *   VÉRIFIÉ dans `lib/caisse.ts` (Core-Caisse) et `finance-actions.ts` (surface,
 *   `checkoutTicket`) : une vente de bon cadeau n'est PAS un `LineKind` dédié (l'enum ne connaît
 *   que `SERVICE | PRODUCT | OTHER`, et un nouvel enum est exclu — cf. schema.prisma). C'est une
 *   ligne `SaleLine` ORDINAIRE de `kind: "OTHER"`, au label libre posé par la surface
 *   (`finance-actions.ts` : « ⚠️ L'appelant doit AUSSI poser la ligne de vente correspondante
 *   dans `lines` (une ligne `OTHER` au montant du bon) »). `OTHER` est PARTAGÉ avec toute autre
 *   ligne divers (remise, frais) : rien dans `{kind, lineXpf}` ne distingue structurellement une
 *   vente de bon d'un autre `OTHER`. Le SEUL lien non ambigu est `GiftCard.saleId` (le bon créé
 *   DANS la transaction de la vente, cf. `checkoutSale` / `giftCardsToIssue`) — PAS une ligne.
 *   D'où ce paramètre : l'appelant (C2) le calcule en sommant `GiftCard.amountXpf` des bons émis
 *   par CETTE vente, jamais en inspectant `lines`. Omis = 0n, comportement inchangé.
 */
export function pointsForSale(
  lines: LoyaltyLineLike[],
  totalXpf: bigint,
  encaisseXpf: bigint,
  base: LoyaltyBase,
  perHundred: number,
  giftCardSalesXpf: bigint = 0n,
): number {
  let assietteXpf: bigint;
  if (base === "ALL") {
    assietteXpf = totalXpf - giftCardSalesXpf;
  } else {
    assietteXpf = 0n;
    for (const l of lines) {
      if (l.kind === "SERVICE" || l.lineXpf < 0n) assietteXpf += l.lineXpf;
    }
  }

  if (assietteXpf < 0n) assietteXpf = 0n;
  if (assietteXpf > encaisseXpf) assietteXpf = encaisseXpf;

  const points = (assietteXpf / 100n) * BigInt(perHundred);
  return Number(points);
}

// ── rewardDiscountXpf ────────────────────────────────────────────────────────────────────────

export type LoyaltyRewardSnapshotLike = {
  rewardKind: string | null;
  rewardPercent: number | null;
  rewardAmountXpf: bigint | null;
  rewardBase: string | null;
};

/**
 * Remise en XPF d'une récompense, appliquée à un ticket. Reliquat perdu, JAMAIS le ticket entier
 * gratuit : plafonné à `base - 1n` (et `0n` si la base ne dépasse pas 1 F), pour qu'une ligne de
 * remise ne puisse jamais annuler la totalité d'une vente.
 */
export function rewardDiscountXpf(
  snapshot: LoyaltyRewardSnapshotLike,
  lines: LoyaltyLineLike[],
): bigint {
  let base = 0n;
  for (const l of lines) {
    if (l.lineXpf <= 0n) continue;
    if (snapshot.rewardBase === "SERVICES" && l.kind !== "SERVICE") continue;
    base += l.lineXpf;
  }

  if (base <= 1n) return 0n;

  let result: bigint;
  if (snapshot.rewardKind === "PERCENT") {
    const pct = BigInt(snapshot.rewardPercent ?? 0);
    result = (base * pct * 10000n + 500000n) / 1000000n;
  } else {
    const amount = snapshot.rewardAmountXpf ?? 0n;
    result = amount < base ? amount : base;
  }

  const cap = base - 1n;
  return result < cap ? result : cap;
}

// ── expiresAtFor ─────────────────────────────────────────────────────────────────────────────

/**
 * Ajoute des mois calendaires en UTC, CLAMPÉ sur le dernier jour du mois cible (pas de
 * débordement type « 31 janvier + 1 mois = 3 mars ») : 31/01 + 1 mois tombe au 28 ou 29/02.
 */
export function expiresAtFor(occurredAt: Date, months: number | null): Date | null {
  if (months === null) return null;

  const y = occurredAt.getUTCFullYear();
  const m = occurredAt.getUTCMonth();
  const targetIndex = m + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(occurredAt.getUTCDate(), daysInTargetMonth);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      occurredAt.getUTCHours(),
      occurredAt.getUTCMinutes(),
      occurredAt.getUTCSeconds(),
      occurredAt.getUTCMilliseconds(),
    ),
  );
}

// ── isRewardAvailable ────────────────────────────────────────────────────────────────────────

export type LoyaltyRewardStateLike = {
  redeemedAt: Date | string | null;
  expiresAt: Date | string | null;
};

/** Une récompense est disponible : ni consommée, ni expirée à `now`. */
export function isRewardAvailable(e: LoyaltyRewardStateLike, now: Date = new Date()): boolean {
  if (e.redeemedAt) return false;
  if (!e.expiresAt) return true;
  const exp = e.expiresAt instanceof Date ? e.expiresAt : new Date(e.expiresAt);
  return exp.getTime() > now.getTime();
}
