-- Colonnes `posteId` de "CashSession" et "Sale" rattachées aux migrations (2026-10-19).
--
-- Jusqu'ici elles n'existaient que par prisma/manual/2026-08-15_postes_de_caisse.sql, joué à
-- la main en prod : une base construite par `prisma migrate deploy` seul (reprise, nouvel
-- environnement) n'avait pas ces colonnes, et tout `prisma.sale.*` / `prisma.cashSession.*`
-- y échouait. Cette migration reprend ce SQL manuel, qui devient redondant.
--
-- ADDITIVE ET IDEMPOTENTE : tout est en IF NOT EXISTS, avec les noms déjà en place en prod
-- (mesurés le 19/10 dans pg_indexes et information_schema). Sur la prod, seules deux
-- instructions font quelque chose — rien n'est supprimé, aucune ligne n'est lue ni écrite :
--   · "CashSession_tenantId_posteId_idx", déclaré au schéma (@@index([tenantId, posteId]))
--     mais jamais créé (le SQL manuel n'indexait que "Sale") ;
--   · l'inscription de la migration dans _prisma_migrations.
-- Les deux colonnes, "Sale_tenantId_posteId_idx" et "uniq_session_open_par_poste" existent
-- déjà en prod : Postgres les saute avec un simple NOTICE.
--
-- ROLLBACK : ne retirer que l'index neuf (les colonnes portent des données de prod).
--   DROP INDEX IF EXISTS "CashSession_tenantId_posteId_idx";

-- 1. Le poste qui a ouvert la session, et celui qui a émis la vente. `text` libre, NULL =
--    marchand mono-caisse (cf. le SQL manuel du 2026-08-15 pour le pourquoi).
ALTER TABLE "CashSession" ADD COLUMN IF NOT EXISTS "posteId" TEXT;
ALTER TABLE "Sale"        ADD COLUMN IF NOT EXISTS "posteId" TEXT;

-- 2. Index déclarés au schéma.
CREATE INDEX IF NOT EXISTS "CashSession_tenantId_posteId_idx" ON "CashSession"("tenantId", "posteId");
CREATE INDEX IF NOT EXISTS "Sale_tenantId_posteId_idx" ON "Sale"("tenantId", "posteId");

-- 3. Une seule session OPEN par poste et par marchand, tranchée par la base. Index sur
--    expression, hors schéma Prisma (comme "uniq_session_external_source").
--    COALESCE("posteId", '') : deux NULL seraient DISTINCTS dans un index unique, et un
--    marchand mono-caisse pourrait alors ouvrir autant de sessions qu'il veut.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_session_open_par_poste"
  ON "CashSession" ("tenantId", (COALESCE("posteId", '')))
  WHERE "status" = 'OPEN';
