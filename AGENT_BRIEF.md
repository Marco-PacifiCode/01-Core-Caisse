# AGENT_BRIEF — 01-Core-Caisse

> Moteur mutualisé de **point de vente / tenue de caisse au comptoir**, multi-tenant. Il **orchestre**
> Core-Compta (facture + paiement) et Core-Stock (décrément) à l'encaissement. Il ne refait NI la compta
> NI l'inventaire — il gère les **opérations de vente/encaissement** (ticket, paiements offline, rendu
> monnaie, session/clôture Z). Paiement **offline only** en v1.
>
> ⚠️ **Infra/deploy = `00-Archi-NextGen/INFRA.md` fait foi, vérifier en frais.** Ce brief = contexte métier.

## État courant (2026-07-02)

- **🟢 EN PROD `2026-07-02` (v1 Ellément)** sur Contabo `vmi3228606` — PM2 `core-caisse` :3106, base
  `core_caisse` provisionnée + migrée + RLS + seed, nginx `/caisse` sous `ellement.pacificode.nc`,
  clients S2S RÉELS vers Compta (:3101) et Stock (:3105) **testés de bout en bout** (cf. Dernières
  actions). Remote `github.com/Marco-PacifiCode/01-Core-Caisse` (`main`). Les 2 anciens blocages Marco
  (repo GitHub + provisioning DB) sont **levés**.
- Stack : Next.js 16.2.9 · React 19.2.4 · Prisma 6.19.3 · next-auth 5 beta · PostgreSQL 16. Port **:3106**.
- **Vérifications vertes (2026-07-02, post-chantier fiabilité)** : `tsc --noEmit` OK · `next build`
  compile (12 routes dont `/api/health`, `/api/cron/repair-sales`, `/api/sales/[id]/repair`) ·
  `npm test` **16/16** (money 6 + clients/timeouts 4 + sync/reprise 6).
- ⚠️ **Chantier fiabilité 2026-07-02 committé en LOCAL uniquement (non poussé, non déployé)** —
  cf. Dernières actions : le déploiement exige la migration `sale_sync_state` (owner) AVANT le code,
  puis `prisma generate` serveur + `CRON_KEY`/`CRON_DATABASE_URL` dans `.env` + crontab repair.

## Modèles (Prisma, tenantId + RLS)

`CashSession` (fond de caisse, clôture Z : `expectedXpf`/`closingCountedXpf`/`varianceXpf`, OPEN/CLOSED) ·
`Sale` (DRAFT/PAID/VOID, totaux XPF BigInt figés, `sourceType`/`sourceId`, `invoiceId`/`invoiceNumber`) ·
`SaleLine` (kind SERVICE/PRODUCT/OTHER, `productId?`, qty, unitXpf, lineXpf) ·
`SalePayment` (method CASH/CARD/TRANSFER/CHEQUE/OTHER, amountXpf, `tenderedXpf?`, `settleRef` ; mixte).
Index unique **partiel** `uniq_sale_external_source` (RLS SQL) pour l'idempotence des ventes sourcées.
**Sale porte l'état de synchro** (migration additive `20260702220000_sale_sync_state`, backfill des
PAID existantes) : `comptaSyncedAt?`/`stockSyncedAt?`/`syncError?`/`syncAttempts` — « à réparer » ⇔
PAID + un des deux timestamps NULL (index partiel `idx_sale_sync_pending` dans rls.sql).

## Flux d'encaissement (cœur) — `lib/caisse.ts checkoutSale()` (remanié 2026-07-02, chantier fiabilité)

