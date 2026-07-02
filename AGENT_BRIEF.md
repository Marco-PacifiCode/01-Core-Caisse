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
- **Vérifications vertes** : `tsc --noEmit` OK · `next build` compile · `npm test` 6/6.

## Modèles (Prisma, tenantId + RLS)

`CashSession` (fond de caisse, clôture Z : `expectedXpf`/`closingCountedXpf`/`varianceXpf`, OPEN/CLOSED) ·
`Sale` (DRAFT/PAID/VOID, totaux XPF BigInt figés, `sourceType`/`sourceId`, `invoiceId`/`invoiceNumber`) ·
`SaleLine` (kind SERVICE/PRODUCT/OTHER, `productId?`, qty, unitXpf, lineXpf) ·
`SalePayment` (method CASH/CARD/TRANSFER/CHEQUE/OTHER, amountXpf, `tenderedXpf?`, `settleRef` ; mixte).
Index unique **partiel** `uniq_sale_external_source` (RLS SQL) pour l'idempotence des ventes sourcées.

## Flux d'encaissement (cœur) — `lib/caisse.ts checkoutSale()`

Ordre robuste : (a) facture Compta `POST /api/invoices` (idempotent `caisse`+saleId, invoiceId persisté
aussitôt) → (b) `POST /api/settle` par paiement, `paymentRef` déterministe `caisse:<saleId>:<i>` → (c)
`POST /api/movements` SALE par ligne PRODUCT (idempotent `caisse`+`<saleId>:<lineId>`) → (d) ticket PAID.
**Échec partiel = rejouable en sûreté** (idempotence de bout en bout) ; loggué ; remonté `CORE_CALL_FAILED`.

## Endpoints (S2S `X-Core-Key`)

`POST/GET /api/sessions` · `POST /api/sessions/:id/close` (Z) · `POST/GET /api/sales` ·
`POST /api/sales/:id/checkout`. Back-office `/caisse` (JWT PRO/ADMIN, tenant par hostname) : écran caisse
complet (catalogue Stock, saisie libre, ticket, encaissement + rendu monnaie, session, historique).

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

- ~~Provisionner `core_caisse` + déployer~~ — **FAIT 2026-07-02 (EN PROD)**.
- Ajouter `.github/workflows/ci.yml` (tsc+eslint) sur le modèle des autres moteurs si CI souhaitée
  (Caisse n'en a pas encore ; un `[deploy]` sur `main` ne passe pas par ci.yml pour l'instant).
- Éventuel endpoint `GET /api/sessions/:id/z` en lecture seule (rapport Z sans clôturer).
- Tests d'intégration du flux checkout en mode mock (bout en bout + rejeu).
