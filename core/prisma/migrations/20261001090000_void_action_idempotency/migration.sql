ALTER TABLE "Sale" ADD COLUMN "creditNoteId" TEXT;
CREATE TABLE "VoidAction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "outcome" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoidAction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VoidAction_tenantId_actionId_key" ON "VoidAction"("tenantId", "actionId");
CREATE INDEX "VoidAction_tenantId_saleId_idx" ON "VoidAction"("tenantId", "saleId");
ALTER TABLE "VoidAction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VoidAction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "VoidAction"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);