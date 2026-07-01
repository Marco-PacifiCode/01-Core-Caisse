# Core Caisse — moteur de point de vente (POS) multi-tenant

Moteur de **tenue de caisse au comptoir** partagé par tous les marchands de l'écosystème
(institut Ellément, boutique, coiffeur…). Il **orchestre** les autres cores : à l'encaissement il
pousse une **facture + un paiement à Core-Compta** et **décrémente Core-Stock**. Il ne refait NI la
comptabilité (c'est Compta) NI l'inventaire (c'est Stock) — il gère les **opérations de vente /
encaissement**. Paiement **offline uniquement** en v1 (pas de Core-Paiement en ligne).

Stack identique aux autres moteurs : **Next.js 16 (App Router) · React 19 · Prisma 6 · PostgreSQL 16 ·
Auth.js v5 (beta)**. Argent en **XPF entier (BigInt)**, zéro centime. Port dev **:3106**.

---

## Modèles Prisma (`prisma/schema.prisma`)

Tous portent `tenantId` (UUID) + RLS PostgreSQL (`prisma/rls.sql`).

| Modèle | Rôle |
|---|---|
| `CashSession` | Session de caisse : `openingFloatXpf` (fond), clôture Z (`closingCountedXpf`, `expectedXpf`, `varianceXpf`), `status` OPEN/CLOSED. |
| `Sale` | Ticket : `status` DRAFT/PAID/VOID, `subtotalXpf`/`totalXpf` (figés), `sourceType`/`sourceId` (lien externe, ex. RDV), `invoiceId`/`invoiceNumber` (remplis après push Compta). |
| `SaleLine` | Ligne : `kind` SERVICE/PRODUCT/OTHER, `productId?` (cible du décrément Stock si PRODUCT), `qty`, `unitXpf`, `lineXpf`. |
| `SalePayment` | Paiement offline : `method` CASH/CARD/TRANSFER/CHEQUE/OTHER, `amountXpf`, `tenderedXpf?` (rendu monnaie), `settleRef` (idempotence Compta). **Mixte** = plusieurs lignes. |

Idempotence en base : index unique **partiel** `uniq_sale_external_source` (`tenantId, sourceType, sourceId`)
sur `Sale` → une vente sourcée n'est créée qu'une fois.

---

## Flux d'encaissement (le cœur) — `lib/caisse.ts` → `checkoutSale()`

Ouvrir un ticket → ajouter des lignes → encaisser (1..n paiements offline, rendu monnaie) → à la
validation, dans l'**ordre robuste** :

1. **(a) Facture Compta** — `POST /api/invoices`, idempotent `sourceType:"caisse"` + `sourceId:saleId`.
   `invoiceId` persisté immédiatement sur le ticket.
2. **(b) Paiement(s) Compta** — `POST /api/settle` par paiement, `paymentRef` **déterministe**
   `caisse:<saleId>:<index>` → rejouer ne double pas.
3. **(c) Stock** — `POST /api/movements` `{type:"SALE"}` pour chaque ligne PRODUCT, idempotent
   (`sourceType:"caisse"`, `sourceId:"<saleId>:<lineId>"`).
4. **(d) Ticket `PAID`** + `invoiceId`/`invoiceNumber` stockés.

**Idempotence de bout en bout / échec partiel.** Chaque étape est idempotente côté cible. En cas
d'échec après une étape réussie (ex. Stock KO après facture+settle OK), il suffit de **rejouer**
`checkoutSale(saleId, payments)` : les étapes déjà faites sont détectées (`alreadyExisted` /
`paymentRef` connu / ticket déjà PAID) et non rejouées, la suite reprend. L'échec est **loggué** et
remonté (`CORE_CALL_FAILED`, HTTP 502) — jamais de donnée dupliquée.

**Rendu monnaie** (`lib/money.ts` `computeChange`) : Σ(tendered) − Σ(amount imputé), borné à ≥ 0.

---

## Session / clôture Z — `openSession()` / `closeSession()`

Ouverture avec **fond de caisse**. Une seule session OPEN par tenant. Clôture Z : attendu =
`fond + Σ encaissements ESPÈCES` des ventes PAID de la session ; écart = `compté − attendu`.
Rapport Z : fond, espèces, attendu, compté, écart, nb de ventes, CA total, ventilation par moyen.
Idempotent (une session CLOSED renvoie son rapport figé).

---

## Reçu / ticket

Généré via l'endpoint **reçu** de Core-Compta : `GET /api/invoices/:id/receipt?tenantId=…`
(PDF ~80 mm, auth X-Core-Key). `checkoutSale` renvoie directement l'`receiptUrl` prête à imprimer.

---

## API (S2S — header `X-Core-Key: CORE_CAISSE_API_KEY`)

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/sessions` | Ouvrir une session (`openedBy`, `openingFloatXpf?`). |
| GET | `/api/sessions?tenantId=…` | Lister les sessions. |
| POST | `/api/sessions/:id/close` | Clôture Z (`closedBy`, `closingCountedXpf`). |
| POST | `/api/sales` | Créer un ticket (`lines:[{kind,label,productId?,qty,unitXpf}]`, `sourceType?/sourceId?`). |
| GET | `/api/sales?tenantId=…` | Historique des tickets. |
| POST | `/api/sales/:id/checkout` | Encaisser (`payments:[{method,amountXpf,tenderedXpf?}]`) → orchestration + `receiptUrl`. |

**Back-office** `/caisse` (session JWT PRO/ADMIN, résolue par hostname) : écran caisse (catalogue depuis
Stock, saisie libre, ticket, encaissement + rendu monnaie), ouverture/clôture de session, historique.

---

## Dépendances vers les autres cores (`lib/clients.ts`)

Clients sortants **configurables par env** (URL + clé), avec **mode simulé** (`CORE_CLIENTS_MOCK=1`) qui
simule Compta & Stock en mémoire → build/tsc/test passent **sans** les autres services up.

- **Compta** : `POST /api/invoices` → `{invoiceId, number, totalXpf, alreadyExisted}` ·
  `POST /api/settle` `{tenantId, invoiceId, amountXpf, method, paymentRef}` → `{ok, paid, remaining}` ·
  `GET /api/invoices/:id/receipt?tenantId=…` (PDF).
- **Stock** : `POST /api/movements` `{tenantId, productId, type:"SALE", qty, sourceType, sourceId, actorId?}`
  → `{ok, movementId, qtyOnHand, alreadyExisted}` (409 `INSUFFICIENT_STOCK`).

Catalogue produits lu depuis Stock (`GET /api/stock/levels`) — tolérant : saisie libre si indisponible.

---

## Multi-tenant / RLS

Tenant résolu **par hostname** via Core-Auth (`GET /api/tenant`, cf. `lib/tenant.ts`). Chaque requête
DB passe par `withTenant()` qui pose `SET LOCAL app.current_tenant` → policies RLS
(`prisma/rls.sql`, `NULLIF(current_setting(...), '')::uuid`). En prod : rôle app non-propriétaire (RLS
active), migrations/seed en rôle owner (bypass).

Tenants canoniques (identiques Auth/Compta/Stock) :
`Ellément a0000000-0000-4000-8000-000000000001` · `Boutique Démo a0000000-0000-4000-8000-000000000003`.

---

## Développement

```bash
cp .env.example .env      # ajuster les clés ; CORE_CLIENTS_MOCK=1 pour dev sans Compta/Stock
npm install
npx prisma generate
npm run db:setup          # migrate deploy + rls + seed (Postgres requis)
npm run dev               # :3106
npm test                  # tests unitaires (rendu monnaie, totaux)
```

Build/typecheck : `npx tsc --noEmit` puis `npx next build`.

---

## Déploiement (Contabo) — checklist

Voir aussi `../AGENT_BRIEF.md` et `00-Archi-NextGen/INFRA.md`. Moteur core → **déploiement manuel**
(`.github/workflows/deploy.yml`, `workflow_dispatch` ; migrations Prisma **jamais** en Action).

1. **Base** `core_caisse` sur PostgreSQL 16 (Contabo). Rôle **owner** (`core_caisse_owner`, DDL/RLS/seed)
   + rôle **app** non-propriétaire (`core_caisse_app`, RLS active). Cf. `vps/provision-core-dbs.sh` (PacifiCode).
2. **PM2** `core-caisse` sur **:3106** loopback, `TZ=Pacific/Noumea`, persisté (`dump.pm2`).
3. **nginx** : vhost par chemin, `assetPrefix` **`/_caisse`** (déjà en `next.config.ts`) — éviter la
   collision `/_next` entre moteurs. Ajouter le préfixe dans les maps nginx `pacificode.nginx.conf`.
4. **Migrations** (manuel, rôle owner) : `DATABASE_URL="$DATABASE_URL_OWNER" npx prisma migrate deploy`
   puis `npm run db:rls`, puis `npx prisma generate` sur le serveur.
5. **Secrets** (Bitwarden, **jamais** en Git) :
   - `AUTH_SECRET` — **partagé** entre tous les moteurs (décode le JWT core_auth).
   - `CORE_CAISSE_API_KEY` — clé S2S entrante de ce moteur.
   - `CORE_COMPTA_URL` + `CORE_COMPTA_API_KEY`, `CORE_STOCK_URL` + `CORE_STOCK_API_KEY` — clients sortants.
   - `CORE_AUTH_URL`, `DATABASE_URL` (app) + `DATABASE_URL_OWNER` (migrations).
   - Laisser `CORE_CLIENTS_MOCK` **vide** en prod.
6. Reload PM2 + healthcheck (`/` doit résoudre le tenant). Déploiement réversible.
