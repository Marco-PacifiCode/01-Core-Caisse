-- L4a, SQL écrit à la main : strictement additif. Aucun prérequis Poste.
CREATE TABLE "CashSettings" (
 "tenantId" UUID PRIMARY KEY, "defaultFloatXpf" BIGINT NOT NULL DEFAULT 25000 CHECK ("defaultFloatXpf" BETWEEN 0 AND 99999999),
 "revision" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "CaisseSyncAction" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "actionId" TEXT NOT NULL, "deviceId" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "entityKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','ACK','CONFLICT','REJECTED')), "response" JSONB,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "CaisseSyncAction_tenantId_actionId_key" ON "CaisseSyncAction" ("tenantId","actionId");
CREATE INDEX "CaisseSyncAction_tenantId_entityKey_idx" ON "CaisseSyncAction" ("tenantId","entityKey");
CREATE TABLE "ParkedBasket" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "sourceKey" TEXT NOT NULL, "label" TEXT NOT NULL, "lines" JSONB NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL, "status" TEXT NOT NULL DEFAULT 'WAITING' CHECK ("status" IN ('WAITING','CLAIMED','CONSUMED','DELETED')),
 "claimedByDevice" TEXT, "claimActionId" TEXT, "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "ParkedBasket_tenantId_id_key" ON "ParkedBasket" ("tenantId","id");
CREATE UNIQUE INDEX "ParkedBasket_tenantId_sourceKey_key" ON "ParkedBasket" ("tenantId","sourceKey");
CREATE INDEX "ParkedBasket_tenantId_createdAt_id_idx" ON "ParkedBasket" ("tenantId","createdAt","id");
CREATE TABLE "PickupOrder" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "sourceKey" TEXT NOT NULL, "clientName" TEXT NOT NULL, "phone" TEXT NOT NULL,
 "pickupDay" TEXT NOT NULL, "pickupTime" TEXT NOT NULL, "lines" JSONB NOT NULL, "summary" TEXT NOT NULL DEFAULT '',
 "totalXpf" BIGINT NOT NULL CHECK ("totalXpf" >= 0), "depositXpf" BIGINT NOT NULL DEFAULT 0 CHECK ("depositXpf" >= 0),
 "status" TEXT NOT NULL DEFAULT 'A_PREPARER' CHECK ("status" IN ('A_PREPARER','PRETE','RETIREE','ANNULEE','PERDUE')),
 "occurredAt" TIMESTAMP(3) NOT NULL, "pickedUpAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "saleId" UUID,
 "ticketNumber" TEXT, "claimedByDevice" TEXT, "claimActionId" TEXT, "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "PickupOrder_tenantId_id_key" ON "PickupOrder" ("tenantId","id");
CREATE UNIQUE INDEX "PickupOrder_tenantId_sourceKey_key" ON "PickupOrder" ("tenantId","sourceKey");
CREATE INDEX "PickupOrder_tenantId_createdAt_id_idx" ON "PickupOrder" ("tenantId","createdAt","id");
CREATE INDEX "PickupOrder_tenantId_pickupDay_idx" ON "PickupOrder" ("tenantId","pickupDay");
ALTER TABLE "Sale" ADD COLUMN "deviceId" TEXT, ADD COLUMN "deviceName" TEXT, ADD COLUMN "ticketNumber" TEXT,
 ADD COLUMN "sellerId" UUID, ADD COLUMN "sellerName" TEXT, ADD COLUMN "pickupOrderId" UUID;
CREATE UNIQUE INDEX "Sale_tenantId_id_key" ON "Sale" ("tenantId","id");
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_tenantId_pickupOrderId_fkey" FOREIGN KEY ("tenantId","pickupOrderId") REFERENCES "PickupOrder" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PickupOrder" ADD CONSTRAINT "PickupOrder_tenantId_saleId_fkey" FOREIGN KEY ("tenantId","saleId") REFERENCES "Sale" ("tenantId","id") ON DELETE RESTRICT ON UPDATE CASCADE;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['CashSettings','CaisseSyncAction','ParkedBasket','PickupOrder'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'',true),'''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'',true),'''')::uuid)',t);
 END LOOP;
END $$;
