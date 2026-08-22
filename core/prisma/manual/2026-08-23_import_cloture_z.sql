-- 2026-08-23_import_cloture_z.sql — core_caisse — import d'une clôture Z déjà faite hors ligne
--
-- À PASSER PAR MARCO (le rôle runtime n'a pas le DDL) :
--     psql "$CORE_CAISSE_OWNER_URL" -v ON_ERROR_STOP=1 -f 2026-08-23_import_cloture_z.sql
--
-- ⚠️ CE MOTEUR EST EN PRODUCTION et sert trois marchands : Ellément, V-Cut,
-- Onéiti. Tout ici est ADDITIF et RÉTROCOMPATIBLE : trois colonnes NULLABLES et
-- un index unique PARTIEL. Aucune ligne existante n'est touchée, aucune colonne
-- supprimée ni renommée, aucune valeur par défaut rétroactive. Un appelant qui
-- ignore ces champs se comporte exactement comme avant.
--
-- POURQUOI (Rôtisserie de Pouembout) : sa tablette encaisse hors ligne et
-- remonte ses VENTES une fois par jour (sessionId = null) ; ses clôtures Z sont
-- archivées EN LOCAL et n'atteignent jamais ce moteur. On les IMPORTE telles
-- quelles — la tablette est la source de vérité de son Z, on ne le recalcule
-- pas côté serveur. `sourceType`/`sourceId` portent l'idempotence de cet import
-- (une même journée réémise ne crée pas de doublon), séparément de
-- `posteId` qui identifie déjà le comptoir physique (2026-08-15).
--
-- `SaleLine.tgcRatePpm` n'a AUCUN rapport avec l'import de Z : c'est le taux de
-- TGC par ligne qui traverse désormais Caisse → Compta (lot B du même chantier),
-- ajouté ici pour ne faire qu'une seule migration additive ce jour-là.
--
-- ROLLBACK :
--   DROP INDEX IF EXISTS "uniq_session_external_source";
--   ALTER TABLE "CashSession" DROP COLUMN IF EXISTS "sourceType";
--   ALTER TABLE "CashSession" DROP COLUMN IF EXISTS "sourceId";
--   ALTER TABLE "SaleLine"    DROP COLUMN IF EXISTS "tgcRatePpm";

BEGIN;

-- 1. Origine externe d'une session importée. `text` et non une FK : l'identifiant
--    est tiré par la tablette elle-même, hors ligne. NULL = session ouverte/
--    fermée par le chemin vivant (openSession/closeSession), c'est-à-dire le
--    comportement de tous les marchands actuels — inchangé.
ALTER TABLE "CashSession" ADD COLUMN IF NOT EXISTS "sourceType" text;
ALTER TABLE "CashSession" ADD COLUMN IF NOT EXISTS "sourceId"   text;

-- 2. Idempotence de l'import : un (tenantId, sourceType, sourceId) ne crée
--    qu'UNE session. COALESCE n'est pas nécessaire ici (contrairement à
--    uniq_session_open_par_poste) : la clause WHERE exclut déjà les deux NULL,
--    donc les sessions du chemin vivant (sourceType/sourceId absents) ne sont
--    jamais comparées entre elles par cet index.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_session_external_source"
  ON "CashSession" ("tenantId", "sourceType", "sourceId")
  WHERE "sourceType" IS NOT NULL AND "sourceId" IS NOT NULL;

-- 3. Taux de TGC PAR LIGNE (lot B) — traverse désormais Caisse → Compta.
--    Optionnel partout : absent = comportement strictement inchangé (pas de
--    valeur 0, qui signifierait « hors champ TGC » côté Compta).
ALTER TABLE "SaleLine" ADD COLUMN IF NOT EXISTS "tgcRatePpm" INTEGER;

COMMIT;

-- Contrôle :
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'CashSession' AND column_name IN ('sourceType','sourceId');
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'SaleLine' AND column_name = 'tgcRatePpm';
--   SELECT indexname FROM pg_indexes WHERE indexname = 'uniq_session_external_source';
--
-- ⚠️ Si la création de l'index unique ÉCHOUE, c'est qu'un import a déjà été
-- rejoué en dehors de la garde applicative (importerCloture) et a produit deux
-- sessions pour la même (sourceType, sourceId) — état que la garde aurait dû
-- empêcher. Dans ce cas : ne pas forcer, inspecter, fusionner/supprimer le
-- doublon avant de rejouer.
