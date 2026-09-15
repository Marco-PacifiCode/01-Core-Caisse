// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/loyalty-db.ts — écritures DB de la fidélité (lot C2, plan Salon-Reference 2026-09-15).
//
// Toutes les fonctions reçoivent un `tx` DÉJÀ ouvert par l'appelant (caisse.ts, dans un
// `withTenant`) : ce module ne connaît ni `prisma` ni `next/*`. C'est ce qui le rend testable
// avec un FAUX `tx` (objet en mémoire qui implémente juste `LoyaltyTx` ci-dessous), sans base ni
// contexte Next — cf. lib/loyalty-checkout.test.ts.
//
// UN JOURNAL, PAS UN SOLDE EN CACHE (cf. lib/loyalty.ts) : chaque écriture est une ligne
// `LoyaltyEntry` NOUVELLE, jamais une mise à jour de compteur. Les seules exceptions sont les
// champs `redeemedAt`/`redeemedSaleId` d'une récompense (consommation / reprise à l'annulation) —
// même règle que le bon cadeau.
//
// IDEMPOTENCE : `insertEntry` catche l'unicité `(tenantId, ref)` (code Postgres/Prisma P2002) et
// rend `{duplicate:true}` SANS lever — un rejeu (webhook réessayé, requête doublée) n'écrit jamais
// deux fois le même fait. Détection par `.code === "P2002"` en duck-typing (pas
// `instanceof Prisma.PrismaClientKnownRequestError`) : ce module n'importe donc AUCUN runtime de
// `@prisma/client`, seulement des types — un faux `tx` peut donc rejeter une "vraie" erreur P2002
// sans avoir à construire la classe d'erreur réelle de Prisma.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { expiresAtFor } from "./loyalty.ts";
import { log } from "./log.ts";

// ── Le sous-ensemble de Prisma.TransactionClient réellement utilisé ici ────────────────────────
// Volontairement étroit (et paramètres en `any`) : la vraie `Prisma.TransactionClient` le
// satisfait structurellement (c'est un sur-ensemble), et un faux `tx` de test n'a que CES
// méthodes à implémenter.

