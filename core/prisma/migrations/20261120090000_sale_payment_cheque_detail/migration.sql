-- Détail facultatif d'un paiement par chèque (n° + banque). Additif, nullable, aucune ligne existante réécrite.
ALTER TABLE "SalePayment" ADD COLUMN "chequeNumber" TEXT, ADD COLUMN "chequeBank" TEXT;
