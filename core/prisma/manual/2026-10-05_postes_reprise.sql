-- Reprise FACULTATIVE du registre des postes (2026-10-05) — à jouer APRÈS la migration
-- 20261005130000_postes, sous un rôle BYPASSRLS (le propriétaire « nu » ne voit aucune ligne
-- de "CashSession" ni de "Sale" sous FORCE ROW LEVEL SECURITY : il insérerait zéro ligne).
--
-- À quoi elle sert : que le compteur de postes d'un tenant soit juste DÈS le premier jour.
-- Sans elle rien ne casse — un poste qui a déjà travaillé est inscrit sans contrôle à sa
-- prochaine ouverture de session — mais le compteur ne monte qu'au fil des ouvertures.
--
-- Idempotente (ON CONFLICT DO NOTHING). N'écrit que dans "Poste". Ne lit que des colonnes.
INSERT INTO "Poste" ("id", "tenantId", "posteId", "creeLe", "majLe")
SELECT gen_random_uuid(), s."tenantId", s."posteId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
  SELECT "tenantId", "posteId" FROM "CashSession" WHERE "posteId" IS NOT NULL
  UNION
  SELECT "tenantId", "posteId" FROM "Sale" WHERE "posteId" IS NOT NULL
) AS s
ON CONFLICT ("tenantId", "posteId") DO NOTHING;

-- Contrôle : nombre de postes repris par tenant.
SELECT "tenantId", count(*) AS postes FROM "Poste" GROUP BY "tenantId" ORDER BY postes DESC;
