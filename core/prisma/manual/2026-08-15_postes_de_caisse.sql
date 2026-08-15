-- 2026-08-15_postes_de_caisse.sql — core_caisse — plusieurs postes par marchand
--
-- À PASSER PAR MARCO (le rôle runtime n'a pas le DDL) :
--     psql "$CORE_CAISSE_OWNER_URL" -v ON_ERROR_STOP=1 -f 2026-08-15_postes_de_caisse.sql
--
-- ⚠️ CE MOTEUR EST EN PRODUCTION et sert trois marchands : Ellément, V-Cut,
-- Onéiti. Tout ici est ADDITIF et RÉTROCOMPATIBLE : deux colonnes NULLABLES et
-- un index. Aucune ligne existante n'est touchée, aucune colonne supprimée ni
-- renommée, aucune valeur par défaut rétroactive. Un appelant qui ignore ces
-- champs se comporte exactement comme avant.
--
-- POURQUOI (décision Marco, 2026-08-15) : la Rôtisserie de Pouembout a DEUX
-- caisses et pas d'internet sur place. Or ce moteur ne connaissait aucune
-- notion de poste, et n'admettait qu'UNE SEULE session ouverte par marchand :
-- deux comptoirs ne pouvaient pas tenir chacun la sienne.
--
-- ROLLBACK :
--   DROP INDEX IF EXISTS "uniq_session_open_par_poste";
--   ALTER TABLE "CashSession" DROP COLUMN IF EXISTS "posteId";
--   ALTER TABLE "Sale"        DROP COLUMN IF EXISTS "posteId";

BEGIN;

-- 1. Le poste qui a ouvert la session, et celui qui a émis la vente.
--    `text` et non une FK : le poste est un identifiant tiré par la tablette
--    elle-même, hors ligne, sans que le serveur ait jamais eu à le connaître.
--    NULL = marchand mono-caisse, c'est-à-dire les trois marchands actuels.
ALTER TABLE "CashSession" ADD COLUMN IF NOT EXISTS "posteId" text;
ALTER TABLE "Sale"        ADD COLUMN IF NOT EXISTS "posteId" text;

-- 2. La garde « une seule session ouverte » devient « une par poste », et
--    passe de l'applicatif à la BASE. Elle vivait dans un findFirst suivi d'un
--    create (lib/caisse.ts) : deux requêtes séparées, donc une fenêtre où deux
--    ouvertures simultanées pouvaient toutes deux passer. Ici, c'est Postgres
--    qui tranche.
--
--    COALESCE("posteId", '') : dans un index unique, deux NULL sont considérés
--    DISTINCTS — sans cette normalisation, un marchand mono-caisse pourrait
--    ouvrir autant de sessions qu'il veut, ce qui RELÂCHERAIT la règle actuelle
--    au lieu de la préserver.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_session_open_par_poste"
  ON "CashSession" ("tenantId", (COALESCE("posteId", '')))
  WHERE "status" = 'OPEN';

-- 3. Retrouver rapidement les ventes d'un poste (clôture Z par comptoir).
CREATE INDEX IF NOT EXISTS "Sale_tenantId_posteId_idx"
  ON "Sale" ("tenantId", "posteId");

COMMIT;

-- Contrôle :
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name IN ('Sale','CashSession') AND column_name = 'posteId';
--   SELECT indexname FROM pg_indexes WHERE indexname = 'uniq_session_open_par_poste';
--
-- ⚠️ Si la création de l'index unique ÉCHOUE, c'est qu'il existe déjà plusieurs
-- sessions OPEN pour un même marchand — état que la garde applicative aurait dû
-- empêcher. Dans ce cas : ne pas forcer, inspecter, et clôturer les sessions
-- orphelines avant de rejouer.
