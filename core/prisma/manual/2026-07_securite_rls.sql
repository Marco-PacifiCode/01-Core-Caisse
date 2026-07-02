-- ============================================================================
-- 2026-07_securite_rls.sql — core_caisse — alignement chantier sécurité audit 2026-07-02
-- ============================================================================
-- À JOUER EN PROD PAR LE RÔLE OWNER (ou postgres), AVANT de déployer le code.
-- REJOUABLE (idempotent). ADDITIF (aucune donnée modifiée/supprimée).
-- ROLLBACK : ALTER TABLE "CashSession" NO FORCE ROW LEVEL SECURITY;
--            ALTER TABLE "Sale"        NO FORCE ROW LEVEL SECURITY;
--            ALTER TABLE "SaleLine"    NO FORCE ROW LEVEL SECURITY;
--            ALTER TABLE "SalePayment" NO FORCE ROW LEVEL SECURITY;
--            (les policies NULLIF restent compatibles avec l'ancien code)
--
-- Contenu :
--   1. FORCE ROW LEVEL SECURITY sur les tables tenant (l'owner ne bypasse plus).
--   2. Policies tenant_isolation recréées à l'identique (NULLIF(...)::uuid,
--      robustesse GUC vide en pool) — inchangées fonctionnellement.
-- NB : les index partiels uniq_sale_external_source et idx_sale_sync_pending
-- existent déjà via prisma/rls.sql — pas touchés ici.
--
-- ⚠️⚠️ PIÈGE SPÉCIFIQUE CAISSE — CRON DE REPRISE (à traiter AVANT le FORCE) :
--   le balayage lib/repair-sweep.ts (POST /api/cron/repair-sales) liste les ventes
--   PAID non synchronisées de TOUS les tenants via un client Prisma dédié sur
--   `CRON_DATABASE_URL`. Aujourd'hui ce rôle bypasse la RLS parce qu'il est owner
--   de tables NON-FORCE. Après FORCE, un owner « nu » est soumis aux policies →
--   le balayage verrait 0 ligne EN SILENCE (aucune erreur, la reprise meurt).
--   Même piège que le cron de rappels de Core-RDV (lib/reminders.ts).
--   → AVANT de jouer ce script : donner BYPASSRLS au rôle de CRON_DATABASE_URL
--     (ALTER ROLE <role_cron> BYPASSRLS;) ou pointer CRON_DATABASE_URL sur un rôle
--     qui l'a déjà. Vérif : SELECT rolname, rolbypassrls FROM pg_roles
--     WHERE rolname = '<role_cron>';  → rolbypassrls = t.
--   → APRÈS déploiement : POST /api/cron/repair-sales (X-Cron-Key) doit rapporter
--     scanned > 0 s'il existe des ventes en attente (pas un 0 suspect).
--
-- ⚠️ AVANT de jouer (en plus du piège cron ci-dessus) :
--   - Vérifier que le RUNTIME ne se connecte PAS avec le rôle owner des tables
--     (sinon, après FORCE, ses requêtes hors withTenant retourneront 0 ligne).
--     Vérif : SELECT tableowner FROM pg_tables WHERE tablename = 'Sale';
--             et comparer au rôle de l'app (DATABASE_URL du process PM2).
-- ⚠️ APRÈS avoir joué :
--   - Les seeds (prisma db seed / seed:tenant) doivent tourner avec un rôle
--     BYPASSRLS (ex. postgres) — l'owner « nu » est désormais soumis à la RLS.
--   - Healthcheck : GET /api/health doit répondre {ok:true, db:true,
--     rlsEnabled:true, rlsForced:true} (rlsForced compte dans le ok depuis ce chantier).
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'CashSession','Sale','SaleLine','SalePayment'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid);',
      t
    );
  END LOOP;
END $$;

COMMIT;

-- Post-vérification (lecture seule, à exécuter après COMMIT) :
--   SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class WHERE relname IN ('CashSession','Sale','SaleLine','SalePayment');
--   → attendu : relrowsecurity = t ET relforcerowsecurity = t sur les 4 lignes.
--   SELECT rolname, rolbypassrls FROM pg_roles WHERE rolbypassrls;
--   → le rôle de CRON_DATABASE_URL doit y figurer.
