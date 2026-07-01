# AGENT_BRIEF — 01-Core-Caisse

> Moteur mutualisé de **point de vente / tenue de caisse au comptoir**, multi-tenant. Il **orchestre**
> Core-Compta (facture + paiement) et Core-Stock (décrément) à l'encaissement. Il ne refait NI la compta
> NI l'inventaire — il gère les **opérations de vente/encaissement** (ticket, paiements offline, rendu
> monnaie, session/clôture Z). Paiement **offline only** en v1.
>
> ⚠️ **Infra/deploy = `00-Archi-NextGen/INFRA.md` fait foi, vérifier en frais.** Ce brief = contexte métier.

## État courant (2026-07-02)

- **v1 construite en local** sous `C:\dev\ecosysteme\01-Core-Caisse\` (repo git local initialisé, **jamais
  poussé**, pas de repo GitHub). Stack alignée sur Core-Compta/Core-Stock : Next.js 16.2.9 · React 19.2.4 ·
  Prisma 6.19.3 · next-auth 5 beta · PostgreSQL 16. Port dev **:3106**.
- **Vérifications vertes** : `npx tsc --noEmit` OK · `npx next build` compile (9 routes) · `npm test` 6/6
  (rendu monnaie + total ligne). Build fait avec `CORE_CLIENTS_MOCK=1` (aucun service tiers requis).
- **PAS déployé** (conformément à la consigne). Base `core_caisse` non provisionnée en prod.

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

- 2026-07-02 : création complète v1 (modèles, RLS, libs tenant/RLS/service-auth/clients/caisse/money/catalog,
  6 routes API, back-office `/caisse`, seed session, README, deploy.yml manuel). tsc+build+tests verts.

## Reste à faire / TODO

- Provisionner `core_caisse` (owner/app) + secrets (Bitwarden) puis déployer (manuel) — **non fait**.
- Ajouter `.github/workflows/ci.yml` (tsc+eslint) sur le modèle des autres moteurs si CI souhaitée.
- Éventuel endpoint `GET /api/sessions/:id/z` en lecture seule (rapport Z sans clôturer).
- Tests d'intégration du flux checkout en mode mock (bout en bout + rejeu).
