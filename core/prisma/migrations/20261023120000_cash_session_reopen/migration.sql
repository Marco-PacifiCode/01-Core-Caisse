-- Trace des réouvertures de caisse (2026-10-23, décision Marco : seule la dernière caisse
-- fermée peut être rouverte).
--
-- ADDITIVE PURE : une table neuve, ses index, sa FK et sa politique RLS. Aucune colonne
-- existante touchée, aucune donnée lue ni écrite.
--
-- ⚠️ À appliquer sous le rôle propriétaire `core_caisse_owner`.
-- ROLLBACK : DROP TABLE "CashSessionReopen"; (aucune autre table ne la référence)

-- CreateTable
CREATE TABLE "CashSessionReopen" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedBy" UUID,
    "closedByName" TEXT,
    "closingCountedXpf" BIGINT,
    "expectedXpf" BIGINT,
    "varianceXpf" BIGINT,
    "reopenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedBy" TEXT,

    CONSTRAINT "CashSessionReopen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashSessionReopen_tenantId_idx" ON "CashSessionReopen"("tenantId");

-- CreateIndex
CREATE INDEX "CashSessionReopen_tenantId_sessionId_reopenedAt_idx" ON "CashSessionReopen"("tenantId", "sessionId", "reopenedAt");

-- AddForeignKey
ALTER TABLE "CashSessionReopen" ADD CONSTRAINT "CashSessionReopen_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (motif de prisma/rls.sql, table neuve)
ALTER TABLE "CashSessionReopen" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashSessionReopen" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CashSessionReopen" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
