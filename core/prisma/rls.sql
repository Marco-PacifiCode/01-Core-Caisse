-- RLS PostgreSQL — isolation multi-tenant (defense-in-depth). Calque de Core-Compta / Core-Stock.
-- À appliquer APRÈS `prisma migrate` (voir script db:setup).
--
-- Principe : chaque requête applicative ouvre une transaction qui pose
--   SET LOCAL app.current_tenant = '<uuid>'   (cf. lib/tenant.ts -> withTenant)
-- et les policies ci-dessous ne laissent voir/modifier que ces lignes.
--
-- ⚠️ Cast ROBUSTE au GUC vide : `current_setting('app.current_tenant', true)` vaut la chaîne VIDE ''
-- (pas NULL) sur une connexion poolée déjà utilisée par un SET LOCAL antérieur. '' ::uuid lève 22P02.
-- On enveloppe donc en NULLIF(…, '')::uuid : un GUC absent OU vide devient NULL → la comparaison
-- `tenantId = NULL` est NULL (aucune ligne) au lieu de planter. Neutre quand le GUC porte un vrai uuid.
--
-- ⚠️ FORCE ROW LEVEL SECURITY (alignement chantier sécurité audit 2026-07-02) : sans FORCE, le
-- propriétaire des tables CONTOURNE silencieusement la RLS. FORCE soumet AUSSI l'owner aux
-- policies → si le runtime se connecte par erreur en owner, l'isolation tient.
-- Conséquences opérationnelles :
--   - le RUNTIME doit se connecter avec un rôle applicatif NON-propriétaire (cf. .env.example) ;
--   - les seeds/scripts cross-tenant (prisma db seed, seed:tenant) doivent tourner avec un rôle
--     BYPASSRLS (ex. postgres) — le rôle owner « nu » ne bypasse plus ;
--   - ⚠️ le BALAYAGE CRON (lib/repair-sweep.ts, CRON_DATABASE_URL) lit Sale CROSS-TENANT :
--     son rôle doit être BYPASSRLS AVANT d'appliquer FORCE, sinon il voit 0 ligne en silence
--     (même piège que le cron de rappels de Core-RDV).

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

-- Idempotence des VENTES SOURCÉES (index unique PARTIEL) : une vente issue d'un même
-- (tenantId, sourceType, sourceId) ne peut être créée qu'UNE fois (ex : un même RDV honoré ne génère
-- qu'un ticket). Partiel car sourceType/sourceId sont nullables et seuls les tickets « sourcés » doivent
-- être dédupliqués (une vente au comptoir spontanée n'a pas de source). Même pattern que Core-Compta
-- (idempotence facture) et Core-Stock (uniq_sale_source). Prisma ne modélise pas les uniques partiels.
DROP INDEX IF EXISTS "uniq_sale_external_source";
CREATE UNIQUE INDEX "uniq_sale_external_source"
  ON "Sale" ("tenantId", "sourceType", "sourceId")
  WHERE "sourceType" IS NOT NULL AND "sourceId" IS NOT NULL;

-- Balayage de REPRISE (chantier fiabilité 2026-07) : index PARTIEL des ventes PAID dont la synchro
-- Compta/Stock est incomplète (cf. lib/sync.ts + /api/cron/repair-sales). Partiel car en régime normal
-- ~0 ligne le porte → coût nul en écriture, balayage O(pending) en lecture. Non modélisable en Prisma.
DROP INDEX IF EXISTS "idx_sale_sync_pending";
CREATE INDEX "idx_sale_sync_pending"
  ON "Sale" ("paidAt")
  WHERE "status" = 'PAID' AND ("comptaSyncedAt" IS NULL OR "stockSyncedAt" IS NULL);
