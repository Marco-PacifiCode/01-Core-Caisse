-- Lier un bon cadeau consommé au RDV qu'il a réglé — pour qu'un RDV honoré par un bon SEUL
-- (pas de reliquat en espèces/CB) ne réapparaisse pas « à encaisser » côté surface.
--
-- ADDITIVE PURE : une seule colonne NULLABLE sur une table déjà en service. Aucun type créé,
-- aucune contrainte posée, aucune donnée existante touchée, aucune ligne lue.
--
-- SANS clé étrangère, exactement comme `Sale.sourceId` / `GiftCard.saleId` : le bon ne doit
-- jamais pouvoir bloquer une opération sur le RDV, et la trace suffit au rapprochement.
--
-- RETOUR ARRIÈRE, EN UNE LIGNE ET SANS PERTE POUR LE RESTE :
--     ALTER TABLE "GiftCard" DROP COLUMN "redeemedAppointmentId";
--
-- ⚠️ À APPLIQUER SOUS LE RÔLE PROPRIÉTAIRE `core_caisse_owner` (`DATABASE_URL_OWNER`), JAMAIS
-- sous `postgres` ni sous `core_caisse_app` — même piège de droits que `20260811120000_gift_card`.

-- AlterTable
ALTER TABLE "GiftCard" ADD COLUMN "redeemedAppointmentId" TEXT;
