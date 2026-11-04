# Core-Caisse — application des dépôts par le serveur (contrat S2S)

Décision Marco 04/11 : le serveur applique lui-même la file des tablettes. Le Core garde l'état
d'application et un **bail par commerce** ; l'applicateur tourne dans la surface (lot suivant).

Toutes les routes : `POST`, garde S2S identique à `/api/cash-deposits` (en-tête `X-Core-Key`,
portée de la clé vérifiée sur `tenantId`), corps JSON ≤ 2 Mio, transaction posée sur le commerce
(RLS `app.current_tenant`) et verrou `pg_advisory_xact_lock` du commerce (le même que le dépôt).
Erreurs : `{ ok: false, error: "<CODE>", data? }`. 401 clé absente/invalide, 400 corps invalide.

## Dépôt (`POST /api/cash-deposits`) — enveloppe de format 2

Par action, en plus des champs existants : `formatVersion: 2`, `sequence` (entier ≥ 0, nombre ou
chaîne de chiffres), `actorId`, `actorName` (≤ 200), `receivedById` (≤ 200). Ces champs sont
**hors du payload et de `payloadHash`** : même payload + autre auteur → `seen`, jamais `conflict`.
Sur un `seen`, un champ d'auteur déjà renseigné n'est jamais remplacé (complété seulement s'il est
null). `formatVersion` absent ou `1` : comportement strictement inchangé (aucun de ces champs lu).
Liste `applied` (≤ 1000 éléments, corps total ≤ 2 Mio) : chaque élément est soit un UUID seul, soit
`{ actionId: UUID, resultJson: objet }`. Effet selon le format de la ligne : voir « Qui peut dire APPLIED ».
Une ligne déjà APPLIED n'est jamais réécrite (ni `resultJson`, ni `appliedAt`).
`deviceId` facultatif au niveau du lot : `/^[a-zA-Z0-9-]{1,80}$/`, sinon 400 `INVALID_DEVICE_ID`.
Objet malformé (actionId non UUID, `resultJson` absent ou non objet, clé inconnue) → 400 `INVALID_APPLIED`.
`formatVersion` autre → 400 `INVALID_FORMAT_VERSION` ; `sequence` invalide → 400 `INVALID_SEQUENCE`.

Réponse : `{ results, applied, appliedIgnores }`. Chaque élément de `results` (`stored`, `seen`, `conflict`) garde
`{ actionId, result }` et ajoute (champs ajoutés seulement, l'ancienne tablette les ignore) :
`status` (`'PENDING' | 'APPLIED'`) de la ligne en base **après** l'opération (accusés `applied` du
même appel compris), et `resultJson` seulement si `status = 'APPLIED'` et `resultJson` non null
(UUID seul accusé → `APPLIED` sans `resultJson`). Sur `conflict`, c'est le statut de la ligne existante.
Lecture groupée unique (`findMany` sur les actionId du lot), filtrée par `tenantId` sous RLS.
Une action `APPLIED` est accusée par la tablette sans être renvoyée.

### Qui peut dire APPLIED

Règle : **seul le serveur produit un `resultJson` de format 2.** Une affirmation de la tablette n'en
produit jamais.

- **Format 1** : comportement historique inchangé, sans contrôle d'appareil. UUID seul → PENDING →
  APPLIED + `appliedAt`. Objet → APPLIED avec ce `resultJson`, `appliedAt`, `lastResultCode 'APPLIED'`,
  `lastAttemptAt`.
- **Format 2, 1) garde de l'appareil, contrôlée AVANT C1** : l'appareil qui accuse doit être celui
  de la ligne. On prend le `deviceId` du lot. S'il est absent et que toutes les actions du lot portent
  le même `deviceId`, on prend celui-là. Sinon l'appareil est inconnu. Quel que soit `lastResultCode`
  (null, `'EN_ATTENTE'` ou marque de renoncement) :
  - Appareil inconnu → ignoré, `appliedIgnores` reçoit `{ actionId, code: 'APPAREIL_INCONNU' }`.
  - Appareil différent → ignoré, `appliedIgnores` reçoit `{ actionId, code: 'AUTRE_APPAREIL' }`.
  - Une ligne ignorée ne change pas (pas de `conflictCount`). Le Core n'écrit aucun conflit : c'est la
    surface qui transforme `AUTRE_APPAREIL` en conflit.
- **Format 2, 2) même appareil, règle C1** : l'`applied` (UUID ou objet) n'est honoré que si le serveur
  a renoncé à l'appliquer, c'est-à-dire si `lastResultCode` n'est ni null ni `'EN_ATTENTE'`. La ligne
  passe alors APPLIED **sans `resultJson`** (le `resultJson` fourni est ignoré), avec `appliedAt`,
  `lastAttemptAt` et `lastResultCode 'APPLIED_PAR_TABLETTE'`. Sinon l'`applied` est ignoré sans
  signalement : la ligne reste PENDING et le serveur l'appliquera.
- `appliedIgnores` vaut toujours un tableau (vide le plus souvent). Seules les lignes de format 2
  encore PENDING sont contrôlées : un `applied` sur une ligne déjà APPLIED, inconnue ou d'un autre
  commerce n'y figure pas.

### Remise à zéro de la marque

Un redépôt `seen` (même `payloadHash`) dont `clientState` change remet `lastResultCode` et
`lastResultReason` à null : la pièce redevient éligible au claim. Cela ne vaut que pour une ligne
PENDING, jamais pour une ligne APPLIED.

## Bail

