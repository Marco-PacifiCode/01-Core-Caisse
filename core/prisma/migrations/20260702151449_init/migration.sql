-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "LineKind" AS ENUM ('SERVICE', 'PRODUCT', 'OTHER');

-- CreateEnum
CREATE TYPE "PayMethod" AS ENUM ('CASH', 'CARD', 'TRANSFER', 'CHEQUE', 'OTHER');

-- CreateTable
CREATE TABLE "CashSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "openedBy" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloatXpf" BIGINT NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "closedBy" UUID,
    "closingCountedXpf" BIGINT,
    "expectedXpf" BIGINT,
    "varianceXpf" BIGINT,
    "note" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" UUID,
    "status" "SaleStatus" NOT NULL DEFAULT 'DRAFT',
    "cashierId" UUID,
    "clientName" TEXT,
    "subtotalXpf" BIGINT NOT NULL DEFAULT 0,
    "totalXpf" BIGINT NOT NULL DEFAULT 0,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "invoiceId" TEXT,
    "invoiceNumber" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "kind" "LineKind" NOT NULL,
    "label" TEXT NOT NULL,
    "productId" UUID,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitXpf" BIGINT NOT NULL DEFAULT 0,
    "lineXpf" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalePayment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "method" "PayMethod" NOT NULL,
    "amountXpf" BIGINT NOT NULL,
    "tenderedXpf" BIGINT,
    "settleRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashSession_tenantId_idx" ON "CashSession"("tenantId");

-- CreateIndex
CREATE INDEX "CashSession_tenantId_status_idx" ON "CashSession"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CashSession_tenantId_openedAt_idx" ON "CashSession"("tenantId", "openedAt");

-- CreateIndex
CREATE INDEX "Sale_tenantId_sourceType_sourceId_idx" ON "Sale"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "Sale_tenantId_status_idx" ON "Sale"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Sale_tenantId_sessionId_idx" ON "Sale"("tenantId", "sessionId");

-- CreateIndex
CREATE INDEX "Sale_tenantId_createdAt_idx" ON "Sale"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleLine_tenantId_saleId_idx" ON "SaleLine"("tenantId", "saleId");

-- CreateIndex
CREATE INDEX "SaleLine_tenantId_productId_idx" ON "SaleLine"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "SalePayment_tenantId_saleId_idx" ON "SalePayment"("tenantId", "saleId");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

