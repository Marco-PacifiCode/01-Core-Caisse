-- Mouvement de tiroir — chantier « écart de caisse » (décision Marco, 2026-08-05).
--
-- ADDITIVE PURE : une table neuve et un type neuf. Aucune colonne existante n'est modifiée,
-- aucune donnée n'est touchée, aucune contrainte n'est ajoutée à une table en service.
-- Rollback : DROP TABLE "CashMovement"; DROP TYPE "CashMovementKind";
--
-- ⚠️ À APPLIQUER SOUS LE RÔLE APPLICATIF, JAMAIS `postgres`.
-- Une table créée en superuser appartient à `postgres` : l'app (rôle non-propriétaire) obtient
-- alors « permission denied » à la première lecture. Le piège a déjà été payé dans l'écosystème.
--
-- ⚠️ CETTE MIGRATION NE SUFFIT PAS. Le moteur est MUTUALISÉ entre marchands : sans RLS active,
-- FORCÉE, et sa policy d'isolation, un salon lit les mouvements de tiroir d'un autre — et cela ne
-- lève AUCUNE erreur, cela rend simplement des lignes. Enchaîner IMPÉRATIVEMENT :
--     npm run db:rls        (prisma/rls.sql — 'CashMovement' est dans sa liste de tables)
-- puis vérifier relrowsecurity ET relforcerowsecurity, et prouver l'isolation par une lecture
-- SANS contexte de tenant : elle doit rendre ZÉRO ligne (ce qui n'est pas « table vide » mais
-- « cloisonnement actif »).

CREATE TYPE "CashMovementKind" AS ENUM ('REFUND', 'CASH_OUT', 'CASH_IN');

CREATE TABLE "CashMovement" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId"      UUID NOT NULL,
    "sessionId"     UUID NOT NULL,
    "kind"          "CashMovementKind" NOT NULL,
    "amountXpf"     BIGINT NOT NULL,
    "reason"        TEXT NOT NULL,
    "ref"           TEXT,
    "createdBy"     UUID,
    "createdByName" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- Un avoir ne se rembourse qu'UNE fois — garanti en base, pas seulement au clic.
-- NULLS DISTINCT (défaut PostgreSQL) : plusieurs mouvements sans `ref` restent permis, ce qui
-- est voulu (un prélèvement ou un apport n'a pas de pièce de référence).
CREATE UNIQUE INDEX "CashMovement_tenantId_ref_key" ON "CashMovement" ("tenantId", "ref");

CREATE INDEX "CashMovement_tenantId_sessionId_idx" ON "CashMovement" ("tenantId", "sessionId");
CREATE INDEX "CashMovement_tenantId_createdAt_idx" ON "CashMovement" ("tenantId", "createdAt");

-- RESTRICT et pas CASCADE, à dessein : une session de caisse ne se supprime pas, et si elle le
-- devenait un jour, emporter en silence les mouvements de tiroir qui expliquent un écart serait
-- exactement la « mine désamorcée mais pas déminée » relevée ailleurs dans l'écosystème.
ALTER TABLE "CashMovement"
  ADD CONSTRAINT "CashMovement_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
