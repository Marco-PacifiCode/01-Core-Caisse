-- Nom lisible de l'opérateur figé à l'ouverture/clôture de session (affichage caisse).
-- Additif, nullable → réversible (DROP COLUMN). Owner requis (cf. INFRA / brief).
ALTER TABLE "CashSession" ADD COLUMN "openedByName" TEXT;
ALTER TABLE "CashSession" ADD COLUMN "closedByName" TEXT;
