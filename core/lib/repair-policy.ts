// lib/repair-policy.ts — POLITIQUE DE SÉLECTION du balayage de reprise (pure, sans I/O).
//
// POURQUOI CE FICHIER EXISTE (2026-08-03, tâche t-20260803T2030-caissesweep) :
// La règle « quelles ventes reprendre, et dans quel ordre » est la partie du balayage qui peut être
// FAUSSE sans que rien ne plante. Elle est donc isolée ici, PURE, pour être éprouvée par `npm test`
// sans base ni réseau — même patron que lib/sync.ts (import TYPE uniquement, aucun import runtime :
// chargeable par `node --test --experimental-strip-types` sans bundler).
//
// ─── LE DÉFAUT QU'ELLE CORRIGE : LA FAMINE ───────────────────────────────────────────────────────
// AVANT : sélection `PAID AND (comptaSyncedAt IS NULL OR stockSyncedAt IS NULL)`, tri `paidAt asc`,
// fenêtre 200. Le compteur `syncAttempts` existait depuis 2026-07 mais n'était JAMAIS LU — écrit par
// recordFailure, lu par personne. Conséquence : une vente INSOLUBLE (produit supprimé côté Stock →
// 404 PRODUCT_NOT_FOUND définitif) ne quittait jamais la sélection, et comme elle est ancienne,
// `paidAt asc` la ramenait EN TÊTE DE FILE à chaque passage.
//
// PROUVÉ (base PostgreSQL jetable, migrations du repo, rôle app non-propriétaire, FORCE RLS, rôle cron
// BYPASSRLS, vrai checkoutSale/sweepPendingSales, vrais serveurs HTTP Compta/Stock) :
//   200 ventes insolubles anciennes + 5 ventes saines récentes, 5 passages de balayage
//   → AVANT : scanned=200 repaired=0 à CHAQUE passage, les 5 saines JAMAIS atteintes, 1000 appels
//     Stock pour rien, syncAttempts 1→6 sans plafond.
//   → APRÈS : passage 1 repaired=5 (les 5 saines convergent), puis les insolubles passent en reprise
//     espacée (appels Stock 200 → 0) et sont COMPTÉES (`stuck`) au lieu de pourrir en silence.
//
// ─── CE QUI EST DÉCIDÉ ICI, ET CE QUI NE L'EST PAS ───────────────────────────────────────────────
// Décidé : l'ORDRE de reprise et la CADENCE. Aucune vente n'est jamais abandonnée, aucun statut
// d'abandon n'est posé, aucune colonne n'est ajoutée (zéro migration : `syncAttempts` et `updatedAt`
// existent déjà). Le correctif est donc intégralement RÉVERSIBLE par revert de code.
// PAS décidé : le sort COMPTABLE d'une vente encaissée dont le stock ne bougera jamais (écart
// d'inventaire permanent). C'est un arbitrage de Marco, pas une conséquence d'un tri.

import type { Prisma } from "@prisma/client";

/** Nb de tentatives à partir duquel une vente passe en reprise ESPACÉE. Env, défaut 10. */
export function backoffAfterAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.REPAIR_BACKOFF_AFTER_ATTEMPTS);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/**
 * Espacement des reprises au-delà du seuil, en MINUTES. Env, défaut 360 (6 h).
 * ⚠️ **0 = interrupteur d'arrêt** : le backoff est neutralisé (toute vente redevient éligible à chaque
 * passage) et il ne reste que le tri anti-famine. Réglable en prod sans redéploiement de code.
 */
export function backoffMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.REPAIR_BACKOFF_MINUTES);
  return Number.isFinite(n) && n >= 0 ? n : 360;
}

/** Ventes « à réparer » au sens strict, backoff EXCLU (sert au comptage d'enlisement). */
export function pendingSalesBaseWhere(): Prisma.SaleWhereInput {
  return { status: "PAID", OR: [{ comptaSyncedAt: null }, { stockSyncedAt: null }] };
}

/**
 * Sélection d'un passage : « à réparer » ET (peu retentée OU dernière tentative assez ancienne).
 * `updatedAt` est poussé par recordFailure (syncError + syncAttempts++) → il date la dernière
 * tentative. Le `AND` imbriqué est indispensable : mis à plat, le second OR fusionnerait avec le
 * premier et la condition de backoff deviendrait inopérante.
 */
export function pendingSalesWhere(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Prisma.SaleWhereInput {
  const cutoff = new Date(now.getTime() - backoffMinutes(env) * 60_000);
  return {
    ...pendingSalesBaseWhere(),
    AND: [{ OR: [{ syncAttempts: { lt: backoffAfterAttempts(env) } }, { updatedAt: { lte: cutoff } }] }],
  };
}

/** Ventes enlisées : « à réparer » ET déjà au-delà du seuil de tentatives. */
export function stuckSalesWhere(env: NodeJS.ProcessEnv = process.env): Prisma.SaleWhereInput {
  return {
    ...pendingSalesBaseWhere(),
    AND: [{ syncAttempts: { gte: backoffAfterAttempts(env) } }],
  };
}

/**
 * ORDRE DE REPRISE — c'est CE tri qui interdit la famine.
 * Les MOINS retentées d'abord, puis les plus anciennes. Une vente insoluble accumule des tentatives
 * et recule donc mécaniquement derrière toute vente plus fraîche : elle ne peut plus confisquer la
 * fenêtre. (`paidAt asc` seul faisait l'inverse — les insolubles, forcément anciennes, en tête.)
 * L'index partiel `idx_sale_sync_pending` reste utilisé pour le FILTRE (vérifié EXPLAIN ANALYZE à
 * 50 000 ventes : Index Scan + quicksort sur les seules lignes en attente, 0,19 ms → 0,34 ms).
 */
export const PENDING_SALES_ORDER: Prisma.SaleOrderByWithRelationInput[] = [
  { syncAttempts: "asc" },
  { paidAt: "asc" },
];
