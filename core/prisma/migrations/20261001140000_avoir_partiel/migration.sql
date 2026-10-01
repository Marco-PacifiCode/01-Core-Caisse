ALTER TABLE "Sale" ADD COLUMN "fullyRefundedAt" TIMESTAMP(3);
ALTER TABLE "Sale" ADD COLUMN "voidPreparedAt" TIMESTAMP(3);
CREATE TABLE "PartialRefund" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "actionId" UUID NOT NULL,
  "saleId" UUID NOT NULL REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'DONE')),
  "input" JSONB NOT NULL,
  "plan" JSONB NOT NULL,
  "outcome" JSONB,
  "creditNoteId" TEXT,
  "sessionId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartialRefund_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartialRefund_tenantId_actionId_key" ON "PartialRefund"("tenantId", "actionId");
CREATE INDEX "PartialRefund_tenantId_saleId_idx" ON "PartialRefund"("tenantId", "saleId");
CREATE UNIQUE INDEX "PartialRefund_one_pending_sale" ON "PartialRefund"("tenantId", "saleId") WHERE "status" = 'PENDING';
ALTER TABLE "PartialRefund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PartialRefund" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PartialRefund"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
