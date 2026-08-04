# AGENT_BRIEF — 01-Core-Caisse

## ⚖️ REVUE TRANSVERSE « volet argent » — 2026-08-04 06:55Z (`t-20260804T0630-brcorecaisse`)

Revue des 3 branches du chantier avoir (`PC-0016`), code lu et **tests exécutés** localement.
Verdict pour ce dépôt : **PR #11 — MERGEABLE, MAIS BLOQUÉE PAR UNE DÉCISION** (celle de §A2, qui
n'a **aucune réponse** de Marco ; ce dépôt ne bloque rien par lui-même).

**Mesuré ici :** `origin/claude/sale-read-route` = `e6eaf1669756b6568b4806831b6c7236a8fc6043`.
`main` (`3e722b11`) **n'a pas bougé** depuis : la branche est exactement à jour, zéro dérive.
Sur la fusion locale : **35/35 tests verts**, `tsc --noEmit` **exit 0**, zéro migration.
Route en lecture pure, sous RLS (`withTenant`), `X-Core-Key`, `xpf()` sur tous les `BigInt`.

**⚠️ La branche n'ajoute AUCUN test.** Les 35 verts sont **exactement** les 35 de `main` (mesuré :
`git diff --name-only main...branche | grep -c test` → **0**). `app/api/sales/[id]/route.ts` — le
chaînon dont dépend toute la reprise de stock de l'avoir — est livré **sans une seule assertion**.
Ce n'est pas rédhibitoire (66 lignes, lecture seule, aucun effet de bord) mais « 35/35 » ne dit rien
de cette route : il faut le lire comme « rien n'a été cassé », pas comme « c'est couvert ».

**Vérifié bon, contre un doute légitime :** `SaleLine.qty` est un `Int` (`prisma/schema.prisma:123`),
pas un `Decimal` — le `qty` renvoyé brut par cette route est donc un vrai nombre JSON, et
`Core-Stock recordMovement` (`Math.trunc`) le reçoit sans surprise. Pas de bug de sérialisation.

**Écart (a) — CONFIRMÉ DANS LE CODE, et c'est le point dur du chantier.** Le Z se calcule
exclusivement sur les `Sale` `PAID` de la session et leurs `SalePayment`
(`lib/caisse.ts:88-105`). La chaîne d'avoir n'écrit **rien** ici : `Core-Compta createCreditNote`
ne touche que `Invoice`/`InvoiceLine`, et `V-Cut creditInvoice` n'appelle que Compta puis Stock —
**aucun appel en écriture vers ce moteur**. Donc : aucun `SalePayment`, aucun `Sale`, et
`closeSession` est idempotent (une session `CLOSED` **renvoie son `varianceXpf` figé**, il n'est
jamais recalculé). Le réglage « écart imputé sur la session du jour » de §A2 **n'est honoré nulle
part** — ce n'est pas un oubli d'écriture, c'est structurel à l'option A.
👉 **Conséquence concrète à porter à Marco** : si le salon rend l'argent en **espèces** au comptoir,
le tiroir sera court d'autant au Z du jour, et l'app n'aura **aucune ligne pour l'expliquer** —
l'écart apparaîtra comme une erreur de caisse anonyme. Honorer ce réglage exige une écriture ici,
c'est-à-dire **l'option B**, qui n'est pas ce qui est écrit.

**Ordre de livraison, corrigé sur pièce :** `core-auth` est déployé (`20260804-140514`) et
Core-Compta **PR #20 est sur `main` et déployée** (`20260804-140657`) — les deux premières étapes
sont FAITES. Reste : **Core-Compta #21 → #11 (ici) → V-Cut #201**.

## 🔎 `GET /api/sales/:id` — la lecture qui manquait, **NON déployée** (2026-08-04, `PC-0016`)

> **PR #11** — https://github.com/Marco-PacifiCode/01-Core-Caisse/pull/11 · branche
> `claude/sale-read-route` · **35/35 tests**, `tsc --noEmit` 0 erreur · **ZÉRO migration**,
> lecture seule, aucun effet de bord.

**Ce moteur n'exposait AUCUNE lecture de vente** : uniquement `POST /api/sales`,
`POST /api/sales/:id/checkout` et `POST /api/sales/:id/repair`. On pouvait créer et encaisser un
ticket, jamais le relire.

