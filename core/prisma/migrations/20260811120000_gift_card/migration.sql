-- Bon cadeau — chantier PC-0064 (décisions Marco, 2026-08-11).
--
-- 🔒 L'INVARIANT DU MODULE : le montant d'un bon entre dans le CA UNE SEULE FOIS, le jour de son
-- achat. Un bon cadeau est une PRESTATION VENDUE À L'AVANCE, pas un moyen de paiement.
--
-- ADDITIVE PURE, ET STRICTEMENT : une seule table NEUVE. Aucun type n'est créé, aucune valeur
-- n'est ajoutée à un enum existant (`PayMethod` et `LineKind` ne bougent pas — une valeur d'enum
-- PostgreSQL ne se retire JAMAIS, c'est le seul geste vraiment sans retour de ce fichier, et il
-- n'est pas fait). Aucune colonne n'est ajoutée à une table en service, aucune contrainte n'est
-- posée sur une table existante, aucune donnée n'est touchée, aucune ligne n'est lue.
--
-- RETOUR ARRIÈRE, EN UNE LIGNE ET SANS PERTE POUR LE RESTE :
--     DROP TABLE "GiftCard";
--
-- ⚠️ À APPLIQUER SOUS LE RÔLE PROPRIÉTAIRE `core_caisse_owner` (`DATABASE_URL_OWNER`), JAMAIS
-- sous `postgres` ni sous `core_caisse_app`. Le piège est symétrique et il a déjà été payé ici :
-- une table créée en superuser appartient à `postgres` et l'application (rôle non-propriétaire)
-- récolte « permission denied » à la première lecture ; à l'inverse `core_caisse_app` n'a pas
-- `CREATE` sur `public` et ne peut rien créer. Les droits DML de l'app viennent des DEFAULT
-- PRIVILEGES du propriétaire, qui ne jouent QUE si c'est bien lui qui a créé la table.
--
-- ⚠️ CETTE MIGRATION NE SUFFIT PAS. Le moteur est MUTUALISÉ entre marchands : sans RLS active,
-- FORCÉE, et sa policy d'isolation, un salon lit les bons cadeaux d'un autre — et cela ne lève
-- AUCUNE erreur, cela rend simplement des lignes. Enchaîner IMPÉRATIVEMENT :
--     npm run db:rls        (prisma/rls.sql — 'GiftCard' est dans sa liste de tables)
-- puis PROUVER, sous le rôle APPLICATIF et non sous le propriétaire :
--     relrowsecurity ET relforcerowsecurity = 't', policy `tenant_isolation` présente, et un
--     `select count(*) from "GiftCard"` SANS contexte de tenant qui rend ZÉRO ligne.
--
-- 🔴 CE QUE CE SCHÉMA PORTE, ET QUI DOIT RESTER VRAI :
--   · `redeemedAt` est la SENTINELLE d'unicité de la consommation. Le code consomme par un
--     UPDATE conditionné à `"redeemedAt" IS NULL`, jamais par un SELECT suivi d'un UPDATE :
--     deux comptoirs qui scannent le même bon à la même seconde ne peuvent pas le passer deux
--     fois. Zéro ligne affectée ⇒ refus nommé.
--   · `@@unique(tenantId, code)` : le code d'un bon ne vaut que dans SON marchand, et l'unicité
--     est garantie EN BASE, pas au clic.
--   · Il n'y a AUCUNE clé étrangère — ni vers `Sale`, ni vers `CashSession`. Vers `CashSession`
--     c'est structurel : une consommation n'est PAS une opération de caisse, elle n'a aucune
--     comptabilité ; le Z la rattache par fenêtre de temps sur `redeemedAt`, d'où l'index.
--   · Aucune colonne de statut. « Expiré » se DÉRIVE de `expiresAt` à la lecture : un statut
--     stocké imposerait un travail de fond, donc une production qui mute toute seule.

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "amountXpf" BIGINT NOT NULL,
    "serviceLabel" TEXT,
    "serviceId" UUID,
    "buyerName" TEXT,
    "buyerPhone" TEXT,
    "buyerEmail" TEXT,
    "beneficiaryName" TEXT,
    "beneficiaryPhone" TEXT,
    "beneficiaryEmail" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "saleId" UUID,
    "invoiceNumber" TEXT,
    "redeemedAt" TIMESTAMP(3),
    "redeemedBy" UUID,
    "redeemedByName" TEXT,
    "redeemedForXpf" BIGINT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledBy" UUID,
    "cancelledByName" TEXT,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GiftCard_tenantId_redeemedAt_idx" ON "GiftCard"("tenantId", "redeemedAt");

-- CreateIndex
CREATE INDEX "GiftCard_tenantId_issuedAt_idx" ON "GiftCard"("tenantId", "issuedAt");

-- CreateIndex
CREATE INDEX "GiftCard_tenantId_saleId_idx" ON "GiftCard"("tenantId", "saleId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_tenantId_code_key" ON "GiftCard"("tenantId", "code");
