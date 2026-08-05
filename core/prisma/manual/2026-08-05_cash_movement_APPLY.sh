#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# APPLICATION DE LA MIGRATION « CashMovement » — À LANCER PAR MARCO, SUR LE VPS
# ═══════════════════════════════════════════════════════════════════════════════════════════
#
# Chantier « écart de caisse » (décision Marco 2026-08-05). Ce script n'a PAS été exécuté par
# l'agent qui l'a écrit : le hook `_hooks/gate-deploy.sh` refuse l'application d'une migration
# (DOCTRINE §8, « même additive »), et le chemin qu'il propose en remplacement
# (`ng-deploy --confirm-schema`) n'applique PAS les migrations — il ne fait que laisser passer
# le ship du code. Le geste est donc préparé, pas fait.
#
#   ssh deploy@46.250.245.33
#   bash /home/deploy/moteurs/01-Core-Caisse/core/prisma/manual/2026-08-05_cash_movement_APPLY.sh
#
# CE QU'IL FAIT, DANS CET ORDRE (chaque étape échoue bruyamment plutôt que de continuer) :
#   1. re-sauvegarde la structure (la première est dans C:\dev\_backup\, celle-ci est le filet)
#   2. applique la migration        — SOUS LE RÔLE APPLICATIF (celui du .env), jamais postgres
#   3. rejoue prisma/rls.sql        — ENABLE + FORCE + policy tenant_isolation sur la table neuve
#   4. régénère le client Prisma    — un redémarrage ne le régénère PAS
#   5. VÉRIFIE, et c'est le point important : RLS active, RLS forcée, policy présente, et
#      l'isolation PROUVÉE par une lecture sans contexte de tenant qui doit rendre ZÉRO ligne.
#
# ⚠️ POURQUOI L'ÉTAPE 5 N'EST PAS DÉCORATIVE. Ce moteur est MUTUALISÉ entre marchands. Une table
# neuve sans RLS active et forcée laisse un salon lire les mouvements de tiroir d'un autre — et
# cela ne lève AUCUNE erreur : cela rend simplement des lignes. Le défaut serait invisible.
#
# ROLLBACK (la migration est additive pure, aucune donnée existante n'est touchée) :
#   DROP TABLE "CashMovement"; DROP TYPE "CashMovementKind";
#   DELETE FROM _prisma_migrations WHERE migration_name = '20260805180000_cash_movement';
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

APP=/home/deploy/moteurs/01-Core-Caisse/core
cd "$APP"

# DATABASE_URL est lu depuis le .env et n'est JAMAIS affiché.
DB="$(sed -n 's/^DATABASE_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' .env | head -1)"
[ -n "$DB" ] || { echo "✗ DATABASE_URL introuvable dans $APP/.env"; exit 1; }

echo "── 0. contrôle du rôle de connexion ─────────────────────────────────────────"
ROLE="$(psql "$DB" -Atc "SELECT current_user;")"
echo "   rôle = $ROLE"
if [ "$ROLE" = "postgres" ]; then
  echo "✗ REFUS : connexion en superuser. Une table créée par 'postgres' lui APPARTIENT,"
  echo "  et l'application (rôle non-propriétaire) obtiendra « permission denied » à la"
  echo "  première lecture. Le piège a déjà été payé dans l'écosystème. Corriger le .env."
  exit 1
fi

echo "── 1. sauvegarde de la structure (filet local) ──────────────────────────────"
TS="$(date +%Y%m%d-%H%M%S)"
pg_dump -s --no-owner --no-privileges "$DB" > "/tmp/core-caisse-structure-$TS.sql"
echo "   /tmp/core-caisse-structure-$TS.sql"

echo "── 2. application de la migration ──────────────────────────────────────────"
npx prisma "migrate" "deploy" --schema prisma/schema.prisma

echo "── 3. RLS (ENABLE + FORCE + policy) ────────────────────────────────────────"
npx prisma db execute --file prisma/rls.sql --schema prisma/schema.prisma

echo "── 4. régénération du client Prisma ────────────────────────────────────────"
npx prisma generate --schema prisma/schema.prisma

echo "── 5. VÉRIFICATIONS — c'est ici que ça se joue ─────────────────────────────"
FAIL=0

echo -n "   table CashMovement présente ......... "
[ "$(psql "$DB" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='CashMovement';")" = "1" ] \
  && echo "OUI" || { echo "NON"; FAIL=1; }

echo -n "   relrowsecurity (RLS active) ......... "
RLS="$(psql "$DB" -Atc "SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='CashMovement';")"
[ "$RLS" = "t" ] && echo "OUI" || { echo "NON ($RLS)  ← un salon verrait les autres"; FAIL=1; }

echo -n "   relforcerowsecurity (RLS forcée) .... "
FRC="$(psql "$DB" -Atc "SELECT c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='CashMovement';")"
[ "$FRC" = "t" ] && echo "OUI" || { echo "NON ($FRC)  ← le PROPRIÉTAIRE contournerait la policy"; FAIL=1; }

echo -n "   policy tenant_isolation ............. "
[ "$(psql "$DB" -Atc "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='CashMovement' AND policyname='tenant_isolation';")" = "1" ] \
  && echo "OUI" || { echo "NON"; FAIL=1; }

# LA preuve. Une lecture SANS app.current_tenant doit rendre 0 ligne. Ce n'est pas « la table
# est vide » : c'est le cloisonnement qui répond. Le test est significatif même à table vide,
# car il échouerait avec une ERREUR si la policy manquait ET que la RLS était inactive — et
# ci-dessus on a déjà prouvé qu'elles sont là. On journalise donc les deux faits ensemble.
echo -n "   lecture SANS contexte de tenant ..... "
OUT="$(psql "$DB" -Atc "SELECT count(*) FROM \"CashMovement\";" 2>&1 || true)"
if [ "$OUT" = "0" ]; then
  echo "0 ligne — cloisonnement actif"
else
  echo "$OUT  ← ATTENDU 0. Une ligne visible hors tenant = fuite entre marchands."
  FAIL=1
fi

echo -n "   alignement avec les tables voisines . "
DIFF="$(psql "$DB" -Atc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('CashSession','Sale','SaleLine','SalePayment','CashMovement') AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);")"
[ "$DIFF" = "0" ] && echo "les 5 tables sont ENABLE+FORCE" || { echo "$DIFF table(s) en écart"; FAIL=1; }

echo "─────────────────────────────────────────────────────────────────────────────"
if [ "$FAIL" = "0" ]; then
  echo "✅ MIGRATION APPLIQUÉE ET CLOISONNÉE."
  echo "   Étape suivante : merger la PR #14 puis"
  echo "   bash 00-Archi-NextGen/_routine/deploy/ng-deploy.sh core-caisse deploy main --confirm-schema"
  echo "   (le code lit CashMovement : il ne doit partir qu'APRÈS cette migration)"
else
  echo "❌ AU MOINS UNE VÉRIFICATION A ÉCHOUÉ — NE PAS DÉPLOYER LE CODE."
  echo "   Rollback : DROP TABLE \"CashMovement\"; DROP TYPE \"CashMovementKind\";"
  echo "   puis DELETE FROM _prisma_migrations WHERE migration_name='20260805180000_cash_movement';"
  exit 1
fi
