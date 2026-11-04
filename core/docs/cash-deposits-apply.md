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
Liste `applied` (≤ 1000 éléments, corps total ≤ 2 Mio) : chaque élément est soit un UUID seul
(inchangé : PENDING → APPLIED + `appliedAt`), soit `{ actionId: UUID, resultJson: objet }` : une ligne
encore PENDING passe APPLIED avec ce `resultJson`, `appliedAt`, `lastResultCode 'APPLIED'`,
`lastAttemptAt`. Une ligne déjà APPLIED n'est jamais réécrite (ni `resultJson`, ni `appliedAt`).
Objet malformé (actionId non UUID, `resultJson` absent ou non objet, clé inconnue) → 400 `INVALID_APPLIED`.
`formatVersion` autre → 400 `INVALID_FORMAT_VERSION` ; `sequence` invalide → 400 `INVALID_SEQUENCE`.

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
3. Réponse 200 : `{ token, until, items }`. `items` = dépôts `PENDING` de format 2, triés
   `(deviceId, sequence, clientCreatedAt, actionId)`, au plus `limit`, chacun :
   `actionId, kind, operation, entityKey, payload, dependsOn, clientState, clientErrorCode, sequence
   (chaîne), actorId, actorName, receivedById, attempts, lastResultCode, dependencies` où
   `dependencies[<id>] = { status, resultJson } | null` pour chaque id de `dependsOn`.

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

## Ordre conseillé côté applicateur

`claim` → pour chaque item dans l'ordre rendu : appliquer, puis `result` → `claim` à nouveau avant
expiration (≤ 60 s) pour renouveler → `release` en fin de passe. Un `LEASE_LOST` arrête la passe.

## Ouverture sur journée close (Q5, `openCashDay`)

Si aucun `CashDayOpening` n'existe pour ce `sourceKey` et que la session courante de la journée est
`CLOSED` : ni `CashDayOpening` ni fait `OPENING` ; un conflit `OUVERTURE_JOUR_CLOS` unique par
journée et par cycle (`<dayId>:<cycle>:OUVERTURE_JOUR_CLOS`). Réponse 2xx de même forme
(`dayState` + `fondRetenu` + `fondNonRetenu`). Jamais de refus.
