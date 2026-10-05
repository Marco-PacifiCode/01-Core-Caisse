-- Registre des postes de caisse (2026-10-05) — quota de la brique Caisse.
--
-- ADDITIVE PURE : une table neuve et ses index. Aucune colonne existante touchée, aucune
-- donnée lue ni écrite. `CashSession.posteId` et `Sale.posteId` restent des chaînes libres.
--
-- PAS DE REPRISE ICI, volontairement : sous FORCE ROW LEVEL SECURITY, le rôle propriétaire
-- ne voit aucune ligne de "CashSession" sans contexte de tenant — une reprise jouée par lui
-- insérerait zéro ligne en silence. Le code n'en a pas besoin : un poste inconnu du registre
-- mais qui a déjà une session ou une vente à son nom est inscrit SANS contrôle à sa prochaine
-- ouverture (lib/postes.ts). La reprise facultative, pour un rôle BYPASSRLS, est dans
-- prisma/manual/2026-10-05_postes_reprise.sql.
--
-- ⚠️ À appliquer sous le rôle propriétaire `core_caisse_owner` (cf. migration 20260811120000).
-- Prouver ensuite, sous le rôle APPLICATIF : relrowsecurity/relforcerowsecurity = 't' et un
-- `select count(*) from "Poste"` sans contexte de tenant qui rend zéro ligne.
-- Tant que cette migration n'est pas jouée, le code ouvre : aucune session n'est refusée.

-- CreateTable
CREATE TABLE "Poste" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "posteId" TEXT NOT NULL,
    "libelle" TEXT,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "horsQuota" BOOLEAN NOT NULL DEFAULT false,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "majLe" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Poste_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Poste_tenantId_posteId_key" ON "Poste"("tenantId", "posteId");

-- CreateIndex
CREATE INDEX "Poste_tenantId_actif_idx" ON "Poste"("tenantId", "actif");

-- RLS (motif de prisma/rls.sql, sans suppression préalable de policy : la table est neuve)
ALTER TABLE "Poste" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Poste" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Poste" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
