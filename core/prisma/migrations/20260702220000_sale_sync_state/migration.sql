-- Chantier fiabilité 2026-07 : état de synchro post-encaissement sur Sale (cf. lib/sync.ts).
-- ADDITIF / RÉVERSIBLE (rollback : ALTER TABLE "Sale" DROP COLUMN de chacune des 4 colonnes).

ALTER TABLE "Sale" ADD COLUMN "comptaSyncedAt" TIMESTAMP(3);
ALTER TABLE "Sale" ADD COLUMN "stockSyncedAt" TIMESTAMP(3);
ALTER TABLE "Sale" ADD COLUMN "syncError" TEXT;
ALTER TABLE "Sale" ADD COLUMN "syncAttempts" INTEGER NOT NULL DEFAULT 0;

-- Backfill : sous l'ANCIEN flux, une vente ne passait PAID qu'après facture+settle+stock réussis.
-- Les ventes PAID antérieures à cette migration sont donc déjà convergées → on les marque telles
-- quelles pour que le balayage repair-sales ne les rejoue pas inutilement (le rejeu resterait
-- toutefois sans danger : toutes les cibles dédupliquent).
UPDATE "Sale"
SET "comptaSyncedAt" = COALESCE("paidAt", "updatedAt"),
    "stockSyncedAt"  = COALESCE("paidAt", "updatedAt")
WHERE "status" = 'PAID';
