-- Démo privée (maquette) : registre des tenants maquette et effacement borné.
--
-- Décision d'architecture 00-Architecture du 11/11 (option C + 6 gardes) :
--   1. Registre "TenantMaquette" ; inscription SEULEMENT par inscrire_tenant_maquette(uuid)
--      (SECURITY DEFINER), refusée si le tenant a déjà la moindre ligne dans les 4 tables l4,
--      "Sale" ou "PartialRefund". Le rôle applicatif n'a AUCUN droit d'écriture sur le registre.
--      Aucune voie de désinscription : seule effacer_tenant_maquette retire la ligne, après avoir effacé.
--   2. effacer_tenant_maquette(uuid) : SECURITY DEFINER, propriété du rôle qui joue la migration,
--      lock_timeout 3s / statement_timeout 30s posés AVANT tout ALTER : elle échoue plutôt que de
--      faire la queue devant les caisses.
--   3. Refus MAQUETTE_NON_INSCRITE (sauf tenant entièrement vide : compteurs à zéro) et
--      MAQUETTE_FAIT_ANTERIEUR (fait l4 reçu avant l'inscription).
--   4. Désactive les 4 déclencheurs cash_*_immutable SEULEMENT, le temps des DELETE bornés au tenant,
--      puis les réactive. Tout est transactionnel : une erreur annule tout, déclencheurs compris.
--   5. Additive : CREATE TABLE / FUNCTION, GRANT / REVOKE. caisse_l4_immutable() et ses 4
--      déclencheurs (migration 20261016094000) ne sont NI recréés NI modifiés.

CREATE TABLE IF NOT EXISTS "TenantMaquette" (
  "tenantId"  UUID        NOT NULL,
  "inscritLe" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "TenantMaquette_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE "TenantMaquette" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantMaquette" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'TenantMaquette' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "TenantMaquette"
      USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
  END IF;
END $$;

-- Le rôle applicatif ne fait que LIRE le registre (les DEFAULT PRIVILEGES du propriétaire lui
-- donneraient INSERT/UPDATE/DELETE : on les retire).
REVOKE ALL ON "TenantMaquette" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_caisse_app') THEN
    REVOKE ALL ON "TenantMaquette" FROM core_caisse_app;
    GRANT SELECT ON "TenantMaquette" TO core_caisse_app;
  END IF;
END $$;

-- ── Inscription ──────────────────────────────────────────────────────────────────────────────────
-- Vrai = inscrit maintenant ; faux = déjà inscrit. Refus si le tenant a déjà une vente, un
-- remboursement ou un fait l4 : une démo ne devient jamais un vrai commerce, et un vrai commerce
-- ne devient jamais une démo.
CREATE OR REPLACE FUNCTION inscrire_tenant_maquette(p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  t text;
  v_existe boolean;
  v_inscrit boolean;
  v_tenant_avant text := pg_catalog.current_setting('app.current_tenant', true);
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'MAQUETTE_INSCRIPTION_REFUSEE : tenant absent' USING ERRCODE = 'check_violation';
  END IF;
  -- RLS forcée, propriétaire compris : sans contexte, les contrôles verraient zéro ligne.
  PERFORM pg_catalog.set_config('app.current_tenant', p_tenant::text, true);

  IF EXISTS (SELECT 1 FROM "TenantMaquette" m WHERE m."tenantId" = p_tenant) THEN
    PERFORM pg_catalog.set_config('app.current_tenant', coalesce(v_tenant_avant, ''), true);
    RETURN false;
  END IF;

  FOREACH t IN ARRAY ARRAY['CashDayEvent', 'CashDayClosure', 'CashDayOpening', 'CashDaySession', 'Sale', 'PartialRefund'] LOOP
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %I WHERE "tenantId" = $1)', t) INTO v_existe USING p_tenant;
    IF v_existe THEN
      RAISE EXCEPTION 'MAQUETTE_INSCRIPTION_REFUSEE : le tenant a deja des lignes dans %', t
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  INSERT INTO "TenantMaquette" ("tenantId") VALUES (p_tenant) ON CONFLICT ("tenantId") DO NOTHING;
  GET DIAGNOSTICS v_existe = ROW_COUNT;
  v_inscrit := v_existe;
  PERFORM pg_catalog.set_config('app.current_tenant', coalesce(v_tenant_avant, ''), true);
  RETURN v_inscrit;
END;
$fn$;

-- ── Effacement ───────────────────────────────────────────────────────────────────────────────────
-- Chaque DELETE est borné par "tenantId" = p_tenant ; enfants avant parents (clés étrangères).
-- Le cycle Sale <-> PickupOrder est rompu par un UPDATE borné au tenant (saleId à NULL) avant le
-- DELETE des ventes.
-- Antériorité : seules les 4 tables l4 portent une date d'écriture ("receivedAt", DEFAULT now())
-- distincte de la date métier. "Sale" et "PartialRefund" n'ont que "createdAt", qui sert de date de
-- vente et que le semis antidate par construction : leur antériorité est couverte par le refus
-- d'inscription (inscrire_tenant_maquette refuse un tenant qui a déjà une vente ou un remboursement).
CREATE OR REPLACE FUNCTION effacer_tenant_maquette(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  t text;
  n bigint;
  v_total bigint := 0;
  v_inscrit_le timestamptz;
  v_anterieur boolean;
  v_compteurs jsonb := '{}'::jsonb;
  v_zero jsonb := '{}'::jsonb;
  v_tenant_avant text := pg_catalog.current_setting('app.current_tenant', true);
  v_lock_avant text := pg_catalog.current_setting('lock_timeout');
  v_stmt_avant text := pg_catalog.current_setting('statement_timeout');
BEGIN
  -- Jamais de queue devant les caisses : un verrou tenu fait échouer l'effacement (repris la nuit suivante).
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  PERFORM pg_catalog.set_config('statement_timeout', '30s', true);
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'MAQUETTE_NON_INSCRITE : tenant absent' USING ERRCODE = 'check_violation';
  END IF;
  -- RLS forcée, propriétaire compris : le contexte est posé AVANT les contrôles.
  PERFORM pg_catalog.set_config('app.current_tenant', p_tenant::text, true);

  FOREACH t IN ARRAY ARRAY[
-- BEGIN:tables
    'CashDayEvent', 'CashDayClosure', 'CashDayOpening', 'CashDaySession', 'PartialRefund', 'SaleLine',
    'SalePayment', 'VoidAction', 'Sale', 'PickupOrder', 'CashMovement', 'CashSessionReopen',
    'CashDay', 'CashSession', 'LoyaltyEntry', 'LoyaltyAccount', 'LoyaltyProgram', 'GiftCard',
    'GiftCardOrder', 'Poste', 'CashSettings', 'CaisseSyncAction', 'ParkedBasket', 'CashDeposit',
    'CashDepositLease'
-- END:tables
  ] LOOP
    EXECUTE pg_catalog.format('SELECT count(*) FROM %I WHERE "tenantId" = $1', t) INTO n USING p_tenant;
    v_total := v_total + n;
    v_zero := v_zero || jsonb_build_object(t, 0);
  END LOOP;

  SELECT m."inscritLe" INTO v_inscrit_le FROM "TenantMaquette" m WHERE m."tenantId" = p_tenant;
  IF NOT FOUND THEN
    PERFORM pg_catalog.set_config('app.current_tenant', coalesce(v_tenant_avant, ''), true);
    IF v_total = 0 THEN
      RETURN v_zero;  -- idempotence : tenant déjà effacé
    END IF;
    RAISE EXCEPTION 'MAQUETTE_NON_INSCRITE : tenant % absent du registre', p_tenant USING ERRCODE = 'check_violation';
  END IF;

  -- "receivedAt" est un TIMESTAMP(3) arrondi à la milliseconde : un fait écrit dans la transaction
  -- même de l'inscription peut s'arrondir sous now(). On compare donc à l'inscription tronquée à la ms.
  SELECT EXISTS (SELECT 1 FROM "CashDayEvent"   WHERE "tenantId" = p_tenant AND "receivedAt" < date_trunc('milliseconds', v_inscrit_le))
      OR EXISTS (SELECT 1 FROM "CashDayClosure" WHERE "tenantId" = p_tenant AND "receivedAt" < date_trunc('milliseconds', v_inscrit_le))
      OR EXISTS (SELECT 1 FROM "CashDayOpening" WHERE "tenantId" = p_tenant AND "receivedAt" < date_trunc('milliseconds', v_inscrit_le))
      -- "CashDaySession" n'a pas de "receivedAt" : seulement "createdAt" (DEFAULT now(), jamais
      -- antidaté par le semis), qui tient le même rôle de date d'écriture.
      OR EXISTS (SELECT 1 FROM "CashDaySession" WHERE "tenantId" = p_tenant AND "createdAt" < date_trunc('milliseconds', v_inscrit_le))
    INTO v_anterieur;
  IF v_anterieur THEN
    RAISE EXCEPTION 'MAQUETTE_FAIT_ANTERIEUR : tenant % porte un fait de caisse anterieur a son inscription', p_tenant
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total > 50000 THEN
    RAISE EXCEPTION 'MAQUETTE_PLAFOND : % lignes', v_total USING ERRCODE = 'check_violation';
  END IF;

-- BEGIN:desactivation
  ALTER TABLE "CashDayEvent" DISABLE TRIGGER cash_event_immutable;
  ALTER TABLE "CashDayClosure" DISABLE TRIGGER cash_closure_immutable;
  ALTER TABLE "CashDayOpening" DISABLE TRIGGER cash_opening_immutable;
  ALTER TABLE "CashDaySession" DISABLE TRIGGER cash_alias_immutable;
-- END:desactivation

-- BEGIN:effacement
  DELETE FROM "CashDayEvent" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashDayEvent', n);
  DELETE FROM "CashDayClosure" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashDayClosure', n);
  DELETE FROM "CashDayOpening" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashDayOpening', n);
  DELETE FROM "CashDaySession" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashDaySession', n);
  DELETE FROM "PartialRefund" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('PartialRefund', n);
  DELETE FROM "SaleLine" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('SaleLine', n);
  DELETE FROM "SalePayment" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('SalePayment', n);
  DELETE FROM "VoidAction" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('VoidAction', n);
  UPDATE "PickupOrder" SET "saleId" = NULL WHERE "tenantId" = p_tenant AND "saleId" IS NOT NULL;
  DELETE FROM "Sale" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('Sale', n);
  DELETE FROM "PickupOrder" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('PickupOrder', n);
  DELETE FROM "CashMovement" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashMovement', n);
  DELETE FROM "CashSessionReopen" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashSessionReopen', n);
  DELETE FROM "CashDay" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashDay', n);
  DELETE FROM "CashSession" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashSession', n);
  DELETE FROM "LoyaltyEntry" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('LoyaltyEntry', n);
  DELETE FROM "LoyaltyAccount" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('LoyaltyAccount', n);
  DELETE FROM "LoyaltyProgram" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('LoyaltyProgram', n);
  DELETE FROM "GiftCard" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('GiftCard', n);
  DELETE FROM "GiftCardOrder" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('GiftCardOrder', n);
  DELETE FROM "Poste" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('Poste', n);
  DELETE FROM "CashSettings" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashSettings', n);
  DELETE FROM "CaisseSyncAction" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CaisseSyncAction', n);
  DELETE FROM "ParkedBasket" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('ParkedBasket', n);
  DELETE FROM "CashDeposit" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashDeposit', n);
  DELETE FROM "CashDepositLease" WHERE "tenantId" = p_tenant;
  GET DIAGNOSTICS n = ROW_COUNT; v_compteurs := v_compteurs || jsonb_build_object('CashDepositLease', n);
-- END:effacement

-- BEGIN:reactivation
  ALTER TABLE "CashDayEvent" ENABLE TRIGGER cash_event_immutable;
  ALTER TABLE "CashDayClosure" ENABLE TRIGGER cash_closure_immutable;
  ALTER TABLE "CashDayOpening" ENABLE TRIGGER cash_opening_immutable;
  ALTER TABLE "CashDaySession" ENABLE TRIGGER cash_alias_immutable;
-- END:reactivation

  DELETE FROM "TenantMaquette" WHERE "tenantId" = p_tenant;

  PERFORM pg_catalog.set_config('app.current_tenant', coalesce(v_tenant_avant, ''), true);
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_avant, true);
  PERFORM pg_catalog.set_config('statement_timeout', v_stmt_avant, true);
  RETURN v_compteurs;
END;
$fn$;

REVOKE ALL ON FUNCTION inscrire_tenant_maquette(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION effacer_tenant_maquette(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_caisse_app') THEN
    GRANT EXECUTE ON FUNCTION inscrire_tenant_maquette(uuid) TO core_caisse_app;
    GRANT EXECUTE ON FUNCTION effacer_tenant_maquette(uuid) TO core_caisse_app;
  END IF;
END $$;

-- Résolution dans le schéma réel des tables (même geste que Core-Compta).
DO $$
DECLARE
  v_schema text;
  f text;
BEGIN
  SELECT n.nspname INTO STRICT v_schema
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = '"Sale"'::pg_catalog.regclass;
  FOREACH f IN ARRAY ARRAY['inscrire_tenant_maquette(uuid)', 'effacer_tenant_maquette(uuid)'] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %I.%s SET search_path = %I, pg_temp', v_schema, f, v_schema);
  END LOOP;
END $$;
