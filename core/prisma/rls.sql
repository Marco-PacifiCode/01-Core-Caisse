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
-- NB : le propriétaire de la table CONTOURNE la RLS sauf FORCE ROW LEVEL SECURITY. On garde ENABLE
-- (PAS FORCE) : en prod l'app se connecte avec un rôle DÉDIÉ non-propriétaire (la RLS s'applique) ;
-- les migrations/seed tournent avec le rôle propriétaire qui DOIT bypasser la RLS.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'CashSession','Sale','SaleLine','SalePayment'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
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
