-- Dépôts appliqués par le serveur (2026-11-04) : migration ADDITIVE seulement.
ALTER TABLE "CashDeposit"
  ADD COLUMN "formatVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sequence" BIGINT,
  ADD COLUMN "actorId" TEXT,
  ADD COLUMN "actorName" TEXT,
  ADD COLUMN "receivedById" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastResultCode" TEXT,
  ADD COLUMN "lastResultReason" TEXT,
  ADD COLUMN "resultJson" JSONB;

CREATE INDEX "CashDeposit_apply_order_idx"
  ON "CashDeposit"("tenantId", "status", "formatVersion", "deviceId", "sequence", "clientCreatedAt", "actionId");

CREATE TABLE "CashDepositLease" (
  "tenantId" UUID NOT NULL,
  "holder" TEXT NOT NULL,
  "token" UUID NOT NULL,
  "until" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "CashDepositLease_pkey" PRIMARY KEY ("tenantId")
);