export type LoyaltyTx = {
  loyaltyProgram: {
    findFirst(args: any): Promise<LoyaltyProgramRow | null>;
  };
  loyaltyAccount: {
    upsert(args: any): Promise<{ id: string }>;
    findMany(args: any): Promise<{ id: string; clientFicheId: string; displayName: string }[]>;
  };
  loyaltyEntry: {
    create(args: any): Promise<{ id: string }>;
    // Retour affaibli à `any` : le VRAI `Prisma.TransactionClient` rend `_sum` OPTIONNEL sur
    // `aggregate` (aucune ligne trouvée = `_sum: undefined`, pas `{visits:null,points:null}`) —
    // un type strict ici casserait l'assignabilité structurelle à l'appel réel dans caisse.ts.
    // `sumVisits`/`sumPoints` ci-dessous gèrent l'absence avec `?.` + `?? 0`.
    aggregate(args: any): Promise<any>;
    findFirst(args: any): Promise<any | null>;
    findMany(args: any): Promise<any[]>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  $queryRaw: (...args: any[]) => Promise<unknown>;
};

/** Ligne `LoyaltyProgram` telle que relue de la base (ou un OFF par défaut, cf. caisse.ts). */
export type LoyaltyProgramRow = {
  tenantId: string;
  mode: string;
  visitsPerReward: number | null;
  pointsPerHundredXpf: number | null;
  pointsBase: string;
  pointsPerReward: number | null;
  rewardKind: string | null;
  rewardPercent: number | null;
  rewardAmountXpf: bigint | null;
  rewardBase: string;
  rewardValidityMonths: number | null;
  clientPortalVisible: boolean;
  activatedAt: Date | null;
};

/** Programme OFF par défaut — un tenant qui n'a encore jamais réglé sa fidélité. */
export function offProgram(tenantId: string): LoyaltyProgramRow {
  return {
    tenantId,
    mode: "OFF",
    visitsPerReward: null,
    pointsPerHundredXpf: null,
    pointsBase: "SERVICES",
    pointsPerReward: null,
    rewardKind: null,
    rewardPercent: null,
    rewardAmountXpf: null,
    rewardBase: "SERVICES",
    rewardValidityMonths: null,
    clientPortalVisible: false,
    activatedAt: null,
  };
}

/** P2002 (contrainte unique violée) détecté par duck-typing — voir l'en-tête du fichier. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";
}

// ── lockAccount ──────────────────────────────────────────────────────────────────────────────

/**
 * Trouve-ou-crée le compte fidélité d'une fiche, puis verrouille la ligne (`FOR UPDATE`) pour la
 * durée de la transaction courante — même geste que `lib/sale-lock.ts` : sans ce verrou, deux
 * écritures concurrentes (deux comptoirs, ou une visite et un ajustement ADMIN) liraient la même
 * somme cumulée et pourraient émettre la même récompense deux fois sous deux `ref` différents.
 */
export async function lockAccount(
  tx: LoyaltyTx,
  tenantId: string,
  clientFicheId: string,
  displayName: string,
): Promise<{ id: string }> {
  const account = await tx.loyaltyAccount.upsert({
    where: { tenantId_clientFicheId: { tenantId, clientFicheId } },
    update: { displayName },
    create: { tenantId, clientFicheId, displayName },
    select: { id: true },
  });
  await tx.$queryRaw`SELECT id FROM "LoyaltyAccount" WHERE id = ${account.id}::uuid FOR UPDATE`;
  return { id: account.id };
}

// ── insertEntry ──────────────────────────────────────────────────────────────────────────────

export type InsertEntryData = {
  tenantId: string;
  accountId: string;
  kind: "VISIT" | "POINTS" | "REWARD" | "REDEEM" | "REVERSAL" | "ADJUST";
  visits?: number;
  points?: number;
  rewardKind?: string | null;
  rewardPercent?: number | null;
  rewardAmountXpf?: bigint | null;
  rewardBase?: string | null;
  expiresAt?: Date | null;
  redeemedAt?: Date | null;
  redeemedSaleId?: string | null;
  rewardEntryId?: string | null;
  discountXpf?: bigint | null;
  sourceType: string;
  sourceId: string;
  ref: string;
  saleId?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  reason?: string | null;
  occurredAt: Date;
};

export type InsertEntryResult = { duplicate: false; entry: { id: string } } | { duplicate: true };

/** Écrit une ligne du journal. Doublon sur `(tenantId, ref)` → `{duplicate:true}`, jamais levé. */
export async function insertEntry(tx: LoyaltyTx, data: InsertEntryData): Promise<InsertEntryResult> {
  try {
    const entry = await tx.loyaltyEntry.create({
      data: {
        tenantId: data.tenantId,
        accountId: data.accountId,
        kind: data.kind,
        visits: data.visits ?? 0,
        points: data.points ?? 0,
        rewardKind: data.rewardKind ?? null,
        rewardPercent: data.rewardPercent ?? null,
        rewardAmountXpf: data.rewardAmountXpf ?? null,
        rewardBase: data.rewardBase ?? null,
        expiresAt: data.expiresAt ?? null,
        redeemedAt: data.redeemedAt ?? null,
        redeemedSaleId: data.redeemedSaleId ?? null,
        rewardEntryId: data.rewardEntryId ?? null,
        discountXpf: data.discountXpf ?? null,
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        ref: data.ref,
        saleId: data.saleId ?? null,
        actorId: data.actorId ?? null,
        actorName: data.actorName ?? null,
        reason: data.reason ?? null,
        occurredAt: data.occurredAt,
      },
      select: { id: true },
    });
    return { duplicate: false, entry };
  } catch (e) {
    if (isUniqueViolation(e)) return { duplicate: true };
    throw e;
  }
}

// ── soldes dérivés (jamais un cache écrit) ──────────────────────────────────────────────────
//
// DÉCISION MARCO (15/09) : « À chaque changement de forme ou réactivation, le compteur et les
// points repartent de zéro, comme au premier jour. Les récompenses déjà gagnées restent dues. »
// `activatedAt` (lib/loyalty.ts#nextActivatedAt) est le pivot de cette remise à zéro : le NET
// n'agrège JAMAIS les lignes antérieures à `activatedAt`, quel que soit leur `kind` (VISIT,
// POINTS, ADJUST, REWARD, REVERSAL — un ancien REWARD ou ADJUST ne doit pas continuer de peser
// sur le nouveau compteur). Si `activatedAt` est `null` (programme jamais activé, ou OFF depuis
// toujours), RIEN n'est compté — pas de division par une date qui n'existe pas.
//
// ⚠️ SABOTAGE (contre-QA) : retirer le filtre `occurredAt: { gte: activatedAt }` ci-dessous fait
// ROUGIR « 3 visites VISITS N=5 -> POINTS -> VISITS -> 2 visites -> 0 récompense, net 2 » de
// lib/loyalty-checkout.test.ts. Le rétablir le fait revert au vert.

async function sumVisits(
  tx: LoyaltyTx,
  tenantId: string,
  accountId: string,
  activatedAt: Date | null,
): Promise<number> {
  if (!activatedAt) return 0;
  const agg = await tx.loyaltyEntry.aggregate({
    where: { tenantId, accountId, occurredAt: { gte: activatedAt } },
    _sum: { visits: true },
  });
  return agg?._sum?.visits ?? 0;
}

async function sumPoints(
  tx: LoyaltyTx,
  tenantId: string,
  accountId: string,
  activatedAt: Date | null,
): Promise<number> {
  if (!activatedAt) return 0;
  const agg = await tx.loyaltyEntry.aggregate({
    where: { tenantId, accountId, occurredAt: { gte: activatedAt } },
    _sum: { points: true },
  });
  return agg?._sum?.points ?? 0;
}

// ── émission des récompenses franchies (net réel du compte, jamais un quotient) ────────────────

/**
 * Plafond de sécurité PAR ÉVÉNEMENT (pas par compte) : au-delà, on s'ARRÊTE plutôt que de lever.
 *
 * 🔴 CORRECTIF (2026-09-16, contre-QA) : la version précédente LEVAIT `LoyaltyRewardOverflowError`
 * au-delà de ce plafond — atteignable avec un réglage extrême (ex. 1 point pour une récompense,
 * ticket de 1 000 F à 100 pts/100F), et l'exception pouvait alors faire échouer un encaissement
 * APRÈS que les paiements soient déjà persistés (la boucle tourne dans la transaction de
 * `checkoutSale`, après l'insertion des paiements). Décision : ne JAMAIS lever ici. On crée au
 * plus `MAX_REWARDS_PER_EVENT` récompenses pour CET événement, puis on s'arrête ; le net restant
 * (encore `>= perReward`) N'EST PAS PERDU — il reste dans le journal et sera repris par le
 * PROCHAIN événement qui appelle cette fonction (prochaine visite/vente/ajustement sur ce
 * compte), qui recalcule le net et repart devant. Seul effet du plafond : les récompenses
 * excédentaires attendent un événement de plus pour être émises, au lieu de toutes sortir d'un
 * coup. Un `log.warn` trace le dépassement pour investigation (compte + nombre émis).
 */
const MAX_REWARDS_PER_EVENT = 1000;

/**
 * Émet les récompenses tant que le SOLDE NET du compte (visites OU points, `field`, dérivé à la
 * lecture — §2.2 du plan) atteint le seuil `perReward`. Le net est recalculé par `aggregate` APRÈS
 * l'insertion de la ligne déclenchante, SOUS LE VERROU de compte déjà pris par `lockAccount` — pas
 * de course possible entre la lecture et l'écriture qui suit.
 *
 * 🔴 CORRECTIF (2026-09-16, QA — remplace `issueRewardsForDelta`, supprimée). L'ancienne version
 * comparait `rewardsToCreate(sumAvant,N)` à `rewardsToCreate(sumAprès,N)` — un quotient entier
 * (`Math.floor`) qui ARRONDIT VERS -∞ sur un solde NÉGATIF. Le solde net inclut pourtant les
 * `REWARD` (-N), les `REVERSAL` et les `ADJUST` négatifs : un compte dont le net était retombé
 * sous zéro (récompense déjà émise puis vente annulée, ou correction ADMIN négative) faisait
 * mentir `Math.floor` et une récompense renaissait sur un `ref` neuf sans que la cliente ait
 * regagné le seuil. Preuve : vente 600 pts (seuil 500) → 1 récompense, net 100 ; annulation →
 * net -500 ; vente de 500 pts → l'ancien calcul en créait une 2ᵉ alors que le net n'était qu'à 0.
 * `rewardsToCreate` (lib/loyalty.ts) n'a donc plus AUCUN appelant sur un solde net et a été
 * retirée avec son test — ne pas la réintroduire ici, un quotient ment sur un solde signé.
 *
 * Cette version ne divise JAMAIS : elle consomme le net par tranches de `perReward` tant qu'il
 * les atteint, jamais en dessous (`net >= perReward`, jamais `net > 0`). Un net négatif ou
 * `< perReward` ne crée rien. `i` numérote les récompenses de CETTE fournée — une seule ligne
 * déclenchante peut en franchir plusieurs d'un coup (grosse vente, gros ajustement) — d'où
 * `ref = reward:<triggerRef>:<i>`, toujours neuf : `triggerRef` n'est réutilisé QUE si la ligne
 * déclenchante elle-même est un doublon, auquel cas l'appelant ne va jamais jusqu'ici (cf.
 * `creditVisit`/`creditPoints`/`adjustLoyalty` : `if (inserted.duplicate) return …` AVANT ce point).
 */
async function issueRewardsWhileNetReached(
  tx: LoyaltyTx,
  args: {
    tenantId: string;
    accountId: string;
    field: "visits" | "points";
    perReward: number;
    triggerRef: string;
    /** Pivot de la remise à zéro (décision Marco 15/09, cf. sumVisits/sumPoints ci-dessus) : le
     *  net n'agrège que les lignes `occurredAt >= activatedAt`. `null` -> net 0, rien émis. */
    activatedAt: Date | null;
    snapshot: {
      rewardKind: string | null;
      rewardPercent: number | null;
      rewardAmountXpf: bigint | null;
      rewardBase: string | null;
      rewardValidityMonths: number | null;
    };
    sourceType: string;
    sourceId: string;
    occurredAt: Date;
    actorId?: string | null;
    actorName?: string | null;
  },
): Promise<number> {
  if (args.perReward <= 0) return 0;

  let net =
    args.field === "visits"
      ? await sumVisits(tx, args.tenantId, args.accountId, args.activatedAt)
      : await sumPoints(tx, args.tenantId, args.accountId, args.activatedAt);

  let created = 0;
  let i = 0;
  while (net >= args.perReward) {
    if (i >= MAX_REWARDS_PER_EVENT) {
      log.warn("loyalty.issueRewardsWhileNetReached.capped", {
        tenantId: args.tenantId,
        accountId: args.accountId,
        rewardsCreated: created,
      });
      break;
    }
    const res = await insertEntry(tx, {
      tenantId: args.tenantId,
      accountId: args.accountId,
      kind: "REWARD",
      visits: args.field === "visits" ? -args.perReward : 0,
      points: args.field === "points" ? -args.perReward : 0,
      rewardKind: args.snapshot.rewardKind,
      rewardPercent: args.snapshot.rewardPercent,
      rewardAmountXpf: args.snapshot.rewardAmountXpf,
      rewardBase: args.snapshot.rewardBase,
      expiresAt: expiresAtFor(args.occurredAt, args.snapshot.rewardValidityMonths),
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      ref: `reward:${args.triggerRef}:${i}`,
      actorId: args.actorId ?? null,
      actorName: args.actorName ?? null,
      occurredAt: args.occurredAt,
    });
    if (!res.duplicate) created++;
    net -= args.perReward;
    i++;
  }
  return created;
}

// ── creditVisit ──────────────────────────────────────────────────────────────────────────────

export type CreditVisitArgs = {
  tenantId: string;
  program: LoyaltyProgramRow;
  clientFicheId: string;
  displayName: string;
  appointmentId: string;
  occurredAt: Date;
  actorId?: string | null;
  actorName?: string | null;
};

export type CreditResult = { credited: boolean; rewardsCreated: number };

/**
 * Crédite une visite honorée. Écrit dans TOUTE forme active (compteur seul compris, §2.3 du
 * plan) ; ne crée des récompenses qu'en mode `VISITS`. `OFF`, ou un RDV antérieur à
 * `activatedAt`, n'écrivent rien.
 */
export async function creditVisit(tx: LoyaltyTx, args: CreditVisitArgs): Promise<CreditResult> {
  if (args.program.mode === "OFF") return { credited: false, rewardsCreated: 0 };
  if (args.program.activatedAt && args.occurredAt.getTime() < args.program.activatedAt.getTime()) {
    return { credited: false, rewardsCreated: 0 };
  }

  const account = await lockAccount(tx, args.tenantId, args.clientFicheId, args.displayName);
  const ref = `visit:rdv:${args.appointmentId}`;
  const inserted = await insertEntry(tx, {
    tenantId: args.tenantId,
    accountId: account.id,
    kind: "VISIT",
    visits: 1,
    sourceType: "rdv",
    sourceId: args.appointmentId,
    ref,
    occurredAt: args.occurredAt,
    actorId: args.actorId ?? null,
    actorName: args.actorName ?? null,
  });
  if (inserted.duplicate) return { credited: false, rewardsCreated: 0 };

  let rewardsCreated = 0;
  if (args.program.mode === "VISITS" && args.program.visitsPerReward) {
    rewardsCreated = await issueRewardsWhileNetReached(tx, {
      tenantId: args.tenantId,
      accountId: account.id,
      field: "visits",
      perReward: args.program.visitsPerReward,
      triggerRef: ref,
      activatedAt: args.program.activatedAt,
      snapshot: {
        rewardKind: args.program.rewardKind,
        rewardPercent: args.program.rewardPercent,
        rewardAmountXpf: args.program.rewardAmountXpf,
        rewardBase: args.program.rewardBase,
        rewardValidityMonths: args.program.rewardValidityMonths,
      },
      sourceType: "rdv",
      sourceId: args.appointmentId,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      actorName: args.actorName,
    });
  }
  return { credited: true, rewardsCreated };
}

// ── creditPoints ─────────────────────────────────────────────────────────────────────────────

export type CreditPointsArgs = {
  tenantId: string;
  program: LoyaltyProgramRow;
  clientFicheId: string;
  displayName: string;
  saleId: string;
  points: number;
  occurredAt: Date;
  actorId?: string | null;
  actorName?: string | null;
};

/**
 * Crédite les points d'une vente. N'écrit rien hors mode `POINTS`, ni si `points <= 0`, ni si la
 * vente est antérieure à `activatedAt` (même garde que `creditVisit` — un règlement différé d'une
 * caisse hors ligne, `paidAt`, peut dater d'avant l'activation du programme).
 */
export async function creditPoints(tx: LoyaltyTx, args: CreditPointsArgs): Promise<CreditResult> {
  if (args.program.mode !== "POINTS") return { credited: false, rewardsCreated: 0 };
  if (args.points <= 0) return { credited: false, rewardsCreated: 0 };
  if (args.program.activatedAt && args.occurredAt.getTime() < args.program.activatedAt.getTime()) {
    return { credited: false, rewardsCreated: 0 };
  }

  const account = await lockAccount(tx, args.tenantId, args.clientFicheId, args.displayName);
  const ref = `points:sale:${args.saleId}`;
  const inserted = await insertEntry(tx, {
    tenantId: args.tenantId,
    accountId: account.id,
    kind: "POINTS",
    points: args.points,
    sourceType: "sale",
    sourceId: args.saleId,
    saleId: args.saleId,
    ref,
    occurredAt: args.occurredAt,
    actorId: args.actorId ?? null,
    actorName: args.actorName ?? null,
  });
  if (inserted.duplicate) return { credited: false, rewardsCreated: 0 };

  let rewardsCreated = 0;
  if (args.program.pointsPerReward) {
    rewardsCreated = await issueRewardsWhileNetReached(tx, {
      tenantId: args.tenantId,
      accountId: account.id,
      field: "points",
      perReward: args.program.pointsPerReward,
      triggerRef: ref,
      activatedAt: args.program.activatedAt,
      snapshot: {
        rewardKind: args.program.rewardKind,
        rewardPercent: args.program.rewardPercent,
        rewardAmountXpf: args.program.rewardAmountXpf,
        rewardBase: args.program.rewardBase,
        rewardValidityMonths: args.program.rewardValidityMonths,
      },
      sourceType: "sale",
      sourceId: args.saleId,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      actorName: args.actorName,
    });
  }
  return { credited: true, rewardsCreated };
}

// ── redeemReward ─────────────────────────────────────────────────────────────────────────────

export type RedeemRewardArgs = {
  tenantId: string;
  rewardEntryId: string;
  saleId: string;
  discountXpf: bigint;
  occurredAt: Date;
  actorId?: string | null;
  actorName?: string | null;
};

export type RedeemRewardResult = { ok: true } | { ok: false; reason: "RACE" };

/**
 * Consomme une récompense DANS la transaction du passage à PAID de `checkoutSale`. L'UPDATE est
 * CONDITIONNEL (`redeemedAt: null` dans le `where`, jamais un `findFirst` puis un `update`) —
 * même garde de course que `redeemGiftCard` (lib/caisse.ts) : si `count !== 1`, un autre comptoir
 * a consommé la même récompense entre le contrôle préalable et cet instant, et l'appelant DOIT
 * annuler toute la transaction (throw), pas seulement refuser la ligne fidélité.
 *
 * ⚠️ SABOTAGE DU PLAN (§6) : retirer `redeemedAt: null` du `where` ci-dessous fait ROUGIR le test
 * de double consommation de lib/loyalty-checkout.test.ts. Le rétablir le fait revert au vert.
 */
export async function redeemReward(tx: LoyaltyTx, args: RedeemRewardArgs): Promise<RedeemRewardResult> {
  const done = await tx.loyaltyEntry.updateMany({
    where: { id: args.rewardEntryId, tenantId: args.tenantId, kind: "REWARD", redeemedAt: null },
    data: { redeemedAt: args.occurredAt, redeemedSaleId: args.saleId },
  });
  if (done.count !== 1) return { ok: false, reason: "RACE" };

  // La récompense vient d'être trouvée et verrouillée par l'`updateMany` ci-dessus (WHERE sur son
  // id) : ce `findFirst` ne PARTICIPE PAS à l'arbitrage de la course, il sert seulement à
  // retrouver `accountId` pour la ligne REDEEM qui suit.
  const reward = await tx.loyaltyEntry.findFirst({
    where: { id: args.rewardEntryId, tenantId: args.tenantId },
    select: { accountId: true },
  });
  const accountId = reward ? reward.accountId : null;
  if (!accountId) return { ok: false, reason: "RACE" };

  await insertEntry(tx, {
    tenantId: args.tenantId,
    accountId,
    kind: "REDEEM",
    rewardEntryId: args.rewardEntryId,
    discountXpf: args.discountXpf,
    sourceType: "sale",
    sourceId: args.saleId,
    saleId: args.saleId,
    ref: `redeem:sale:${args.saleId}`,
    occurredAt: args.occurredAt,
    actorId: args.actorId ?? null,
    actorName: args.actorName ?? null,
  });
  return { ok: true };
}

// ── reverseSale (annulation) ─────────────────────────────────────────────────────────────────

/**
 * Reprise fidélité d'une vente PAID annulée (`annulerVente`), DANS LA MÊME transaction que le
 * passage à VOID (cf. lib/caisse.ts) : reprend les points (`unpoints:sale:<id>`) et remet
 * disponible la récompense consommée (`redeemedAt: null` + `unredeem:sale:<id>`). La visite,
 * elle, N'EST JAMAIS reprise ici : le RDV a bien été honoré, l'annulation de la VENTE ne le
 * défait pas (§2.5 du plan).
 *
 * 🔴 CORRECTIF (2026-09-16, contre-QA sur 9a98e32) : les deux `REVERSAL` prenaient
 * `occurredAt = new Date()` (l'instant de l'annulation, pas celui du crédit annulé). Défaut
 * prouvé : `sumVisits`/`sumPoints` (décision Marco 15/09, remise à zéro au changement de forme
 * ou réactivation) filtrent le net sur `occurredAt >= activatedAt` du programme COURANT. Un
 * ticket du cycle 1 (+300 pts, `occurredAt` cycle 1) annulé APRÈS une réactivation voit ses
 * +300 déjà exclus du net du cycle 2 (leur `occurredAt` est antérieur au nouveau `activatedAt`)
 * — mais sa reprise (-300), datée d'AUJOURD'HUI, entrait dans le cycle 2 et faisait passer son
 * net de 100 à -200 : une reprise plus jeune que son crédit d'origine change de cycle tout
 * seule. ARBITRAGE : une reprise appartient au cycle du crédit qu'elle annule — elle prend
 * l'`occurredAt` de la ligne qu'elle défait (`points:sale:<id>` pour `unpoints`,
 * `redeem:sale:<id>` pour `unredeem`), jamais `new Date()`. `createdAt` (horodatage réel de
 * l'écriture, `@default(now())`, jamais posé explicitement ici) garde la trace de QUAND la
 * reprise a eu lieu — seul `occurredAt` détermine dans quel cycle elle compte.
 *
 * Best-effort en cas de doublon : `insertEntry` avale un `P2002` (rejouer `annulerVente` sur une
 * vente déjà VOID ne repasse de toute façon jamais ici, `runVoidSale` le court-circuite avant).
 */
export async function reverseSale(
  tx: LoyaltyTx,
  args: { tenantId: string; saleId: string },
): Promise<void> {
  const pointsEntry = await tx.loyaltyEntry.findFirst({
    where: { tenantId: args.tenantId, kind: "POINTS", ref: `points:sale:${args.saleId}` },
    select: { accountId: true, points: true, occurredAt: true },
  });
  if (pointsEntry && pointsEntry.points) {
    await insertEntry(tx, {
      tenantId: args.tenantId,
      accountId: pointsEntry.accountId,
      kind: "REVERSAL",
      points: -pointsEntry.points,
      sourceType: "sale",
      sourceId: args.saleId,
      saleId: args.saleId,
      ref: `unpoints:sale:${args.saleId}`,
      // Cycle du crédit annulé, PAS l'instant de l'annulation — cf. le correctif ci-dessus.
      occurredAt: pointsEntry.occurredAt,
    });
  }

  const redeemEntry = await tx.loyaltyEntry.findFirst({
    where: { tenantId: args.tenantId, kind: "REDEEM", ref: `redeem:sale:${args.saleId}` },
    select: { accountId: true, rewardEntryId: true, occurredAt: true },
  });
  if (redeemEntry && redeemEntry.rewardEntryId) {
    await tx.loyaltyEntry.updateMany({
      where: { id: redeemEntry.rewardEntryId, tenantId: args.tenantId },
      data: { redeemedAt: null, redeemedSaleId: null },
    });
    await insertEntry(tx, {
      tenantId: args.tenantId,
      accountId: redeemEntry.accountId,
      kind: "REVERSAL",
      rewardEntryId: redeemEntry.rewardEntryId,
      sourceType: "sale",
      sourceId: args.saleId,
      saleId: args.saleId,
      ref: `unredeem:sale:${args.saleId}`,
      // Cycle de la consommation annulée, PAS l'instant de l'annulation. Ne porte ni visites ni
      // points (une REDEEM n'en portait déjà pas) : seule la cohérence du cycle importe ici.
      occurredAt: redeemEntry.occurredAt,
    });
  }
}

// ── adjustLoyalty (correction manuelle, écran ADMIN) ────────────────────────────────────────

export type AdjustLoyaltyArgs = {
  tenantId: string;
  program: LoyaltyProgramRow;
  clientFicheId: string;
  displayName: string;
  visits: number;
  points: number;
  reason: string;
  ref: string;
  occurredAt: Date;
  actorId?: string | null;
  actorName?: string | null;
};

export type AdjustLoyaltyResult =
  | { ok: true; rewardsCreated: number }
  | { ok: false; error: "REASON_TOO_SHORT" | "NO_CHANGE" | "REF_INVALID" };

/**
 * Correction manuelle ADMIN. `args.occurredAt` : l'appelant (`adjustLoyaltyAccount`,
 * lib/caisse.ts) pose TOUJOURS `new Date()` — un ADJUST prend `occurredAt = now`, jamais une
 * date passée reconstituée. `activatedAt` est nécessairement déjà dans le passé à cet instant
 * (`nextActivatedAt` ne pose jamais autre chose que `now` d'UNE requête PUT antérieure) : la garde
 * `occurredAt < activatedAt` de `creditVisit`/`creditPoints` n'a donc structurellement rien à
 * faire ici — mais l'AGRÉGATION (`sumVisits`/`sumPoints`, filtrée sur `occurredAt >= activatedAt`)
 * s'applique bien à CE `kind` comme aux autres : un ADJUST antérieur à une réactivation ne compte
 * plus dans le nouveau net, exactement comme un VISIT ou un POINTS (§2.2, décision Marco 15/09).
 */
export async function adjustLoyalty(tx: LoyaltyTx, args: AdjustLoyaltyArgs): Promise<AdjustLoyaltyResult> {
  if (!args.reason || args.reason.trim().length < 3) return { ok: false, error: "REASON_TOO_SHORT" };
  if (args.visits === 0 && args.points === 0) return { ok: false, error: "NO_CHANGE" };
  if (!args.ref.startsWith("adjust:")) return { ok: false, error: "REF_INVALID" };

  const account = await lockAccount(tx, args.tenantId, args.clientFicheId, args.displayName);
  const inserted = await insertEntry(tx, {
    tenantId: args.tenantId,
    accountId: account.id,
    kind: "ADJUST",
    visits: args.visits,
    points: args.points,
    reason: args.reason,
    sourceType: "manual",
    sourceId: args.ref,
    ref: args.ref,
    occurredAt: args.occurredAt,
    actorId: args.actorId ?? null,
    actorName: args.actorName ?? null,
  });
  if (inserted.duplicate) return { ok: true, rewardsCreated: 0 };

  let rewardsCreated = 0;
  if (args.program.mode === "VISITS" && args.program.visitsPerReward && args.visits !== 0) {
    rewardsCreated += await issueRewardsWhileNetReached(tx, {
      tenantId: args.tenantId,
      accountId: account.id,
      field: "visits",
      perReward: args.program.visitsPerReward,
      triggerRef: args.ref,
      activatedAt: args.program.activatedAt,
      snapshot: {
        rewardKind: args.program.rewardKind,
        rewardPercent: args.program.rewardPercent,
        rewardAmountXpf: args.program.rewardAmountXpf,
        rewardBase: args.program.rewardBase,
        rewardValidityMonths: args.program.rewardValidityMonths,
      },
      sourceType: "manual",
      sourceId: args.ref,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      actorName: args.actorName,
    });
  }
  if (args.program.mode === "POINTS" && args.program.pointsPerReward && args.points !== 0) {
    rewardsCreated += await issueRewardsWhileNetReached(tx, {
      tenantId: args.tenantId,
      accountId: account.id,
      field: "points",
      perReward: args.program.pointsPerReward,
      triggerRef: args.ref,
      activatedAt: args.program.activatedAt,
      snapshot: {
        rewardKind: args.program.rewardKind,
        rewardPercent: args.program.rewardPercent,
        rewardAmountXpf: args.program.rewardAmountXpf,
        rewardBase: args.program.rewardBase,
        rewardValidityMonths: args.program.rewardValidityMonths,
      },
      sourceType: "manual",
      sourceId: args.ref,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      actorName: args.actorName,
    });
  }
  return { ok: true, rewardsCreated };
}

// ── accountSummary (lecture) ─────────────────────────────────────────────────────────────────

export type LoyaltyRewardView = {
  id: string;
  rewardKind: string | null;
  rewardPercent: number | null;
  rewardAmountXpf: bigint | null;
  rewardBase: string | null;
  expiresAt: Date | null;
  redeemedAt: Date | null;
};

export type LoyaltyAccountSummary = {
  clientFicheId: string;
  displayName: string;
  visits: number;
  points: number;
  rewards: LoyaltyRewardView[];
  lastEntries: any[];
  /** Pivot de la remise à zéro (décision Marco 15/09) — pour affichage écran. `null` = programme
   *  jamais activé (ou OFF depuis toujours) : `visits`/`points` valent alors 0. */
  activatedAt: Date | null;
};

/**
 * Soldes et récompenses de N fiches, TOUS dérivés à la lecture (§2.2 du plan) — rien n'écrit.
 * `visits`/`points` n'agrègent que les lignes postérieures à `activatedAt` du programme COURANT
 * (décision Marco 15/09 : un changement de forme ou une réactivation repart de zéro) ; les
 * récompenses (`rewards`), elles, restent visibles et consommables quelle que soit leur date —
 * leur disponibilité ne dépend que de `redeemedAt`/`expiresAt` (`isRewardAvailable`).
 */
export async function accountSummary(
  tx: LoyaltyTx,
  tenantId: string,
  ficheIds: string[],
): Promise<LoyaltyAccountSummary[]> {
  const program = (await tx.loyaltyProgram.findFirst({ where: { tenantId } })) ?? offProgram(tenantId);
  const activatedAt = program.activatedAt;

  const accounts = await tx.loyaltyAccount.findMany({
    where: { tenantId, clientFicheId: { in: ficheIds } },
  });

  const results: LoyaltyAccountSummary[] = [];
  for (const acc of accounts) {
    const [visits, points, rewardRows, lastEntries] = await Promise.all([
      sumVisits(tx, tenantId, acc.id, activatedAt),
      sumPoints(tx, tenantId, acc.id, activatedAt),
      tx.loyaltyEntry.findMany({
        where: { tenantId, accountId: acc.id, kind: "REWARD" },
        orderBy: { occurredAt: "asc" },
      }),
      tx.loyaltyEntry.findMany({
        where: { tenantId, accountId: acc.id },
        orderBy: { occurredAt: "desc" },
        take: 50,
      }),
    ]);
    results.push({
      clientFicheId: acc.clientFicheId,
      displayName: acc.displayName,
      visits,
      points,
      rewards: rewardRows.map((r: any) => ({
        id: r.id,
        rewardKind: r.rewardKind,
        rewardPercent: r.rewardPercent,
        rewardAmountXpf: r.rewardAmountXpf,
        rewardBase: r.rewardBase,
        expiresAt: r.expiresAt,
        redeemedAt: r.redeemedAt,
      })),
      lastEntries,
      activatedAt,
    });
  }
  return results;
}