Une ligne `CashDepositLease` par commerce : `holder`, `token`, `until`. Durée : 60 s, renouvelée à
chaque `claim` du même holder (même token). Un bail dont `until` est passé est repris par n'importe
quel holder (nouveau token). Libérer = expirer (`until = maintenant`), aucune suppression.

## `POST /api/cash-deposits/claim`

Corps : `{ tenantId, holder (texte 1..100), limit (1..100, défaut 50) }`.

1. Bail : pris s'il est absent ou expiré, renouvelé si même holder, sinon **409 `LEASE_HELD`**
   (`data.until`).
2. Les dépôts `PENDING` de format 1 dont `lastResultCode` est null reçoivent
   `lastResultCode = 'REJEU_TABLETTE'` (aucun autre champ, statut inchangé) : la tablette les rejoue.
3. Réponse 200 : `{ token, until, items }`. `items` = dépôts `PENDING` de format 2 dont
   `lastResultCode` est null ou `'EN_ATTENTE'` (filtre posé dans la requête : les pièces déjà
   écartées par l'applicateur, par exemple REJEU_TABLETTE, NON_APPLICABLE_*, CONSTRUCTION_REFUSEE ou
   un code métier, ne bouchent plus la fenêtre), triés
   `(deviceId, sequence, clientCreatedAt, actionId)`, au plus `limit`, chacun :
   `actionId, kind, operation, entityKey, payload, dependsOn, clientState, clientErrorCode, sequence
   (chaîne), actorId, actorName, receivedById, attempts, lastResultCode, conflictCount, dependencies` où
   `dependencies[<id>] = { status, resultJson } | null` pour chaque id de `dependsOn`. Les
   dépendances sont lues quel que soit leur `lastResultCode`.
   `conflictCount` > 0 signifie que la tablette a redéposé cette pièce avec un autre payload. Le Core
   garde le premier, qui peut être périmé (vente annulée sur place, par exemple) : l'applicateur doit
   en tenir compte.

Erreurs 400 : `INVALID_HOLDER`, `INVALID_LIMIT`, `INVALID_PAYLOAD` (tenantId).

## `POST /api/cash-deposits/result`

Corps : `{ tenantId, token, actionId, outcome: "APPLIED" | "REFUSED" | "WAITING", resultJson?, code?, reason? }`.

- Bail en cours exigé (même token, `until > maintenant`), sinon **409 `LEASE_LOST`**.
- Dépôt inconnu → 404 `NOT_FOUND` ; dépôt de format 1 → 409 `FORMAT_NOT_APPLICABLE`.
- `APPLIED` : `resultJson` objet obligatoire (400 `INVALID_RESULT_JSON`) → `status APPLIED`,
  `appliedAt`, `resultJson`, `attempts + 1`, `lastAttemptAt`, `lastResultCode 'APPLIED'`.
- `REFUSED` / `WAITING` : `code` obligatoire ≤ 100 (400 `INVALID_CODE`), `reason` ≤ 300
  (400 `INVALID_REASON`) → statut reste `PENDING`, `lastResultCode = code`, `lastResultReason`,
  `attempts + 1`, `lastAttemptAt`.
- Dépôt déjà `APPLIED` : immuable. Même `APPLIED` + même `resultJson` (comparaison canonique) →
  200 `{ idempotent: true }` ; tout autre envoi → **409 `ALREADY_APPLIED`**.

Réponse 200 : `{ actionId, status: "APPLIED" | "PENDING", idempotent }`.

## `POST /api/cash-deposits/release`

Corps : `{ tenantId, token }`. Expire le bail si le token correspond et qu'il est en cours.
Réponse 200 : `{ released: true | false }`.

## État des dépôts (`POST /api/cash-deposits/status`)

Route légère pour que la tablette apprenne qu'une pièce déjà déposée est devenue `APPLIED` sans
redéposer la pièce complète.

- Corps : `{ tenantId: uuid, actionIds: uuid[] }`, de 1 à 1000 éléments ; doublons retirés, casse
  normalisée. Liste vide, > 1000, ou id non UUID → 400 `INVALID_ACTION_IDS` ; `tenantId` invalide → 400.
- Réponse 200 : `{ items: [{ actionId, status, resultJson? }] }`. `resultJson` seulement si
  `status = "APPLIED"` et `resultJson` non null (même projection que la réponse du dépôt).
  Un `actionId` inconnu, ou d'un autre commerce, est **absent** de `items` (l'ordre n'est pas garanti).
- Garde : même garde S2S que les autres routes `/api/cash-deposits` (`cashHttp` → `hasServiceKey`,
  `X-Core-Key`, 401 sinon), lecture sous `withTenant(tenantId)` (RLS).
- Une seule requête (`findMany` filtrée sur `tenantId` et `actionId in (…)`), `select` limité à
  `actionId`, `status`, `resultJson`. **Aucune écriture.** Jamais de `payload`, `payloadHash`,
  enveloppe ni auteur.

## Ordre conseillé côté applicateur

`claim` → pour chaque item dans l'ordre rendu : appliquer, puis `result` → `claim` à nouveau avant
expiration (≤ 60 s) pour renouveler → `release` en fin de passe. Un `LEASE_LOST` arrête la passe.

## Ouverture sur journée close (Q5, `openCashDay`)

Si aucun `CashDayOpening` n'existe pour ce `sourceKey` et que la session courante de la journée est
`CLOSED` : ni `CashDayOpening` ni fait `OPENING` ; un conflit `OUVERTURE_JOUR_CLOS` unique par
journée et par cycle (`<dayId>:<cycle>:OUVERTURE_JOUR_CLOS`). Réponse 2xx de même forme
(`dayState` + `fondRetenu` + `fondNonRetenu`). Jamais de refus.
