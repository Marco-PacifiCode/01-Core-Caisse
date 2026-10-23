# API Caisse — contrôle des sessions

Une vente encaissée compte dans le Z de la session OPEN où elle est encaissée.
`POST /api/sales` avec `sessionId`, après l'idempotence source externe, et
`POST /api/sales/:id/checkout` pour un ticket DRAFT avec session : si cette
session n'est plus OPEN (ou est introuvable), rattachement à une session OPEN.
Le poste est identifié par `Sale.posteId` (ou `input.posteId` à la création),
puis `CashSession.posteId` de l'ancienne session. Le texte du poste est conservé
exactement. Si le poste est connu, seule une session de ce poste est éligible.
Sinon, recherche dans le tenant : session OPEN la plus récente (`openedAt`
décroissant, puis `id` croissant pour départager). Le rattachement produit un
journal structuré WARN `vente_rattachee` avec
`{tenantId, saleId, ancienneSession, nouvelleSession}`, sans donnée personnelle.

Sans session OPEN éligible : HTTP **409**
`{ "ok": false, "error": "SESSION_NOT_OPEN" }` via `CashContractError`.
Ouvrir une session puis réessayer ; une file hors ligne peut réessayer plus tard.
Le 409 ne persiste aucun paiement ni rattachement. Un rejeu source externe
renvoie toujours la vente existante, même si sa session est CLOSED.

Lecture et rattachement se font sous le verrou tenant partagé avec la clôture.
Paiements, rattachement et passage à PAID restent dans une seule transaction.
Un checkout concurrent attend la clôture, puis trouve une session OPEN éligible
ou reçoit le 409. Les appels Compta/Stock restent après le commit.
`paidAt` hors ligne reste conservé : il ne choisit pas le Z de rattachement.
La clôture laisse les DRAFT ouverts et ignore ces tickets dans le Z (PAID seuls).
Le Z de l'ancienne session ne reçoit donc pas leur encaissement ultérieur ;
son attendu figé reste inchangé.

Sans session et sans CashDay, comportement historique conservé. Rejeu PAID et
VOID inchangés. CashDay garde son parcours propre : `cash-day-guard.ts` interdit
les écritures historiques dès qu'un jour existe ; le checkout CashDay conserve
ses contrôles de jour, sans ce rattachement classique.

Recette PostgreSQL : `node --test --experimental-strip-types "test-pg/**/*.test.ts"`
depuis `core` (`test:pg`), uniquement sur la base jetable préparée par ci-local.
Cas de `test-pg/session-open.test.ts` :
- (a) OPEN → PAID et Z à 1 000 XPF ;
- (b) clôture tenue, attente constatée par `pg_stat_activity` → 409 sans paiement ;
  avec une nouvelle OPEN créée sous le verrou avant libération → PAID rattaché ;
- (c–e) CLOSED sans OPEN → 409 ; sans session → accepté ; nouvelle OPEN → accepté,
  y compris création avec l'ancien sessionId ;
- (f) rejeu source après clôture → identifiant existant, aucun doublon ;
- (g) DRAFT CLOSED → nouvelle session du même poste, PAID dans son Z uniquement ;
- (h) aucun OPEN → 409, vente entièrement inchangée, aucun paiement ;
- (i) `paidAt` hors ligne → accepté, date conservée, nouvelle session et son Z.
Sabotages sur copie comparée octet par octet : garde seule → (g) échoue ;
sans garde ni rattachement → (b) échoue. Copie supprimée dans `finally`.

## Réouverture de la dernière caisse fermée (2026-10-23)

`POST /api/sessions/:id/reopen` (S2S, `X-Core-Key`, même portée de clé que la
clôture). Corps `{ "tenantId": "...", "by"?: "staff/opérateur" }`.
Autorisé seulement si la session est CLOSED, qu'elle est la plus récente
(`openedAt`) de sa portée — même poste, ou marchand sans poste (`posteId` NULL),
comme la garde « une seule session ouverte » — et qu'aucune session OPEN n'existe
sur cette portée. Dès qu'une session plus récente existe, refus : les caisses
précédentes restent figées.

- 200 `{ ok: true, sessionId, reopenId }` ;
- 404 `{ ok: false, error: "SESSION_NOT_FOUND" }` ;
- 409 `{ ok: false, error, message }` avec `SESSION_NOT_CLOSED` (« Cette caisse
  n'est pas fermée. »), `SESSION_ALREADY_OPEN` (« Une caisse est déjà ouverte. »),
  `NOT_LAST_SESSION` (« Seule la dernière caisse fermée peut être rouverte. ») ;
- 409 `CASHDAY_ROUTE_REQUIRED` sous CashDay (même garde que la clôture).

Effet, dans une transaction sous RLS : la clôture annulée est copiée dans
`CashSessionReopen`, puis la session repasse OPEN avec `closedAt`, `closedBy`,
`closedByName`, `closingCountedXpf`, `expectedXpf`, `varianceXpf` remis à null.
La clôture suivante (`POST /api/sessions/:id/close`) refait un Z complet.

`GET /api/sessions` renvoie pour chaque session
`reouvertures: [{ closedAt, closedBy, closingCountedXpf, expectedXpf, varianceXpf,
reopenedAt, reopenedBy }]`, en ordre chronologique (vide si jamais rouverte).