Ça bloquait un geste concret : la **facture d'avoir** (Core-Compta PR #21) doit ré-incrémenter le
stock des produits vendus, or **la facture Compta ne porte pas les `productId`** — ses lignes n'ont
que `label`, `qty`, `unitXpf`. Seule la vente d'ici les connaît (`SaleLine.productId`). Sans cette
route, la reprise du stock était structurellement hors d'atteinte. C'était le seul chaînon manquant.

- Lecture **sous RLS** (`withTenant`), comme tout le moteur.
- Tous les `BigInt` passent par `xpf()` — un `BigInt` brut lève à la sérialisation `NextResponse.json`.
- Renvoie l'entête, `lines[]` (avec `kind`, `productId`, `qty`) et `payments[]`.
- 401 sans clé · 400 sans `tenantId` · 404 `{"error":"Vente introuvable"}`.

### Un écart de contrat signalé, pas comblé en douce
La spec initiale exposait `payments[].ref`. **Ce champ n'existe pas** : `SalePayment` porte
`settleRef` (référence d'idempotence vers Compta), pas `ref`. Il a été **omis** plutôt que renommé —
exposer un champ interne de synchro dans un contrat public est un choix, pas une correction de frappe.
À trancher si le besoin apparaît.

### Ce que ça implique pour ce moteur, et qui est décidé ailleurs
Décision `PC-0045` : **c'est la Caisse qui facture**, et elle seule. Le pont RDV→Compta est désarmé
(Core-RDV PR #41). Rien ne change ici — mais ce moteur devient **le seul** chemin automatique vers la
facturation, ce qui augmente d'autant le coût d'une panne de `runSaleSync`.

### ⚠️ Ce moteur ne sait toujours pas annuler un encaissement
`voidSale` refuse un ticket `PAID` et **n'a aucun appelant**. `SaleStatus` reste `DRAFT | PAID | VOID`,
sans état de remboursement. L'avoir retenu est **comptable** (Core-Compta), pas caissier : il ne crée
aucun `SalePayment`, donc **le Z de caisse n'en portera aucune trace**, ni la session du jour ni celle
d'origine (close, `varianceXpf` figé). Le réglage « écart imputé sur la session du jour » **n'est pas
honoré** et exigerait une écriture ici — c'était l'option B. Reste à trancher.


## ✅ La famine de la file de reprise est **CORRIGÉE ET EN PROD** (2026-08-04, ticket `PC-0049`)

La branche `claude/repair-sweep-anti-famine` est mergée et livrée : **PR #10, release
`20260804-104132`**. Tri + backoff, **zéro migration** (`syncAttempts` existait depuis juillet et
n'était lu par personne).

**Le dommage certain n'était pas la famine** (qui exige ~200 insolubles) mais le **retry non
borné : 96 allers-retours par jour et par vente, à vie**.

## 🔎 La crontab `*/15` : le brief avait TORT (2026-08-04, vérifié sur le VPS)

Ce brief la donnait « documentée, **non installée** ». Elle **est installée et tourne** :
`*/15 * * * * /home/deploy/core-caisse-repair.sh`, log de 240 Ko, **3 080 passages**.

⚠️ **Mais un doute reste, et il est important.** Les 3 080 passages rendent **tous** `scanned=0`.
Deux lectures opposées : soit il n'y a réellement aucune vente en attente, soit le rôle du cron
(`core_caisse_owner`, via `CRON_DATABASE_URL`) **n'est pas `BYPASSRLS`** et `FORCE ROW LEVEL
SECURITY` lui renvoie **0 ligne en silence** — auquel cas le rattrapage n'a jamais rien vu. La
vérification (`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`) est un geste de
Marco : `00-Archi-NextGen/DECISIONS-2026-08-04.md`, geste **B8**.

La décision comptable (que devient une vente qu'on renonce à synchroniser) reste ouverte —
entrée **A5** de la même fiche. **Reco : A** (rien ne se perd, zéro migration), sous réserve de B8.

> 🚀 **Déploiement (2026-07-19) : pipeline unifié UNIQUEMENT** — `bash 00-Archi-NextGen/_routine/deploy/ng-deploy.sh core-caisse deploy [branche]` (build hors-VPS, cutover auto, healthcheck, rollback). L'ancien `deploy.yml`/`[deploy]` est **SUPPRIMÉ**. Les mentions de `git reset`+`pm2 reload` dans l'historique ci-dessous décrivent le passé, pas la méthode. Détail : `00-Archi-NextGen/_routine/deploy/README.md`.

## 🍽️ FAMINE de la file de reprise — **PROUVÉE**, correctif poussé NON MERGÉ (2026-08-03, `t-20260803T2030-caissesweep`)

> **Branche `claude/repair-sweep-anti-famine`** (sha `7d599a2`) ·
> compare : `https://github.com/Marco-PacifiCode/01-Core-Caisse/compare/main...claude/repair-sweep-anti-famine`
> **PR NON OUVERTE** : l'API GitHub répond **403** depuis le sandbox (écriture *et* lecture).
> **ZÉRO migration Prisma.** Le correctif tient sur des colonnes existantes.

### Le verdict : famine RÉELLE, établie par exécution (pas par lecture)
`lib/repair-sweep.ts` sélectionnait les ventes PAID non convergées, tri **`paidAt asc`**, fenêtre 200,
**sans jamais lire `syncAttempts`** — colonne pourtant écrite par `recordFailure` depuis 2026-07 :
**écrite, jamais lue** (`grep` exhaustif : aucun lecteur dans tout le repo). Une vente insoluble ne
quittait donc jamais la sélection, et comme elle est ancienne, le tri la ramenait **en tête de file**.

**Rien ne la désamorçait** — cherché activement et exclu : pas de plafond ailleurs, pas d'`updatedAt`
dans le tri, pas de purge/TTL/`deleteMany` (hors seed), aucun statut qui bascule (`VOID` n'est
accessible que depuis `DRAFT`). Seule sortie de la file : converger.

**Reproduit** sur base PostgreSQL **jetable** (migrations du repo, rôle app non-propriétaire, FORCE
RLS vérifié `relforcerowsecurity=t`, rôle cron BYPASSRLS, vrais `checkoutSale`/`sweepPendingSales`,
vrais serveurs HTTP Compta/Stock) — 200 ventes insolubles anciennes + 5 saines récentes, 5 passages :

| | passage 1 | passages 2-5 | ventes saines |
|---|---|---|---|
| **AVANT** | `scanned=200 repaired=0` | idem, à l'identique | **jamais atteintes** (1000 appels Stock pour rien) |
| **APRÈS** | `scanned=200 repaired=5` | reprise espacée, appels Stock 200 → 0 | **convergées au 1ᵉʳ passage** |

⚠️ **Honnêteté sur la portée** : la famine est un effet de **saturation**, elle exige ≥ 200 ventes
insolubles. En-dessous, les saines passent quand même (mesuré : 3 insolubles + 2 saines → `repaired=2`).
Le dommage **présent et certain**, lui, est le **retry non borné** : chaque vente insoluble coûtait 96
allers-retours Compta/Stock par jour, **à vie**.

### La chaîne causale — le point aveugle qui rend l'empoisonnement atteignable
Core-Stock **refuse déjà** de supprimer un produit vendu (`PRODUCT_HAS_SALES`)… mais ce garde-fou
compte les **mouvements SALE**. Une vente Caisse dont le décrément a échoué n'a **aucun mouvement** →
le garde-fou **ne la voit pas**. Vérifié en exécutant le vrai `deleteProduct` de Core-Stock contre une
base Stock jetable :

```
produit AVEC mouvement SALE → {"ok":false,"error":"PRODUCT_HAS_SALES","saleCount":1}   ← protégé
produit SANS mouvement SALE → {"ok":true,...}        puis reprise → PRODUCT_NOT_FOUND  ← empoisonné
```

C'est **exactement** l'état d'une vente en attente de synchro : le point aveugle du garde-fou Stock
est précisément la population que la Caisse doit réparer. **À remonter à Core-Stock** (distinct de la
course déjà traitée par `claude/delete-produit-preuve-cascade`, qui concerne les ventes *déjà* `ok:true`).

### Ce que le correctif oppose (et ce qu'il refuse de décider)
1. **Tri `syncAttempts asc, paidAt asc`** — une vente qui échoue en boucle recule derrière toute vente
   fraîche. La famine devient **structurellement impossible**, sans renoncer à personne.
2. **Backoff** au-delà de `REPAIR_BACKOFF_AFTER_ATTEMPTS` (défaut 10) : reprise seulement si la
   dernière tentative (`updatedAt`, poussé par `recordFailure` — vérifié en base) date de plus de
   `REPAIR_BACKOFF_MINUTES` (défaut 360). **`=0` = interrupteur d'arrêt**, réglable sans redéployer.
3. **Visibilité** : compteur `stuck` dans le rapport + `log.error("caisse.repairStuck")` → watchdog.
   Sans lui, on remplacerait une famine bruyante par un **enlisement silencieux**.

**Aucune vente n'est jamais abandonnée, aucun statut d'abandon n'est posé, aucune colonne ajoutée.**
La règle vit dans **`lib/repair-policy.ts`**, pure et testable sans base (patron `lib/sync.ts` :
*import type* uniquement).

### ⚖️ CE QUI RESTE À TRANCHER PAR MARCO — décision COMPTABLE, pas technique
Une vente encaissée dont le stock ne bougera **jamais** est un **écart d'inventaire permanent**.
- **Option A (état livré, zéro migration)** — la vente reste « en attente » à vie, retentée toutes les
  6 h, comptée dans `stuck`, signalée. Rien n'est effacé, rien n'est décidé. *Coût : la file ne se vide
  jamais et mélange retard transitoire et insoluble.*
- **Option B (mise de côté explicite)** — colonnes `syncGivenUpAt/By/Reason` : qui a renoncé, quand,
  pourquoi. L'écart devient **déclaré et dénombrable**. *Coût : **exige une migration Prisma** (STOP
  Marco) ; l'inventaire Stock restera supérieur au réel → rattrapage par un mouvement `ADJUST`/`LOSS`
  saisi par le marchand, **jamais** une écriture automatique de la Caisse.*
- 📄 DDL candidat **INERTE** : `core/prisma/candidates/2026-08-03_sale_sync_giveup.CANDIDAT.sql` —
  délibérément **hors** de `prisma/migrations/` (vérifié : `migrate deploy` voit 3 migrations et ne
  crée aucune colonne). Il ne devient une migration que si Marco tranche B.

### Compter les ventes concernées en prod (lecture seule — geste de Marco)
```sql
SELECT count(*) FILTER (WHERE "syncAttempts" >= 10) AS enlisees,
       count(*) FILTER (WHERE "syncError" LIKE '%PRODUCT_NOT_FOUND%') AS produit_disparu,
       count(*) AS total_en_attente, max("syncAttempts") AS pire
FROM "Sale"
WHERE status = 'PAID' AND ("comptaSyncedAt" IS NULL OR "stockSyncedAt" IS NULL);
```
⚠️ À lancer avec un rôle **BYPASSRLS** (sinon FORCE RLS renvoie 0 ligne **en silence**).

### ⚠️ Deux points NON VÉRIFIABLES depuis le sandbox — à confirmer par Marco
- **La crontab `*/15` de `/api/cron/repair-sales` est-elle installée ?** Le brief la dit *documentée,
  non installée* (2026-07-02). **Si elle ne tourne pas, aucune vente n'est jamais réparée** — un
  problème plus grave que la famine. À vérifier avant tout le reste.
- **La CI de la branche** : illisible (403 API). `tsc`, `npm test` **35/35** et `next build` sont verts
  **en local**.

---

## 🩺 Anomalie de logs `E57P01` — RIEN À CORRIGER ICI (2026-08-01, tâche `t-20260730T1930-9pmstx`)

Signature escaladée : `[core-caisse] prisma:error Error in PostgreSQL connection … SqlState(E57P01)
"terminating connection due to administrator command"` — `error/pm2_stdout` ×6, LogEvent
`cms3mgvfs0002uxklup4xcpk9`. **Verdict : bénigne côté moteur, aucun code touché dans ce repo.**

- **Ce n'est pas un défaut applicatif.** `57P01` est émis par PostgreSQL aux backends qu'une
  **commande d'administration** termine (`pg_terminate_backend`, arrêt/redémarrage du service). Les
  moteurs `core-auth`, `core-caisse`, `core-comms`, `core-compta`, `core-stock` (+ `core-rdv`, déjà
  escaladé le 27/07, LogEvent `cms3mgw3a0007uxkl40fkqkvc`) l'ont émis **dans le même lot d'ingestion,
  à quelques centaines de ms** : cause **serveur, commune**. Un crash/OOM donnerait `57P02`, pas
  `57P01` → l'arrêt était **propre et volontaire**.
- **Pourquoi ça sort en « erreur »** : `core/lib/prisma.ts` construit le client avec `log:["error"]`,
  donc l'engine Prisma écrit ce message sur **stdout** ; le collecteur (`PacifiCode/deploy/logs-cron.sh`)
  retient toute ligne contenant la sous-chaîne `error`, et le canal de log de Prisma s'appelle
  `prisma:error`. C'est un **événement de cycle de vie**, pas une exception applicative : la connexion
  morte est jetée du pool et remplacée à la requête suivante.
- **Ne pas « réparer » ça ici.** Basculer Prisma en `emit:"event"` ne supprimerait pas l'événement,
  changerait juste sa mise en forme, et coûterait un déploiement des 5 moteurs pour zéro gain.
- **Ce qui reste ouvert, hors de ce repo** : *qui* a lancé la commande d'administration. **Non
  établi** — pas d'accès VPS depuis le sandbox (egress muré : `curl` sur les domaines publics = `000`).
  Fenêtres reconstituées (`firstSeen`/`lastSeen` datent de l'**ingestion**, cf. `log-escalate.ts`, et le
  collecteur tourne en `*/10`) : **~06:20–06:30 Pacific/Noumea les 2026-07-28 et 2026-07-31**.
  Escaladé à Marco avec les commandes de diagnostic (`journalctl -u postgresql@16-main`,
  `/var/log/unattended-upgrades/`, `dpkg.log`). Piste n°1 : la fenêtre de mises à jour automatiques
  Ubuntu (06:00–07:00 locale) redémarrant `postgresql`. **Ne pas conclure sans ces sorties.**
- **Si la signature revient** : ce n'est toujours pas un bug de ce moteur. Vérifier d'abord côté
  serveur (état/redémarrages de `postgresql`), puis `/api/health` du moteur (`db:true` ⇒ pool
  reconnecté). Toute affirmation d'infra se recoupe avec `00-Archi-NextGen/INFRA.md`, en frais.



## Dernières actions (2026-07-20)
- 🔭 **Socle observabilité déployé** (standard `00-Archi-NextGen/_templates/observabilite/`, tag `[core-caisse]`) :
  `core/lib/log.ts` + `core/instrumentation.ts` + `core/app/global-error.tsx` ; `log.error` ajouté (aucun changement
  de comportement) sur : `tenant.resolve`, `catalog.fetch` (Stock injoignable), `caisse.saleSync` (pont Compta/Stock
  post-encaissement), `caisse.repairSweep`, `api.cron.repairSales`, `health.db`. `lib/sync.ts` non touché (moteur pur
  sans import runtime) — le log vit chez son appelant `syncLoadedSale`. Tests node 27/27 verts.

## Dernières actions (2026-07-19)
- 🚀 **Onboardé sur le pipeline de déploiement unifié.** `core/next.config.ts` → `output:'standalone'` ;
  `core-caisse` (:3106) redéployable en une commande via le moteur (cutover pm2 auto → health `/api/health`).
  Détail infra → `00-Archi-NextGen/INFRA.md`.

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

- `2026-07-16` — 💥 **LE MOTEUR IMPUTE ET REND LA MONNAIE (plus l'appelant)** — **#4 MERGÉE ET DÉPLOYÉE**
  (`bda6906`). *(Merge fait à la main par Marco : panne GitHub « Partially Degraded Service », API
  authentifiée en 503 — le self-merge par API était impossible.)*
  - ✅ **VÉRIFIÉ EN PROD, de bout en bout** (ticket de vérif créé puis supprimé, base laissée vierge) :
    - **Espèces `amountXpf: 3000` sur un ticket à 2500** — l'entrée **exactement fautive** d'avant →
      `paidXpf: **2500**` (pas 3000), `changeXpf: **500**`, et la **Compta** enregistre
      `paidXpf 2500 / remainingXpf 0 / PAYEE`. À comparer à l'avant : `paidXpf 3000 / remainingXpf -500`.
      **Le moteur ignore l'imputation fautive de l'appelant et rend la différence.**
    - **Carte 3000 sur un ticket à 2500** → **`409 OVERPAID`** `{method:"CARD", excessXpf:500}`, le ticket
      **reste `DRAFT`**, `paidXpf 0`, **aucune facture créée** (le refus rend la main AVANT toute
      persistance → aucun numéro de facture brûlé).
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
  - ✅ **Tous les marchands sont désormais protégés au bon niveau** (le trou était ouvert pour Ellément,
    Onéiti… pas seulement V'Cut). La surface V'Cut (`#85`) garde son écran à **un seul champ « Espèces
    reçues »** — c'est de l'ergonomie, plus un garde-fou : **le moteur est l'autorité**.
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