(1) paiements validés+persistés (`settleRef` déterministe `caisse:<saleId>:<i>` ; UNDERPAID refuse ICI)
→ (2) **ticket PAID immédiatement** (l'argent est pris) → (3) **synchro** `lib/sync.ts runSaleSync()` :
facture Compta (idempotent `caisse`+saleId, invoiceId persisté aussitôt) → settle par paiement →
mouvement SALE Stock par ligne PRODUCT (`<saleId>:<lineId>`). Chaque étage convergé est daté sur `Sale`
(`comptaSyncedAt`/`stockSyncedAt`). **Échec partiel post-encaissement : la vente RESTE PAID**, trace
`syncError`+`syncAttempts`, réponse `syncPending:true` (invoiceId/receiptUrl possiblement null) ;
reprise idempotente par `repairSale()` (ne rejoue QUE le manquant) via `/api/sales/:id/repair` ou le
balayage cron. **Timeouts** : tout appel S2S sortant = `AbortSignal.timeout` (`CORE_CLIENT_TIMEOUT_MS`,
défaut 8 s) ; `CoreClientError.kind` distinguable `timeout|network|http`. `CORE_CALL_FAILED` n'existe
plus (un échec S2S ne fait plus échouer le checkout).

## Endpoints (S2S `X-Core-Key`)

`POST/GET /api/sessions` · `POST /api/sessions/:id/close` (Z) · `POST/GET /api/sales` ·
`POST /api/sales/:id/checkout` · `POST /api/sales/:id/repair` (reprise ciblée) ·
`POST /api/cron/repair-sales` (**clé dédiée `X-Cron-Key: CRON_KEY`**, pattern Core-RDV ; balayage
cross-tenant via `CRON_DATABASE_URL` rôle owner en lecture id+tenantId seulement, réparations en rôle
app+RLS ; crontab `*/15` documentée dans README, **non installée**) · `GET /api/health` (**sans
secret** : `{ok,db,rlsEnabled,rlsForced,deps:{compta,stock}}`, 503 si DB/RLS KO ; deps informatives,
sondes 2 s, n'affectent pas le status). Back-office `/caisse` (JWT PRO/ADMIN, tenant par hostname) :
écran caisse complet (catalogue Stock, saisie libre, ticket, encaissement + rendu monnaie, session,
historique).

## Intégrations (contrats vérifiés en frais dans les repos, 2026-07-02)

- **Compta** : `POST /api/invoices` `{tenantId,sourceType,sourceId,clientName?,lines:[{label,qty,unitXpf}]}`
  → `{invoiceId,number,totalXpf,alreadyExisted}` · `POST /api/settle`
  - **TGC = zéro code Caisse.** Le taux TGC est un réglage **par tenant** qui vit dans **Core-Compta**
    (table `TenantTaxSetting`, self-service marchand — branche Compta `claude/tgc-tenant-setting`, non
    encore déployée). Quand la Caisse poste un ticket sans `tgcRatePpm` (cas actuel), Compta applique
    **automatiquement** le taux réglé par le marchand et fige HT/TGC datés sur la facture. Le contrat
    `/api/invoices` est inchangé (`tgcRatePpm` reste optionnel), `totalXpf` (TTC) reste la source, la
    Caisse ne lit pas HT/TGC → **rien à modifier ici**, le ticket PDF (endpoint reçu Compta) porte la
    ventilation TGC.
  `{tenantId,invoiceId,amountXpf,method,paymentRef}` → `{ok,paid,remaining}` (idempotent paymentRef) ·
  reçu `GET /api/invoices/:id/receipt?tenantId=…` (PDF 80 mm — réutilisé tel quel).
- **Stock** : `POST /api/movements` `{tenantId,productId,type:"SALE",qty,sourceType,sourceId,actorId?}`
  → `{ok,movementId,qtyOnHand,alreadyExisted}` (409 INSUFFICIENT_STOCK ; idempotent tenantId+sourceType+sourceId).
- Clients dans `lib/clients.ts`, configurables par env, **mode mock** `CORE_CLIENTS_MOCK=1`.

## Décisions Marco (implicites, à confirmer)

- Un seul `CashSession` OPEN par tenant à la fois (garde métier simple).
- Rendu monnaie calculé uniquement sur `tenderedXpf` (espèces) ; sur-paiement non-espèces non rendu.
- v1 sans remise globale (le total = somme des lignes ; une remise = ligne OTHER négative).
- Reçu = endpoint Compta (pas de PDF local) → zéro duplication du moteur de rendu.

## Dernières actions

- `2026-07-16` — 💥 **LE MOTEUR IMPUTE ET REND LA MONNAIE (plus l'appelant)** — PR **#4 OUVERTE, PAS
  MERGÉE, PAS DÉPLOYÉE** (branche `claude/core-normalize-payments`, `4c9fb4d`) : **panne GitHub**
  (« Partially Degraded Service », API authentifiée en 503) au moment du merge. **À reprendre :** attendre
  le rétablissement → vérifier la CI verte → squash-merge → déployer (`git reset --hard origin/main`,
  `npm run build`, `pm2 reload core-caisse`) → healthcheck `localhost:3106/api/health`.
  - **Décision Marco** : « encaissé puis rendu, c'est une manip générale que tout le monde va faire » →
    la règle vit **dans le moteur**, pas dans chaque surface marchande (sinon chacun la réimplémente et
    chacun se trompe pareil).
  - **Le trou** : `amountXpf` (imputé) était pris **tel quel**. Rien n'empêchait `amountXpf` > total → la
    vente était **soldée en trop en Compta** (`sync.ts` settle sur `amountXpf`) et le rendu comptabilisé
    **en recette**. **Constaté en prod V'Cut** : `FAC-2026-0002` et `0003` portaient `paidXpf: 3000` pour
    `totalXpf: 2500` (`remainingXpf: -500`). Seul **`UNDERPAID`** était gardé ; l'excédent passait en
    **silence** — pour **tous** les marchands (Ellément, Onéiti…), pas seulement V'Cut.
  - **Le correctif** : `amountXpf` devient une **DÉCLARATION, pas une consigne**. `normalizePayments`
    (`lib/money.ts`, pur) prend ce que l'appelant dit avoir **reçu** (`max(amount, tendered)`) et impute
    lui-même **`min(reçu, dû)`** ; l'excédent devient du **rendu** — mais seulement sur les méthodes qui
    le permettent : un excès en **carte/virement/chèque** est une **saisie fausse** (rien à rendre) →
    **409 `OVERPAID`**. Appelé dans `checkoutSale` **avant** la persistance des paiements.
  - **Non-régression** : un appelant correct (`{amount:2500, tendered:3000}` sur 2500) ressort
    **inchangé**. Un appelant fautif est désormais **corrigé** au lieu d'être cru.
  - **8 tests ajoutés (27/27 verts)**, dont le scénario exact du bug et la **cohérence avec
    `computeChange`** → l'écran et le reçu ne peuvent plus diverger. `tsc` vert.
  - ⚠️ *En attendant le déploiement* : **V'Cut est protégé** par son écran (surface `#85`, déployé :
    un seul champ « Espèces reçues », imputation déduite). **Les autres marchands restent exposés** au
    trou tant que ce PR n'est pas en prod.
  - 🪤 *Piège rencontré* : `tsc` local échouait sur `openedByName`/`closedByName` **inexistants** — client
    Prisma **périmé** (colonnes ajoutées par #1 en cours de session). `npx prisma generate` avant de
    conclure à une régression.

- `2026-07-16` — **Nom lisible de l'opérateur de caisse** (#1). Colonnes additives `CashSession.openedByName`
  / `closedByName` (snapshot du nom staff figé à l'ouverture/clôture — la caisse affichait l'UUID brut).
  `openSession`/`closeSession` (`lib/caisse.ts`) + routes `/api/sessions` (POST) & `/close` acceptent le nom,
  `GET /api/sessions` le renvoie. La surface V'Cut envoie `user.name` et affiche le nom (fallback UUID).
  **Migration** `20260716000000_cash_session_operator_name` (2 `ADD COLUMN TEXT`, checksum `ee3c2e8f…`)
  **APPLIQUÉE EN PROD le 2026-07-16** (Marco, en SSH via `DATABASE_URL_OWNER` = rôle `core_caisse_owner`,
  sans `sudo postgres` : `ALTER×2, GRANT, INSERT 0 1`) puis **code déployé** (build + `pm2 reload core-caisse`,
  health 200). Le nom apparaît sur les **nouvelles** sessions (les sessions passées gardent l'UUID, non
  rétro-rempli). *NB : le classifier du harnais bloque l'exécution des migrations DDL prod par l'agent → Marco
  les lance (owner url, pas de sudo requis).*
  **CI réparée** au passage : bump **Node 20 → 22** (le test `node --test --experimental-strip-types` l'exige).
- `2026-07-03` — **Chantier finition post-audit (TOP 5 pts 1+4) — commits LOCAUX sur `main`, PAS poussés.**
  - **`ci.yml`** (`.github/workflows/ci.yml`) : CI GitHub Node 20 → `npm ci` (core/) → `prisma generate`
    → `tsc --noEmit` → `npm test`. Déclencheurs `push` (main + `claude/**`) + `pull_request`. Pas de
    build next (tsc suffit pour la doctrine règle 8). Pas d'eslint (aucune config eslint dans ce core).
  - **`withTenant` homogénéisé** (`lib/tenant.ts`) : passage de `$executeRawUnsafe('SET LOCAL …')` à
    `$executeRaw\`SELECT set_config('app.current_tenant', ${'{safeTenantId}'}, true)\`` paramétré +
    export `assertTenantId` — aligné sur les 5 autres cores (réf. `01-Core-Compta/core/lib/tenant.ts`).
    Sémantique inchangée. `tsc` VERT.
  - **1er test de contrat inter-cores** (`lib/contracts.test.ts`) : verrouille le contrat CONSOMMÉ par
    la Caisse vers Compta `/api/invoices` + `/api/settle` et Stock `/api/movements` (payloads + réponses),
    en pilotant le VRAI `runSaleSync` + vrais clients HTTP contre des serveurs de capture locaux.
    Producteurs relus en frais sur origin/main (Compta+Stock) → **0 décalage détecté**, réfs de route
    notées en commentaire. `npm test` **19/19** (16 + 3 contrat).

- `2026-07-03` — **Onboarding tenant 1 commande (audit 02/07 reco n°6) — branche `claude/seed-tenant` (locale, PAS poussée, créée depuis main POST-commit FORCE RLS).**
  `scripts/seed-tenant.ts` + npm `seed:tenant` : **no-op vérifié** (sessions de caisse ouvertes à l’usage,
  ventes à l’encaissement ; rien de requis à l’onboarding) — valide le descripteur + SELECT 1, pour
  l’uniformité de l’orchestrateur `00-Archi-NextGen/vps/onboard-tenant.sh`. AUCUN deleteMany.
  `tsc` VERT · `next build` VERT.

- 2026-07-03 : **FORCE ROW LEVEL SECURITY (alignement chantier A audit 02/07) — commit LOCAL sur
  `main`, PAS poussé/déployé.**
  - `prisma/rls.sql` : ajout `ALTER TABLE … FORCE ROW LEVEL SECURITY` sur les 4 tables tenant
    (`CashSession`,`Sale`,`SaleLine`,`SalePayment`).
  - **Migration manuelle idempotente** `prisma/manual/2026-07_securite_rls.sql` (FORCE + policies ;
    à jouer en prod par owner/postgres AVANT le code ; rollback = `NO FORCE`).
  - ⚠️ **PIÈGE CRON documenté** (en-tête de la migration + `.env.example` + `lib/repair-sweep.ts`) :
    le balayage `CRON_DATABASE_URL` lit `Sale` cross-tenant — son rôle doit avoir **BYPASSRLS AVANT
    d'appliquer FORCE**, sinon il voit 0 vente en silence (même piège que le cron RDV).
  - `/api/health` : **`rlsForced` compte désormais dans le `ok`** (`ok=db&&rlsEnabled&&rlsForced`) →
    déployer le code APRÈS la migration, sinon 503.
  - Seeds post-FORCE : rôle **BYPASSRLS** requis (`.env.example` mis à jour).
  - Vérifs : `tsc --noEmit` VERT · `next build` VERT.
- 2026-07-02 (soir) : **CHANTIER FIABILITÉ CHECKOUT (audit 02/07 §3, prio n°3+5) — code complet,
  commits LOCAUX sur `main`, PAS poussé/déployé.**
  - **Timeouts S2S** (`lib/clients.ts`) : `AbortSignal.timeout` sur tous les appels sortants
    (`CORE_CLIENT_TIMEOUT_MS`, défaut 8 s) ; `CoreClientError.kind` = `timeout|network|http` (status 0
    pour timeout/network). Classe désucrée (plus de parameter properties) → chargeable par
    `node --experimental-strip-types`.
  - **État de synchro persistant sur `Sale`** : `comptaSyncedAt`/`stockSyncedAt`/`syncError`/
    `syncAttempts` (migration additive+réversible `20260702220000_sale_sync_state`, backfill des PAID
    pré-existantes — l'ancien flux ne marquait PAID qu'après synchro complète). Index partiel de
    balayage `idx_sale_sync_pending` ajouté à `prisma/rls.sql`.
  - **Checkout remanié** (`lib/caisse.ts`) : PAID dès paiement validé → synchro via **moteur pur
    injecté** `lib/sync.ts runSaleSync()` (testable sans DB/HTTP) ; échec S2S → vente PAID +
    `syncPending:true` + trace, plus jamais de 502 post-encaissement. Rejouer checkout sur une vente
    PAID non convergée RETENTE la synchro.
  - **Reprise** : `repairSale()` idempotente (ne rejoue que les étapes manquantes) ; endpoints
    `POST /api/sales/:id/repair` (X-Core-Key) + `POST /api/cron/repair-sales` (X-Cron-Key=`CRON_KEY`,
    pattern Core-RDV ; listing cross-tenant via client Prisma dédié `CRON_DATABASE_URL` rôle owner,
    réparations en rôle app+RLS ; 200 ventes/passage, rapport `{scanned,repaired,stillPending,failures}`).
    Crontab `*/15` documentée (README + route), **PAS installée** (infra Contabo).
  - **`GET /api/health`** (sans secret) : `{ok,db,rlsEnabled,rlsForced,deps:{compta,stock}}` ;
    `ok=db&&rlsEnabled` (design local = ENABLE + rôle app non-owner → `rlsForced` informatif) ;
    deps = sondes 2 s informatives (une panne Compta ne rend pas la Caisse « down »). 503 si KO.
  - **Validation UUID** de `tenantId` dans `withTenant` avant interpolation `SET LOCAL` (idem Stock).
  - **UI** : `receiptUrl` nullable + bandeau « synchro différée (reprise automatique) » si syncPending.
  - **Tests 16/16** : suite sync (échec partiel → trace → repair ne rejoue QUE le manquant → converge ;
    timeout compta ; settle échoué → facture réutilisée ; vente 100 % service ; no-op si convergée) +
    suite clients (serveur HTTP local muet → kind=timeout ; port fermé → network ; 409 → http+corps).
  - **POUR DÉPLOYER (futur, action délibérée)** : appliquer la migration en rôle owner AVANT le code
    (`prisma migrate deploy` avec `CORE_CAISSE_OWNER_URL`), rejouer `db:rls` (nouvel index), `prisma
    generate` sur le serveur, ajouter `CRON_KEY` (+ `CRON_DATABASE_URL`=owner) au `.env`, installer la
    crontab repair, brancher les crons de surveillance sur `/api/health` (Caisse ET Stock).

- 2026-07-02 : **GO-LIVE PROD Core-Caisse (v1 Ellément) — EN LIGNE ✅**. Serveur Contabo
  `vmi3228606` (46.250.245.33), `/home/deploy/moteurs/01-Core-Caisse/core`. Remote
  `github.com/Marco-PacifiCode/01-Core-Caisse` (`main`). Pushé, cloné, déployé.
  - **DB** : migration `20260702151449_init` (générée via `prisma migrate diff`, appliquée en rôle
    **owner** `CORE_CAISSE_OWNER_URL` par `migrate deploy` — l'owner n'a pas CREATEDB, pattern identique
    à Stock/Compta), puis `db:rls` (policies `tenant_isolation` sur `CashSession`/`Sale`/`SaleLine`/
    `SalePayment` + index unique partiel `uniq_sale_external_source`), `db:seed` (sessions OPEN Ellément
    + Boutique), `prisma generate` **sur le serveur**. RLS vérifiée (rôle app voit 0 ligne sans tenant).
    Migration committée + poussée (survie au `git reset --hard` du deploy.yml).
  - **.env serveur** (`core/.env`, 600) : `AUTH_SECRET` partagé (== autres moteurs) ; `DATABASE_URL`=app,
    `DATABASE_URL_OWNER`=owner ; `CORE_CAISSE_API_KEY` (entrante, `openssl rand -base64 32`, présente
    **uniquement** dans ce .env) ; clients **S2S SORTANTS RÉELS** (`CORE_CLIENTS_MOCK=""`) :
    `CORE_COMPTA_URL=http://localhost:3101` + `CORE_COMPTA_API_KEY` (== clé entrante `COMPTA_API_KEY` de
    core_compta) et `CORE_STOCK_URL=http://localhost:3105` + `CORE_STOCK_API_KEY` (== clé entrante de
    core_stock). Header S2S = `X-Core-Key`.
  - **Runtime** : `next build` vert, **PM2 `core-caisse` :3106** (`pm2 save`). Healthchecks EN FRAIS :
    local `GET /`→**200**, `/caisse`→307 (login JWT), API sans clé→**401** ; via **nginx**
    `Host: ellement.pacificode.nc` `/caisse`→**307**, `/_caisse/_next/`→308.
  - **Nginx** : `/caisse` + `/_caisse/_next/` → :3106 (vhost `pacificode`, repo `Marco-PacifiCode/
    PacifiCode` commit `de52cdc`).
  - **✅ TEST S2S BOUT-EN-BOUT EN FRAIS** : `POST /api/sales` puis `POST /api/sales/:id/checkout`
    (tenant démo Ellément, 1× produit Stock, CASH 3000 tendered 5000) → **HTTP 200**, `status=PAID`,
    facture Compta **FAC-2026-0002** créée (invoiceId `443fb98c…`, reçu PDF), `stockDecremented=1`
    (qtyOnHand Stock 2→1, mouvement `SALE src=caisse:<saleId>:<lineId>`), `changeXpf=2000`.
    → Caisse joint **réellement** Compta ET Stock en prod, orchestration idempotente prouvée.
  - **ROLLBACK (réversible)** : `pm2 delete core-caisse && pm2 save` ; retirer les 2 locations
    `/caisse` du vhost (revert `de52cdc` PacifiCode + redeploy) ; `rm -rf /home/deploy/moteurs/01-Core-Caisse`.
    DB (**destructif → validation Marco**) : `DROP` tables/DATABASE `core_caisse` + rôles.
    (La vente de test est du tenant démo, additive.)

- 2026-07-02 : **note TGC** (brief seul, aucun code touché). Le taux TGC par tenant est géré côté
  **Core-Compta** (`TenantTaxSetting`, self-service) et appliqué automatiquement à l'émission de la
  facture. La Caisse n'a **rien à changer** : elle poste déjà `/api/invoices` sans `tgcRatePpm`. Détail
  § Intégrations. Baseline vérifiée en frais : `next typegen` + `tsc --noEmit` **VERTS** (mode mock).
- 2026-07-02 : création complète v1 (modèles, RLS, libs tenant/RLS/service-auth/clients/caisse/money/catalog,
  6 routes API, back-office `/caisse`, seed session, README, deploy.yml manuel). tsc+build+tests verts.

## Reste à faire / TODO

- **Déployer le chantier fiabilité** (commits locaux `main`, non poussés) — checklist dans
  « Dernières actions » ci-dessus (migration owner AVANT code, `CRON_KEY`, crontab, crons → /api/health).
- Ajouter `.github/workflows/ci.yml` (tsc+eslint) sur le modèle des autres moteurs si CI souhaitée
  (Caisse n'en a pas encore ; un `[deploy]` sur `main` ne passe pas par ci.yml pour l'instant).
- Éventuel endpoint `GET /api/sessions/:id/z` en lecture seule (rapport Z sans clôturer).
