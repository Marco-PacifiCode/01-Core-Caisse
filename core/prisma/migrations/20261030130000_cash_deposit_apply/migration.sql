ALTER TABLE "CashDeposit"
  ADD COLUMN "formatVersion" INTEGER,
  ADD COLUMN "sequence" BIGINT,
  ADD COLUMN "actorId" UUID,
  ADD COLUMN "receivedById" UUID,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastResultCode" TEXT,
  ADD COLUMN "lastResultReason" TEXT,
  ADD COLUMN "resultJson" JSONB;
CREATE INDEX "CashDeposit_tenantId_status_formatVersion_idx" ON "CashDeposit"("tenantId", "status", "formatVersion");
CREATE TABLE "CashDepositLease" (
  "tenantId" UUID NOT NULL,
  "holder" TEXT NOT NULL,
  "token" UUID NOT NULL,
  "until" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "CashDepositLease_pkey" PRIMARY KEY ("tenantId")
);
ALTER TABLE "CashDepositLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashDepositLease" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CashDepositLease" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
