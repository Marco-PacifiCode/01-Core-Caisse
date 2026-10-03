-- Commandes de bons cadeaux en ligne (2026-10-03).
--
-- ADDITIVE PURE : un type neuf, une table neuve, deux colonnes NULLABLES ajoutées à "GiftCard"
-- et leurs index. Aucune suppression, aucun renommage, aucune donnée touchée.
--
-- ⚠️ À appliquer sous le rôle propriétaire `core_caisse_owner` (cf. migration 20260811120000).
-- RLS : posée ci-dessous pour la table neuve (même policy `tenant_isolation` que prisma/rls.sql).
-- Prouver ensuite, sous le rôle APPLICATIF : relrowsecurity/relforcerowsecurity = 't' et un
-- `select count(*) from "GiftCardOrder"` sans contexte de tenant qui rend zéro ligne.

-- CreateEnum
CREATE TYPE "GiftCardOrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "GiftCard" ADD COLUMN     "message" TEXT,
ADD COLUMN     "orderId" UUID;

-- CreateTable
CREATE TABLE "GiftCardOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "GiftCardOrderStatus" NOT NULL DEFAULT 'PENDING',
    "channel" TEXT NOT NULL DEFAULT 'ONLINE',
    "amountXpf" BIGINT NOT NULL,
    "serviceId" UUID,
    "serviceLabel" TEXT,
    "buyerName" TEXT NOT NULL,
    "buyerPhone" TEXT,
    "buyerEmail" TEXT,
    "beneficiaryName" TEXT NOT NULL,
    "beneficiaryPhone" TEXT,
    "beneficiaryEmail" TEXT,
    "message" TEXT,
    "paymentMode" TEXT NOT NULL DEFAULT 'ON_SITE',
    "paymentProvider" TEXT,
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "saleId" UUID,
    "giftCardId" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledBy" TEXT,
    "cancelledByName" TEXT,

    CONSTRAINT "GiftCardOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardOrder_giftCardId_key" ON "GiftCardOrder"("giftCardId");

-- CreateIndex
CREATE INDEX "GiftCardOrder_tenantId_status_createdAt_idx" ON "GiftCardOrder"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardOrder_tenantId_reference_key" ON "GiftCardOrder"("tenantId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_orderId_key" ON "GiftCard"("orderId");


-- RLS (motif de prisma/rls.sql, sans suppression préalable de policy : la table est neuve)
ALTER TABLE "GiftCardOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GiftCardOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "GiftCardOrder" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
