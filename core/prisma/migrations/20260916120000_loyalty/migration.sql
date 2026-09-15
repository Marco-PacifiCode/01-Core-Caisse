-- CreateTable
CREATE TABLE "LoyaltyProgram" (
    "tenantId" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'OFF',
    "visitsPerReward" INTEGER,
    "pointsPerHundredXpf" INTEGER,
    "pointsBase" TEXT NOT NULL DEFAULT 'SERVICES',
    "pointsPerReward" INTEGER,
    "rewardKind" TEXT,
    "rewardPercent" INTEGER,
    "rewardAmountXpf" BIGINT,
    "rewardBase" TEXT NOT NULL DEFAULT 'SERVICES',
    "rewardValidityMonths" INTEGER,
    "clientPortalVisible" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "LoyaltyProgram_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "clientFicheId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "visits" INTEGER NOT NULL DEFAULT 0,
    "points" INTEGER NOT NULL DEFAULT 0,
    "rewardKind" TEXT,
    "rewardPercent" INTEGER,
    "rewardAmountXpf" BIGINT,
    "rewardBase" TEXT,
    "expiresAt" TIMESTAMP(3),
    "redeemedAt" TIMESTAMP(3),
    "redeemedSaleId" UUID,
    "rewardEntryId" UUID,
    "discountXpf" BIGINT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "saleId" UUID,
    "actorId" TEXT,
    "actorName" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyAccount_tenantId_idx" ON "LoyaltyAccount"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_tenantId_clientFicheId_key" ON "LoyaltyAccount"("tenantId", "clientFicheId");

-- CreateIndex
CREATE INDEX "LoyaltyEntry_tenantId_accountId_occurredAt_idx" ON "LoyaltyEntry"("tenantId", "accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "LoyaltyEntry_tenantId_kind_redeemedAt_idx" ON "LoyaltyEntry"("tenantId", "kind", "redeemedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyEntry_tenantId_ref_key" ON "LoyaltyEntry"("tenantId", "ref");

-- AddForeignKey
ALTER TABLE "LoyaltyEntry" ADD CONSTRAINT "LoyaltyEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LoyaltyAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

