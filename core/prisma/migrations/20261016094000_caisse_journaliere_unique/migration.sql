-- L4b, SQL écrit à la main. Les anciennes sessions et pièces restent intactes.
CREATE UNIQUE INDEX "CashSession_tenantId_id_key" ON "CashSession" ("tenantId","id");
CREATE UNIQUE INDEX "PartialRefund_tenantId_id_key" ON "PartialRefund" ("tenantId","id");
CREATE TABLE "CashDay" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "scope" TEXT NOT NULL DEFAULT 'rotisserie-caisse' CHECK ("scope" = 'rotisserie-caisse'),
 "businessDay" TEXT NOT NULL, "canonicalSessionId" UUID NOT NULL, "currentSessionId" UUID NOT NULL,
 "cycle" INTEGER NOT NULL DEFAULT 0 CHECK ("cycle" >= 0), "revision" BIGINT NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 FOREIGN KEY ("tenantId","canonicalSessionId") REFERENCES "CashSession" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("tenantId","currentSessionId") REFERENCES "CashSession" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashDay_tenantId_id_key" ON "CashDay" ("tenantId","id");
CREATE UNIQUE INDEX "CashDay_tenantId_scope_businessDay_key" ON "CashDay" ("tenantId","scope","businessDay");
CREATE TABLE "CashDaySession" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "cashDayId" UUID NOT NULL, "sessionId" UUID NOT NULL, "cycle" INTEGER NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("tenantId","cashDayId") REFERENCES "CashDay" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("tenantId","sessionId") REFERENCES "CashSession" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashDaySession_tenantId_sessionId_key" ON "CashDaySession" ("tenantId","sessionId");
CREATE INDEX "CashDaySession_tenantId_cashDayId_idx" ON "CashDaySession" ("tenantId","cashDayId");
CREATE TABLE "CashDayOpening" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "cashDayId" UUID NOT NULL, "sourceKey" TEXT NOT NULL,
 "localSessionKey" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "deviceName" TEXT NOT NULL, "actorId" UUID,
 "actorName" TEXT NOT NULL DEFAULT 'auteur non enregistré', "receivedById" UUID NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "openingFloatXpf" BIGINT NOT NULL CHECK ("openingFloatXpf" >= 0), "legacySessionId" UUID,
 FOREIGN KEY ("tenantId","cashDayId") REFERENCES "CashDay" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("tenantId","legacySessionId") REFERENCES "CashSession" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashDayOpening_tenantId_sourceKey_key" ON "CashDayOpening" ("tenantId","sourceKey");
CREATE INDEX "CashDayOpening_tenantId_cashDayId_receivedAt_idx" ON "CashDayOpening" ("tenantId","cashDayId","receivedAt");
CREATE TABLE "CashDayClosure" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "cashDayId" UUID NOT NULL, "sourceKey" TEXT NOT NULL, "cycle" INTEGER NOT NULL DEFAULT 0,
 "deviceId" TEXT NOT NULL, "deviceName" TEXT NOT NULL, "actorId" UUID, "actorName" TEXT NOT NULL DEFAULT 'auteur non enregistré', "receivedById" UUID NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "countedXpf" BIGINT NOT NULL CHECK ("countedXpf" >= 0),
 "localExpectedXpf" BIGINT NOT NULL, "localVarianceXpf" BIGINT NOT NULL, "baselineExpectedXpf" BIGINT NOT NULL,
 "closureMode" TEXT NOT NULL CHECK ("closureMode" IN ('ONLINE','OFFLINE','IMPORT')), "cutoffRevision" BIGINT NOT NULL,
 "authoritative" BOOLEAN NOT NULL, "legacySessionId" UUID, "legacySnapshot" JSONB,
 FOREIGN KEY ("tenantId","cashDayId") REFERENCES "CashDay" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("tenantId","legacySessionId") REFERENCES "CashSession" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashDayClosure_tenantId_sourceKey_key" ON "CashDayClosure" ("tenantId","sourceKey");
CREATE INDEX "CashDayClosure_tenantId_cashDayId_cycle_idx" ON "CashDayClosure" ("tenantId","cashDayId","cycle");
CREATE UNIQUE INDEX "CashDayClosure_authoritative_cycle" ON "CashDayClosure" ("tenantId","cashDayId","cycle") WHERE "authoritative" = true;
ALTER TABLE "Sale" ADD COLUMN "cashDayId" UUID;
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_tenantId_cashDayId_fkey" FOREIGN KEY ("tenantId","cashDayId") REFERENCES "CashDay" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartialRefund" ADD COLUMN "cashDayId" UUID, ADD COLUMN "drawerBusinessDay" TEXT, ADD COLUMN "deviceId" TEXT;
ALTER TABLE "PartialRefund" ADD CONSTRAINT "PartialRefund_tenantId_cashDayId_fkey" FOREIGN KEY ("tenantId","cashDayId") REFERENCES "CashDay" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "CashDayEvent" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "cashDayId" UUID NOT NULL, "sequence" BIGINT NOT NULL,
 "kind" TEXT NOT NULL, "sourceRef" TEXT NOT NULL, "saleId" UUID, "refundActionId" UUID, "deviceId" TEXT NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "cashDeltaXpf" BIGINT NOT NULL, "snapshot" JSONB NOT NULL,
 FOREIGN KEY ("tenantId","cashDayId") REFERENCES "CashDay" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("tenantId","saleId") REFERENCES "Sale" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
 FOREIGN KEY ("tenantId","refundActionId") REFERENCES "PartialRefund" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CashDayEvent_tenantId_cashDayId_sequence_key" ON "CashDayEvent" ("tenantId","cashDayId","sequence");
CREATE UNIQUE INDEX "CashDayEvent_tenantId_cashDayId_kind_sourceRef_key" ON "CashDayEvent" ("tenantId","cashDayId","kind","sourceRef");
-- Les faits et comptages ne peuvent être corrigés ni supprimés, même par l'application.
CREATE FUNCTION caisse_l4_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_CASH_FACT'; END $$;
CREATE TRIGGER cash_event_immutable BEFORE UPDATE OR DELETE ON "CashDayEvent" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();
CREATE TRIGGER cash_closure_immutable BEFORE UPDATE OR DELETE ON "CashDayClosure" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();
CREATE TRIGGER cash_opening_immutable BEFORE UPDATE OR DELETE ON "CashDayOpening" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();
CREATE TRIGGER cash_alias_immutable BEFORE UPDATE OR DELETE ON "CashDaySession" FOR EACH ROW EXECUTE FUNCTION caisse_l4_immutable();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['CashDay','CashDaySession','CashDayOpening','CashDayClosure','CashDayEvent'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'',true),'''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'',true),'''')::uuid)',t);
 END LOOP;
END $$;
