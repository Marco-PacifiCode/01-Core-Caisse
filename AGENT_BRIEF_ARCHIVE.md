# AGENT_BRIEF_ARCHIVE — 01-Core-Caisse

> Historique purge du brief le 2026-08-05 (regle : garder ~2 semaines dans le brief vif).
> Sections deplacees telles quelles, rien n'a ete reecrit.

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


