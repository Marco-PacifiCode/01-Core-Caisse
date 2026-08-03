// repair-policy.test.ts — NON-RÉGRESSION DE LA FAMINE du balayage de reprise.
//
// Ce que ces tests verrouillent (tâche t-20260803T2030-caissesweep) : une vente PAID qui ne peut PAS
// converger (produit supprimé côté Stock → 404 PRODUCT_NOT_FOUND définitif) ne doit plus pouvoir
// confisquer la fenêtre de 200 du balayage au détriment de ventes saines.
//
// ⚠️ CES TESTS SAVENT ÉCHOUER : le test « ordre » ci-dessous est FAUX pour le tri d'avant
// (`orderBy: { paidAt: 'asc' }` seul) — il exige que `syncAttempts` soit la clé de tri PRIMAIRE.
// Le simulateur `windowOf` rejoue la sémantique du tri/filtre sur des ventes en mémoire : c'est lui
// qui met la famine en évidence, pas une assertion sur la forme de l'objet Prisma.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_SALES_ORDER,
  backoffAfterAttempts,
  backoffMinutes,
  pendingSalesWhere,
  stuckSalesWhere,
} from "./repair-policy.ts";

type FakeSale = { id: string; paidAt: number; syncAttempts: number; updatedAt: number };

/** Rejoue le tri déclaré dans PENDING_SALES_ORDER sur des ventes en mémoire. */
function sortByPolicy(sales: FakeSale[]): FakeSale[] {
  return [...sales].sort((a, b) => {
    for (const key of PENDING_SALES_ORDER) {
      if ("syncAttempts" in key && a.syncAttempts !== b.syncAttempts) return a.syncAttempts - b.syncAttempts;
      if ("paidAt" in key && a.paidAt !== b.paidAt) return a.paidAt - b.paidAt;
    }
    return 0;
  });
}

const windowOf = (sales: FakeSale[], limit: number) => sortByPolicy(sales).slice(0, limit);

test("FAMINE : 200 ventes insolubles anciennes ne confisquent pas la fenêtre aux ventes saines", () => {
  // Les insolubles sont les PLUS ANCIENNES (paidAt le plus petit) et ont déjà beaucoup échoué.
  const poisoned: FakeSale[] = Array.from({ length: 200 }, (_, i) => ({
    id: `poison-${i}`,
    paidAt: i, // très anciennes
    syncAttempts: 40, // elles ont échoué encore et encore
    updatedAt: 10_000,
  }));
  // Les saines sont RÉCENTES et n'ont pour ainsi dire jamais échoué.
  const healthy: FakeSale[] = Array.from({ length: 5 }, (_, i) => ({
    id: `sain-${i}`,
    paidAt: 10_000 + i, // récentes
    syncAttempts: 0,
    updatedAt: 10_000,
  }));

  const win = windowOf([...poisoned, ...healthy], 200);
  const sains = win.filter((s) => s.id.startsWith("sain")).length;

  // Avec le tri d'AVANT (paidAt asc seul), sains vaudrait 0 : la fenêtre était 100 % insoluble.
  assert.equal(sains, 5, "les 5 ventes saines doivent entrer dans la fenêtre malgré 200 insolubles plus anciennes");
  // Et elles doivent être servies EN PREMIER, pas juste présentes.
  assert.ok(
    win.slice(0, 5).every((s) => s.id.startsWith("sain")),
    "les ventes jamais retentées passent avant celles qui échouent en boucle",
  );
});

test("à nombre de tentatives ÉGAL, on garde l'équité chronologique (la plus ancienne d'abord)", () => {
  const sales: FakeSale[] = [
    { id: "recente", paidAt: 500, syncAttempts: 2, updatedAt: 0 },
    { id: "ancienne", paidAt: 100, syncAttempts: 2, updatedAt: 0 },
  ];
  assert.deepEqual(
    windowOf(sales, 10).map((s) => s.id),
    ["ancienne", "recente"],
  );
});

test("le tri a bien syncAttempts pour clé PRIMAIRE (c'est ce qui interdit la famine)", () => {
  assert.deepEqual(PENDING_SALES_ORDER[0], { syncAttempts: "asc" });
  assert.deepEqual(PENDING_SALES_ORDER[1], { paidAt: "asc" });
});

test("backoff : sous le seuil de tentatives, une vente est TOUJOURS éligible", () => {
  const env = { REPAIR_BACKOFF_AFTER_ATTEMPTS: "10", REPAIR_BACKOFF_MINUTES: "360" } as NodeJS.ProcessEnv;
  const w = pendingSalesWhere(new Date("2026-08-03T20:00:00Z"), env);
  const clause = (w.AND as { OR: Record<string, unknown>[] }[])[0].OR;
  assert.deepEqual(clause[0], { syncAttempts: { lt: 10 } });
  // La 2e branche laisse repasser les très retentées une fois le délai écoulé : personne n'est exclu à vie.
  assert.deepEqual(clause[1], { updatedAt: { lte: new Date("2026-08-03T14:00:00Z") } });
});

test("backoff : la sélection reste ANDée à « PAID et non convergée » (pas de fusion des deux OR)", () => {
  const w = pendingSalesWhere(new Date(), {} as NodeJS.ProcessEnv);
  assert.equal(w.status, "PAID");
  assert.deepEqual(w.OR, [{ comptaSyncedAt: null }, { stockSyncedAt: null }]);
  assert.ok(Array.isArray(w.AND) && w.AND.length === 1, "le backoff doit être un AND imbriqué, pas un OR à plat");
});

test("REPAIR_BACKOFF_MINUTES=0 est l'interrupteur d'arrêt : plus aucune vente n'est écartée", () => {
  const now = new Date("2026-08-03T20:00:00Z");
  const env = { REPAIR_BACKOFF_MINUTES: "0" } as NodeJS.ProcessEnv;
  const clause = (pendingSalesWhere(now, env).AND as { OR: Record<string, unknown>[] }[])[0].OR;
  // cutoff == now → `updatedAt <= now` est vrai pour toute vente déjà écrite : aucune exclusion.
  assert.deepEqual(clause[1], { updatedAt: { lte: now } });
});

test("réglages par défaut et garde-fous sur des env absurdes", () => {
  assert.equal(backoffAfterAttempts({} as NodeJS.ProcessEnv), 10);
  assert.equal(backoffMinutes({} as NodeJS.ProcessEnv), 360);
  assert.equal(backoffAfterAttempts({ REPAIR_BACKOFF_AFTER_ATTEMPTS: "0" } as NodeJS.ProcessEnv), 10);
  assert.equal(backoffAfterAttempts({ REPAIR_BACKOFF_AFTER_ATTEMPTS: "pouet" } as NodeJS.ProcessEnv), 10);
  assert.equal(backoffMinutes({ REPAIR_BACKOFF_MINUTES: "-5" } as NodeJS.ProcessEnv), 360);
});

test("comptage d'enlisement : indépendant du backoff, sinon l'insoluble redevient invisible", () => {
  const w = stuckSalesWhere({ REPAIR_BACKOFF_AFTER_ATTEMPTS: "10" } as NodeJS.ProcessEnv);
  assert.equal(w.status, "PAID");
  assert.deepEqual(w.OR, [{ comptaSyncedAt: null }, { stockSyncedAt: null }]);
  assert.deepEqual(w.AND, [{ syncAttempts: { gte: 10 } }]);
});
