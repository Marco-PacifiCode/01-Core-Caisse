# API Caisse — contrôle des sessions

`POST /api/sales` avec `sessionId`, et `POST /api/sales/:id/checkout`
pour une vente rattachée à une session, refusent désormais une session qui
n'est pas `OPEN` avec HTTP **409** : `{ "ok": false, "error": "SESSION_NOT_OPEN" }`.
Une session introuvable dans le tenant est également refusée avec ce code.
Les routes conservent leur enveloppe d'erreur `CashContractError` existante.

La lecture de l'état se fait sous le verrou tenant partagé avec la clôture.
Les paiements et le passage à `PAID` sont dans une seule transaction : une
clôture passée avant le checkout entraîne un refus sans nouveau paiement.
Les appels Compta/Stock restent après le commit. Le rejeu d'une vente déjà
`PAID` conserve son comportement idempotent, y compris après clôture.
Sans session et sans CashDay, le comportement historique est conservé.
Les règles CashDay et l'annulation des ventes restent inchangées.

Recette PostgreSQL (depuis `core`, base jetable préparée par ci-local) :
`node --test --experimental-strip-types "test-pg/**/*.test.ts"` (`test:pg`).
`test-pg/session-open.test.ts` couvre OPEN → PAID → Z, la clôture tenant
bloquant réellement le checkout (observation `pg_stat_activity`), le refus
CLOSED sans paiement résiduel, l'absence de session et une nouvelle OPEN.
Le dernier test compare une copie octet par octet avant sabotage, enlève la
garde OPEN du checkout sur cette copie, exige l'échec du scénario concurrent,
puis supprime la copie dans `finally`. Aucune modification du code de production.
