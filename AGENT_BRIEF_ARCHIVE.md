# AGENT_BRIEF_ARCHIVE — 01-Core-Caisse

> Historique purge du brief le 2026-08-05 (regle : garder ~2 semaines dans le brief vif).
> Sections deplacees telles quelles, rien n'a ete reecrit.

# Lot archivé le 2026-10-01 — sections datées avant le 2026-09-17

> Déplacées telles quelles depuis `AGENT_BRIEF.md` par `_routine/brief-archive.py`.

## 🎯 2026-09-15 — FIDÉLITÉ (lot C2 : moteur d'écriture + routes) — ✅ LIVRÉ le 16/09 (PR #47, main 434de39)

Branche `claude/caisse-fidelite-moteur-20260916` (worktree jetable `_wt/caisse-fidelite-c2`,
empilée sur C1, base `235b5d9`), tâche d'exécution cadrée. **Ne déploie rien, aucune commande
contre la prod** — même mandat que C1.

**Nouveau `core/lib/loyalty-db.ts`, écritures DB** (reçoit `tx`, testable par un FAUX `tx` en
mémoire, sans DB ni contexte Next — `lib/loyalty-checkout.test.ts`) : `lockAccount` (upsert +
`FOR UPDATE`), `insertEntry` (P2002 → `{duplicate:true}`, jamais levé), `creditVisit`,
`creditPoints`, `redeemReward` (update conditionnel `redeemedAt: null`, symétrique du bon
cadeau), `reverseSale` (reprise à l'annulation), `adjustLoyalty` (correction ADMIN),
`accountSummary` (lecture pure). 🔴 **Correctif QA du 2026-09-16 : `issueRewardsForDelta`
(delta de quotients) remplacée par `issueRewardsWhileNetReached` (retour au plan §2.2, au
pied de la lettre).** Défaut prouvé sur l'ancienne version : elle comparait
`Math.floor(sumAvant/N)` à `Math.floor(sumAprès/N)`, un quotient entier qui MENT dès que le
solde net devient négatif (REWARD retranche N, REVERSAL et ADJUST peuvent être négatifs ;
`Math.floor` arrondit vers -∞). Deux cas reproduits par la QA : (a) vente de 600 pts (seuil
500) → 1 récompense, net 100 ; annulation → net -500 ; vente de 500 pts → une 2ᵉ récompense
était créée à tort (la cliente n'avait pourtant gagné que 500 pts nets) ; (b) 5 visites → 1
récompense (net 0) ; correction ADMIN de -3 → net -3 ; 3 visites de plus → une 2ᵉ récompense
à tort. `issueRewardsWhileNetReached` ne divise plus jamais : sous le verrou de compte, elle
calcule le net APRÈS la ligne déclenchante, puis consomme ce net par tranches de N
(`while (net >= N) { REWARD(-N) ; net -= N }`, `ref = reward:<triggerRef>:<i>`, borne de
sécurité 1000 itérations). `rewardsToCreate` (le quotient pur) a été retirée de `loyalty.ts`
— un solde de fidélité est signé, un quotient entier ne s'applique qu'à un solde qui ne
descend jamais sous zéro. Tests couvrant les deux cas QA + rejeu + franchissement multiple en
une seule fournée : `loyalty-checkout.test.ts`.

**`checkoutSale`** (`lib/caisse.ts`) gagne `options.loyalty` (rattache la vente à une fiche
pour créditer des points en mode `POINTS`) et `options.redeemLoyalty` (consomme une
récompense). Contrôle de forme + disponibilité de la récompense **avant** tout paiement
persisté (même schéma que les bons cadeaux) ; consommation + crédit de points **dans** la
transaction du passage à PAID, **après** les bons. Course entre deux comptoirs → `LOYALTY_RACE`,
traitée comme `GIFT_CARD_RACE`. Rejeu d'une vente déjà PAID → retour anticipé, **aucune**
écriture fidélité (le bloc est après ce retour).

💰 **`giftCardSalesXpf` (6ᵉ paramètre de `pointsForSale`, décision Marco du 15/09 sur C1)** :
calculé en sommant les `amountXpf` de `giftCardsToIssue` (les bons émis PAR cette vente,
donnée d'entrée déjà validée) — jamais en inspectant les lignes ni en relisant `GiftCard` en
base. Test : ticket 3 000 F prestations + bon 10 000 F émis, assiette `ALL` → 30 points.

**`annulerVente`** : reprise fidélité (`reverseSale`) dans la **même** transaction que le
passage à VOID, **uniquement** si la vente était PAID (une vente DRAFT n'a jamais rien écrit
en fidélité). Un avoir émis **directement** depuis Core-Compta (verrouillé) ne repasse pas par
`annulerVente` : commentaire `TODO fidélité` laissé à cet endroit, reprise **non automatique**
dans ce lot (correction ADMIN manuelle prévue plus tard) — décision Marco du 15/09.

**Routes** (`app/api/loyalty/{program,accounts,visits,adjust}/route.ts`), gardées par
`hasServiceKey`, sur le modèle de `app/api/gift-cards/route.ts` : `GET/PUT /program`,
`GET /accounts` (50 fiches au plus, lecture pure — aucune fiche créée), `POST /visits`
(best-effort côté appelant, silencieux ici), `POST /adjust` (ADMIN, motif ≥ 3 caractères,
`ref` préfixé `adjust:`). 🔒 **Droits (décision Marco #2)** : la garde de rôle (ADMIN vs
`caisse`) vit côté SURFACE — ce Core ne connaît que la clé de service S2S, rien n'est
réinventé ici.

**+29 tests** dans `lib/loyalty-checkout.test.ts` (18 exécutés réellement sur le moteur DB via
faux `tx`, 11 structurels sur `checkoutSale`/`annulerVente`) → **343 tests** au total, tous
verts. `tsc --noEmit` et `prisma validate` verts. Contrôle anti-fantôme fait : sabotage de
`redeemReward` (retrait de `redeemedAt: null` du `where`) → les 2 tests de double consommation
rougissent → restauré → suite verte.

🛑 **Ne fait PAS** : jouer la migration C1, déployer ce Core, ni aucune surface. **Ordre
impératif avant tout déploiement** : migration C1 (`ops.sh migrate core-caisse`, accord
Marco) → `rls.sql` rejoué → déploiement de ce Core → écrans surface (hors de ce lot). Argent
en jeu (points/récompenses) → accord Marco explicite avant tout `ng-deploy`.

### 🔴 2026-09-16 — 3 correctifs contre-QA (câblage, plafond, remise à zéro)

**1. Câblage manquant, corrigé** : `app/api/sales/[id]/checkout/route.ts` ne transmettait ni
`loyalty` ni `redeemLoyalty` à `checkoutSale` — **aucune route HTTP n'atteignait le moteur de
fidélité**, S2 (crédit de points au checkout) était inopérant côté surface bien que le moteur
soit prêt côté Core. Ajouté : lecture + validation du corps (`loyalty.clientFicheId` UUID,
`loyalty.displayName` 1-200 car., `redeemLoyalty.rewardEntryId` UUID → 400 sinon), transmission
dans `options`, et mapping des erreurs `LOYALTY_NOT_REDEEMABLE`/`LOYALTY_AMOUNT_MISMATCH`/
`LOYALTY_ACCOUNT_MISMATCH` sur 409 (même famille que les bons cadeaux). Tests dans
`lib/checkout-route.test.ts` (contrat figé par lecture de source, même limite que les tests
`credit`/`paidAt` du même fichier).

**2. Plafond sans exception, corrigé** : `issueRewardsWhileNetReached` LEVAIT
`LoyaltyRewardOverflowError` au-delà de 1000 récompenses en un seul événement — atteignable avec
un réglage extrême (1 point pour une récompense, ticket à 100 pts/100F ⇒ des dizaines de milliers
de points d'un coup), et la boucle tournant DANS la transaction du passage à PAID, l'exception
pouvait faire échouer un encaissement **après persistance des paiements**. Décision : ne lève
plus jamais — s'arrête à `MAX_REWARDS_PER_EVENT` (1000) récompenses pour CET événement, `log.warn`
(compte + nombre émis), et le net excédentaire (encore ≥ perReward) N'EST PAS PERDU : il reste
dans le journal et sera repris par le PROCHAIN événement sur ce compte. `LoyaltyRewardOverflowError`
supprimée (plus aucun appelant). `POST /api/loyalty/adjust` protégé par un `try/catch` → 500 JSON
propre (`{error:"Erreur interne"}`, jamais de pile), même schéma que
`app/api/cron/repair-sales/route.ts`. Test : ADJUST de +100 000 points au seuil 1 → exactement
1000 récompenses créées, pas d'exception, net 99 000 ; l'événement suivant en crée 1000 de plus.

**3. Remise à zéro au changement de forme/réactivation — DÉCISION MARCO (15/09)** : « À chaque
changement de forme ou réactivation, le compteur et les points repartent de zéro, comme au
premier jour. Les récompenses déjà gagnées restent dues. »
- `nextActivatedAt` (lib/loyalty.ts) pose `now` dès que `nextMode !== "OFF"` ET
  `nextMode !== prevMode` (OFF → actif, ou changement de forme active) ; inchangé si la forme
  reste la même (changer N ou un pourcentage ne remet rien à zéro), et inchangé au passage à
  `OFF` (couper ne remet rien à zéro — seule une RÉACTIVATION le fait).
- `sumVisits`/`sumPoints` (`lib/loyalty-db.ts`, moteur net utilisé par
  `issueRewardsWhileNetReached` ET `accountSummary`) n'agrègent QUE les lignes
  `occurredAt >= activatedAt`, quel que soit leur `kind` (VISIT/POINTS/ADJUST/REWARD/REVERSAL) ;
  `activatedAt` NULL → 0 compté. `creditPoints` gagne la même garde d'écriture que `creditVisit`
  (`occurredAt < activatedAt` → rien n'est écrit — utile pour un règlement différé d'une caisse
  hors ligne antérieur à l'activation).
- La disponibilité d'une récompense (`isRewardAvailable`) NE dépend PAS de `activatedAt` — une
  récompense gagnée avant un changement reste consommable après.
- `accountSummary` renvoie désormais aussi `activatedAt` (affichage écran) et calcule le
  programme réel via `tx.loyaltyProgram.findFirst` au lieu d'un paramètre implicite.
- Tests dans `lib/loyalty-checkout.test.ts` : 3 visites VISITS N=5 → POINTS → VISITS → 2 visites
  → 0 récompense, net 2 ; récompense gagnée → OFF → réactivation → récompense toujours
  disponible, compteur à 0 ; changement de N sans changement de forme → net conservé. Sabotage
  (retrait du filtre `occurredAt >= activatedAt`) → le premier de ces tests rougit → restauré.

**Suite** : 360 tests, tous verts (`npm test`). `tsc --noEmit` et `prisma validate` verts.

🔴 **2026-09-16, correctif contre-QA supplémentaire** : `reverseSale` posait `occurredAt: new Date()` sur ses `REVERSAL` (l'instant de l'annulation, pas celui du crédit annulé), ce qui faisait entrer la reprise d'un ticket ancien dans le NET du cycle courant après une réactivation — corrigé en reprenant l'`occurredAt` de la ligne `POINTS`/`REDEEM` d'origine (`reverseSaleLoyalty` n'a donc plus besoin d'`occurredAt` en entrée) ; suite à 365 tests, tous verts.

## 💳 2026-09-15 — VENTE À CRÉDIT (échéancier, lot A) — ✅ EN PRODUCTION

✅ **Accord Marco (15/09)** : migration `20260915200000_sale_due_at` **JOUÉE** en prod par
`ops.sh migrate` (preuves RLS vertes, colonne `Sale.dueAt` vérifiée via `information_schema`), puis
Core déployé (PR #44, release 20260915-210624). Aucune surface ne l'utilise encore : lots B (pad
d'encaissement) et C (ligne compta dépliable) en cours dans Salon-Reference, déploiement = accord Marco.
Les mentions « non déployé / non jouée » ci-dessous sont historiques.

Branche `claude/caisse-checkout-credit` (worktree `_wt/core-caisse-credit`), tâche d'exécution
cadrée par un Lead Opus : autoriser une vente à CRÉDIT (1er versement + échéances ultérieures)
sans casser le chemin existant.

**But** : `checkoutSale` peut désormais passer une vente PAID sous-payée quand l'appelant fournit
`credit: { dueAt }` (YYYY-MM-DD, dernière échéance) — le 1er versement est libre, strictement > 0,
encaissé le jour même (décision Marco 15/09). Sans `credit`, comportement **strictement inchangé**
(garde UNDERPAID classique). Nouveaux refus AVANT encaissement : `CREDIT_NOT_NEEDED` (payé ≥ total,
409) et `CREDIT_NEEDS_DEPOSIT` (payé ≤ 0, 422). Route `POST /api/sales/:id/checkout` : `credit.dueAt`
invalide → 400. Décision pure extraite dans `core/lib/credit.ts` (`checkoutUnderpaidGuard`,
`parseDueAt`, `dueAtNoonUtcIso` — ancrage MIDI UTC, piège +11 NC).

**Argent — accord Marco requis avant déploiement.** Cette branche touche l'encaissement et la
facturation ; elle n'a **pas** été déployée par cet exécutant (interdiction du mandat). Le Z
(`closeSession`) compte toujours UNIQUEMENT l'encaissé et expose une ligne informative `creditXpf`
(« dont à crédit », `core/lib/z-report.ts#creditXpfPourRapport`) — n'entre ni dans `totalSalesXpf`
ni dans `expectedXpf`, même régime que `giftCardRedeemedXpf`.

**Consommateur** : surface Salon-Reference (lots B/C à venir — UI de saisie du crédit côté caisse,
écran des échéances). Les échéances ultérieures restent un encaissement MANUEL, HORS de ce lot A.

🛑 **Migration additive DÉPOSÉE (2e décision Marco du 15/09), PAS jouée, aucun accès prod** :
`core/prisma/migrations/20260915200000_sale_due_at/migration.sql` — `Sale.dueAt DateTime?`
(`ALTER TABLE "Sale" ADD COLUMN "dueAt" TIMESTAMP(3);`). Elle referme l'angle mort initialement
assumé (cf. mémoire `angle-mort-declare-ne-se-referme-pas`) : `Sale.dueAt` est posé dans LA MÊME
transaction que le passage PAID (`checkoutSale`, uniquement quand `options.credit` est fourni), et
`toSnapshot`/`syncLoadedSale` le RELISENT depuis la DB (plus depuis un paramètre volatile de la
requête d'origine) — donc `repairSale` et le cron `repair-sales` transmettent maintenant l'échéance
à Core-Compta même si le 1er `createInvoice` a échoué et que la facture est recréée hors de la
requête initiale. **Ordre à respecter avant tout déploiement, même esprit que l'entrée bon cadeau
ci-dessous** : migration (`ops.sh migrate core-caisse`, accord Marco) → déploiement de ce Core
(`--confirm-schema`) → déploiement des surfaces.

272→296 tests verts (+24 : `lib/credit.test.ts`, +5 dans `lib/z-report.test.ts`, +2 dans
`lib/sync.test.ts`, `lib/checkout-route.test.ts`, `lib/credit-repair.test.ts`, +1 régénéré dans
`lib/postes.test.ts`), `tsc --noEmit` vert (`prisma generate` rejoué après ajout du champ).
Contrôle anti-fantôme fait à deux reprises (garde crédit sabotée → 3 tests rouges → restaurée ;
lecture `sale.dueAt` sabotée → 1 test rouge → restaurée).

## 🎁 2026-09-15 — BON CADEAU CONSOMMÉ LIÉ AU RDV — **MIGRATION JOUÉE + CORE DÉPLOYÉ**

✅ **En prod le 15/09.** Migration appliquée par `ops.sh migrate core-caisse` (accord Marco) :
colonne `GiftCard.redeemedAppointmentId text NULL` vérifiée dans `information_schema`, `rls.sql`
rejoué, isolation prouvée sous le rôle applicatif sur les 6 tables, sauvegarde de structure
`C:\dev\_backup\core-caisse\ops-migrate-core-caisse-20260915T054704Z-avant.sql`. Puis Core
déployé (PR #42, `main` = `2e5834f`, release `20260915-165401`) ; preuve bout en bout
`GET /api/gift-cards` → 200. Retour arrière colonne : `DROP COLUMN "redeemedAppointmentId"`.
Consommateur : surface Ellément (lot C2) ; V-Cut peut suivre avec le même code surface.

Tâche d'exécution cadrée : lier un bon cadeau consommé au rendez-vous qu'il a réglé, pour qu'un RDV honoré par un
bon SEUL (pas de reliquat en espèces/CB) ne reste pas affiché « à encaisser » côté surface.

`GiftCard.redeemedAppointmentId` (nullable, sans FK, même patron que `Sale.sourceId`) est
renseigné à la consommation par `checkoutSale` quand la vente EST le RDV honoré
(`sale.sourceType === "rdv"`), et transmissible aussi via `POST /api/gift-cards/:id/redeem`.
272 tests verts (271 + 1), `tsc --noEmit` vert, `prisma validate` vert.

**Migration additive** (jouée le 15/09, cf. ci-dessus) :
`core/prisma/migrations/20260915120000_gift_card_redeemed_appointment/migration.sql`.

🛑 **Ordre impératif à respecter** : migration → déploiement de ce Core (avec
`--confirm-schema`) → déploiement des surfaces qui lisent le nouveau champ. Si ce Core part
**avant** la migration, la lecture des bons cadeaux casse pour **tous** les marchands (colonne
attendue par le code, absente en base).


# Lot archivé le 2026-09-29 — sections datées avant le 2026-09-15

> Déplacées telles quelles depuis `AGENT_BRIEF.md` par `_routine/brief-archive.py`.

## ⚙️ CI GITHUB : PULL_REQUEST + MANUEL SEULEMENT (2026-09-07)

- 2026-09-07 — ci.yml : CI GitHub sur pull_request + manuel seulement (plus sur chaque push), concurrency cancel-in-progress. Verif locale ci-local.sh inchangee.

## ✅ 2026-09-06 — `GET /api/sales` RÉPOND POUR N RENDEZ-VOUS D'UN COUP (déployé)

Branche `claude/sales-source-ids` → PR #38, `main` = `5d4ba9d`, release
`20260906-023932`, pm2 `core-caisse` online. 264 tests verts, `tsc` 0.

**Ce qui change** : `GET /api/sales?sourceType=rdv&sourceIds=<uuid>,<uuid>,…`. Un planning
qui veut savoir « qui a payé » sur un mois appelait cette route **une fois par
rendez-vous** — trois cents appels pour une vue mois. C'est ce qui bloquait le filtre
« Règlement » de la surface, construit le même jour.

🛑 **Ce chemin NE TRONQUE JAMAIS.** L'unicité `uniq_sale_external_source`
`(tenantId, sourceType, sourceId)` garantit au plus une vente par identifiant : `take`
vaut le nombre d'identifiants demandés, le plafond de 500 du chemin historique ne
s'applique pas. Au-delà de `MAX_SOURCE_IDS = 200` **identifiants distincts**, la route
**refuse en 400** au lieu de rogner — *une troncature se lirait « pas de ticket » et
ferait ré-encaisser une cliente qui a déjà payé*.

✅ **Vérifié EN PRODUCTION après déploiement**, pas seulement en test :
- 114 identifiants → 114 lignes, `{PAID: 103, DRAFT: 11}` ;
- 200 identifiants distincts → 200 ; **201 → 400 `TOO_MANY_SOURCE_IDS`** ;
- `sourceIds` sans `sourceType` → **400** ;
- ⚠️ le dédoublonnage a lieu **avant** le plafond : 228 identifiants dont 114 distincts
  passent, et c'est voulu (l'appelant n'est pas puni pour un doublon).
- **Sonde des 6 salons avant/après le déploiement : identique à l'octet près.**

🪤 **Le repli côté appelant compte autant que la route.** Un Core-Caisse plus ancien
ignore `sourceIds` **en silence** et rend sa liste habituelle. La surface refuse toute
réponse contenant un `sourceId` non demandé (`Salon-Reference/surface/lib/paiement-rdv.ts`)
et répond « je ne sais pas » — jamais « pas de ticket ».

## 💰 2026-09-06 — L'ARGENT DU SALON DE DÉMONSTRATION (données, tenant fictif)

114 ventes créées **par les routes de ce moteur** (jamais d'`INSERT`) sur le seul tenant
`d0000000-…-de`, rattachées aux rendez-vous honorés : 103 encaissées (CARD 50 · CASH 34 ·
TRANSFER 8 · CHEQUE 7 · MIXTE 4), 11 laissées ouvertes (54 000 XPF de reste dû).
`occurredAt` et `paidAt` antidatés — les champs que ce moteur porte déjà pour les caisses
hors ligne. Script, sondes avant/après et **procédure de retrait** :
`C:\dev\_backup\2026-09-06-demo-argent\`.

🛑 **UN MANQUE DU MOTEUR MIS À NU, NON CORRIGÉ (décision Marco)** : `runSaleSync` crée la
facture Compta **sans date**, et `POST /api/invoices` de Core-Compta n'en accepte aucune
(`Invoice.createdAt` = `@default(now())`). Un encaissement antidaté produit donc une pièce
datée du jour. Correctif proposé : un `issuedAt` **optionnel** sur `POST /api/invoices`,
relayé depuis `sale.createdAt` par `core/lib/sync.ts`. **C'est de la facturation → §8 →
escaladé, pas déployé.**

---

## 🎁 CONSOMMER UN BON DANS LA TRANSACTION D'ENCAISSEMENT — livré (2026-09-04)

🗣️ **Marco** : « elle ne peut pas encaisser avec un bon d'achat, il faut un bouton ici. »

Le moteur savait **ÉMETTRE** un bon dans la transaction de l'encaissement, jamais en
**CONSOMMER** un : `redeemGiftCard` était un appel séparé. Une surface qui voulait régler par
bon devait donc brûler le bon **puis** encaisser — deux requêtes, et une fenêtre où la cliente
perd son bon si le réseau coupe entre les deux.

**`CheckoutOptions.redeemGiftCards`**, symétrique exact de `.giftCards` :
- validation de **forme** d'abord (`normalizeRedeemedFor`), **inerte** sans le champ ;
- contrôle de consommabilité **AVANT** que le moindre paiement soit persisté — même raison que
  le contrôle de code libre : sans lui, l'argent serait pris et la vente resterait en attente ;
- **UPDATE CONDITIONNEL** (`redeemedAt: null`) **DANS** le `withTenant` du passage à PAID :
  0 ligne = un autre comptoir a brûlé le bon → on annule TOUT, le ticket reste DRAFT.

🔒 **Aucun montant à encaisser n'y transite** : un bon n'est pas un moyen de paiement, son
montant est entré dans le CA le jour de son achat. La surface a déjà retiré du ticket ce que le
bon couvre (ligne `OTHER` négative).

🛑 **AUCUNE migration** (le modèle `GiftCard` portait déjà tous les champs) et **AUCUNE valeur
d'enum** — un test l'épingle désormais sur `PayMethod` et `LineKind` : une valeur d'enum
PostgreSQL ne se retire jamais.

⚠️ **Contrainte à connaître avant de toucher au bloc de la transaction** : un test structurel
isole le code entre `const issued = await withTenant` et la **première** fermeture `  });`.
Condition et marquage de l'`updateMany` sont donc sortis dans des `const` et l'appel tient sur
UNE ligne — sinon le test échoue sur du code pourtant correct.

258/258 tests, `tsc` 0. Trois tests structurels ajoutés (même transaction · update conditionnel
· aucune valeur d'enum).

## ✅ `GET /api/sales` FILTRABLE PAR `(sourceType, sourceId)` — **PR #32 MERGÉE ET DÉPLOYÉE** (2026-09-01)

> 🗣️ **Marco, 2026-09-01 : « ok go pour tout ».** Mergée (`d7761be`) puis livrée :
> release `20260901-005946`, artefact **prouvé == `origin/main`**, `pm2 core-caisse` **online**.
> C'est la brique qui permet de POSER la question « existe-t-il déjà un ticket pour ce
> rendez-vous ? » — sans elle, la garde d'argent de `01-Core-RDV` n'a rien à interroger.

> **PR** : `github.com/Marco-PacifiCode/01-Core-Caisse/pull/32` (branche `claude/sales-filtre-source`).
> **À merger EN PREMIER** des trois du lot : `01-Core-RDV` **#99** et `Ellement-de-beaute` **#185** en
> dépendent. **Aucune migration.** CI locale **GREEN**, `tsc` 0 erreur, **255/255**.

**Deux paramètres optionnels**, qui n'ont d'effet **qu'ensemble**. **Sans eux, la requête produite est
identique à celle d'avant** — aucun appelant existant ne change de comportement.

**Pourquoi.** Une vente ouverte depuis un rendez-vous porte `(sourceType, sourceId) = ("rdv",
appointmentId)` — sa clé d'idempotence (index `uniq_sale_external_source`). Une surface qui veut savoir
si un rendez-vous a **déjà son ticket** n'avait qu'un seul moyen : tirer les **500 dernières** ventes et
chercher dedans. C'est cher pour une question booléenne, et surtout **c'est faux** — une vente plus
ancienne que la fenêtre passe à travers, et on conclut « pas de ticket » sur un rendez-vous déjà
encaissé.

💰 **Et cette réponse garde de l'argent** : `createSale` (`lib/caisse.ts`) **rend la vente existante
SANS remettre ses lignes à jour**. Un « non » erroné laisse changer le panier du rendez-vous, et la
caisse encaisse ensuite l'**ancien** panier, en silence. **On ne répond donc pas de façon
probabiliste.**

🪤 **Pour qui écrit un appelant** : tant que ce filtre n'est pas déployé, un moteur ancien **ignore les
deux paramètres** et renvoie les N dernières ventes du tenant. Un appelant honnête doit détecter ce cas
(un `sourceId` qui ne correspond pas à celui demandé) et conclure **« je n'ai pas pu savoir »** — donc
refuser. C'est ce que fait la surface Ellément (`app/app/admin/agenda/actions.ts`,
`ticketExisteInterne`). ⚠️ **Jamais `false`** : ce serait ouvrir le trou exactement là où il coûte.

## 🔁 CORRIGER LE MOYEN DE PAIEMENT D'UN TICKET — `POST /api/sales/:id/payment-correction` (2026-08-26) — ✅ **en production**

🚀 **PR #26 · `main 30ddcd3` · release `20260826-180052` · WEB OK.** Livré **après** Core-Compta
(PR #43, qui devait savoir répondre avant qu'on l'appelle) et **avant** la surface Aurel'Styl
(PR #48). Ordre inverse : rien n'aurait cassé, mais aucune correction n'aurait abouti.

🗣️ Demande de la gérante d'Aurel'Styl : *« revenir en arrière sur un mode de paiement quand on
s'est trompé »*. **Aucune migration, aucun changement de schéma.**

**Un `SalePayment` n'est jamais modifié** — il ne l'était nulle part dans ce moteur, et ça ne
change pas. La correction s'écrit en **CONTRE-ÉCRITURE** : `-X` sur l'ancien moyen, `+X` sur le
nouveau. `Sale.totalXpf` et `Sale.status` ne sont **pas** touchés ⇒ le CA (`totalSalesXpf`) est
intact, et l'attendu du Z se corrige **tout seul** : `closeSession` recalcule `expectedXpf` en
sommant les `SalePayment` de méthode `CASH` de la session. Rien à « rafraîchir » : c'est une
propriété du calcul, pas une discipline.

🛑 **REFUS SI LA SESSION EST CLÔTURÉE (ou absente) — la garde centrale du lot.** La clôture fige
`expectedXpf`/`varianceXpf` en base, mais `buildReport` (`lib/caisse.ts` ~213-230) réaffiche un
attendu **recalculé à chaud** : corriger après coup ferait dire au même écran un attendu et un
écart qui ne se répondent plus. C'est une décision **prudente en attente d'arbitrage de la
gérante**, pas une propriété technique — si elle demande l'inverse, il faudra alors décider ce que
devient le Z archivé. Éprouvé **par mutation** : garde retirée ⇒ un test rouge, et un seul.

**L'ORDRE, et il compte : la COMPTABILITÉ d'abord, la caisse ensuite** (même raison que
`void-sale.ts` : une caisse qui dit « carte » pendant que la comptabilité dit « espèces » est le
pire des deux états). Si l'écriture comptable échoue → `502 COMPTA_CORRECTION_FAILED`, **rien**
n'est écrit ici. Le rejeu est sûr : Compta répond « déjà corrigé », la caisse finit son travail.

- 🔑 Clé **déterministe** `caisse:<saleId>:<de>-<vers>:<montant>` ; `settleRef` = `corr:<clé>:out` /
  `:in`, **exactement les `ref` posées côté Compta**. C'est voulu : si le cron `repair-sales`
  rejouait `runSaleSync`, le `settle` du montant négatif retomberait sur une `ref` déjà connue et
  serait absorbé en « déjà payé » au lieu d'écrire un doublon.
- Autres refus : `NOT_PAID` · `NO_INVOICE` · `NOT_SYNCED` (la vente n'est pas encore remontée en
  compta : on ne corrige pas ce que le cron n'a pas fini d'écrire) · `NOTHING_TO_CORRECT` ·
  `INVALID` (moyen hors enum `PayMethod` — un **test structurel relit `schema.prisma`** pour que
  l'ajout d'un moyen ne passe pas inaperçu).
- `log.info` **n'existait pas** dans `lib/log.ts` : ajouté. C'est là que vit la trace « qui a
  corrigé » (`sale.payment_correction`) — aucun champ de schéma ne peut la porter sans migration.

🔒 **VERROU DE LIGNE SUR `Sale` (`lib/sale-lock.ts`) — deux défauts trouvés par la revue QA du
26/08, tous deux fermés avant livraison :**
1. **La course.** `insertCorrectionPayments` comptait puis créait : en `READ COMMITTED`, deux
   appels simultanés lisaient `count = 0` et écrivaient **4 lignes au lieu de 2** — Z faussé.
   `SalePayment` n'a **aucune unicité en base** sur `settleRef` (contrairement à `CashMovement.ref`)
   et en ajouter une serait une migration. On ferme donc un cran plus tôt, sur la **lecture** :
   `SELECT … FOR UPDATE` sur la ligne `Sale`, **première** opération de la transaction d'écriture —
   exactement le remède posé côté Compta le 23/08 (`invoice-lock.ts`), même plafond `lock_timeout`
   3 s sous le timeout Prisma. ⚠️ **Le verrou ne couvre JAMAIS l'appel réseau à Compta** (il est
   pris après). Éprouvé par mutation : sans verrou, la course écrit 4 lignes et le test rougit.
2. **L'aller-retour silencieux.** Espèces→Carte, puis Carte→Espèces, puis Espèces→Carte : la 3ᵉ
   retombait sur la clé de la 1ʳᵉ, répondait « déjà corrigé » et **n'écrivait rien pendant que
   l'écran annonçait un succès**. La clé porte désormais une **génération** — le nombre de
   `SalePayment` déjà préfixés `corr:` sur la vente, lu dans le snapshot (aucune requête de plus).
   Deux appels *simultanés* lisent la même génération (donc même clé, donc dédupliqués) ; deux
   corrections *successives* en voient des différentes. Test écrit en toutes lettres.

🕳️ **Limite connue, assumée** : si l'écriture Compta réussit et que la caisse échoue derrière, le
rejeu répare (clé déterministe) — mais **aucun cron ne le rejoue tout seul**, contrairement à
`repair-sales` pour la synchro des ventes. Sans nouvelle tentative, les deux moteurs restent
divergents en silence.

✅ **234 tests** (207 avant), `tsc` 0, `next build` OK. Consommé par la surface **Aurel'Styl**
uniquement pour l'instant (les 4 autres surfaces : lot à part, aucun travail moteur à refaire).

## 🗃️ IMPORTER UNE CLÔTURE Z + TAUX DE TGC PAR LIGNE (2026-08-22) — ✅ APPLIQUÉ ET EN PRODUCTION

Migration `20260823090000_import_cloture_z` **appliquée le 2026-08-22** sur autorisation explicite de
Marco, puis **PR #24 mergée et déployée** (release `20260822-193445`, healthcheck vert).

**Route `POST /api/sessions/import`, SÉPARÉE du chemin vivant.** `openSession`/`closeSession`
servent trois marchands en temps réel et **n'ont pas bougé d'une ligne** : l'import est un second
chemin, isolé. C'est ce qui rend la non-régression structurelle plutôt que statistique.

**Pourquoi importer plutôt que recalculer.** Les ventes de la Rôtisserie arrivent **sans session**
(`sessionId` nul) — elles n'ont jamais transité par le parcours temps réel. Un Z ne peut donc pas
être recalculé ici : il n'y a rien à quoi le rattacher. Ce qu'il apporte, et que les ventes ne
donnent pas, c'est le **rapprochement de caisse** : fond, comptage du tiroir, écart.
⚠️ **L'écart est RECALCULÉ**, jamais repris de l'appelant — un écart qu'on accepte tel quel n'est
plus un contrôle. Les dates d'ouverture et de clôture, elles, sont **fournies** : sans elles une
journée du 3 août archivée le 20 apparaîtrait au 20.

**Le taux de TGC par ligne traverse enfin.** Il était **silencieusement jeté à quatre endroits**
entre la route et l'appel à Compta ; les quatre sont ouverts. Optionnel partout : absent ⇒
comportement inchangé (`undefined`, **pas** `0` — `0` signifie « hors champ TGC » côté Compta, ce
qui n'est pas « non renseigné »).

**Preuves AVANT / APRÈS** par `information_schema` (`prisma migrate status` ne fait pas foi) :

| | AVANT | APRÈS |
|---|---|---|
| `CashSession.sourceType` / `sourceId` | absentes | **text** |
| `SaleLine.tgcRatePpm` | absente | **integer** |
| `uniq_session_external_source` | absent | **présent** |
| propriétaires · RLS | `core_caisse_owner` · enable+force | **inchangés** |

Appliquée en rôle `core_caisse_owner` (`superuser = f` vérifié avant), sauvegarde de structure dans
`/home/deploy/_backup/migrations-20260822/`, enregistrée par `prisma migrate resolve --applied`,
`rls.sql` rejoué.

🔎 **Non-régression prouvée après coup** : `GET /api/sales` → **200** pour tous les tenants,
V-Cut et Onéiti rendent bien leurs ventes (2 261 octets chacun). `POST /api/sales/<inconnu>/void`
→ **404 SALE_NOT_FOUND**, la route d'annulation répond.

🕳️ **À SAVOIR AVANT TOUTE SONDE SUR CE MOTEUR** : les valeurs du `.env` de Core-Caisse sont
**entre guillemets** (celles de Core-Compta ne le sont pas). Une extraction
`sed -n 's/^X=//p' .env` sans `| tr -d '\"'` rend une valeur inutilisable, et **tout échoue en
silence** — y compris les témoins de contrôle. C'est ce qui m'a fait conclure une première fois que
`Sale.posteId` n'existait pas, alors qu'elle est bien là. **Encadrez toujours une sonde d'un témoin
positif ET d'un témoin négatif.**

## 🚫 ANNULER UNE VENTE — `POST /api/sales/:id/void` (2026-08-22)

🗣️ Demandé par Marco pour la Rôtisserie de Pouembout : une vente déjà remontée ne pouvait
plus être annulée depuis aucune caisse. `voidSale` existait dans `lib/caisse.ts` depuis l'origine
mais **n'était exposée nulle part** — du code mort — et elle **refuse une vente `PAID`**, donc
justement le seul cas qui se pose en pratique.

**Le geste comptable d'une vente payée n'est pas un statut, c'est un AVOIR.** La route émet donc
un avoir côté Core-Compta (`POST /api/invoices/:id/credit-note`) **avant** de passer la vente à
`VOID`. Trois propriétés à connaître :

- 🛑 **Si l'avoir échoue, la vente NE PASSE PAS à `VOID`.** Une caisse qui dit « annulé »
  pendant que la comptabilité encaisse encore est le pire des deux états. → `502
  CREDIT_NOTE_FAILED`, et la vente reste telle quelle.
- 🔁 **Rejouer est sûr.** L'avoir de Compta est idempotent par `(tenantId, "avoir", invoiceId)` :
  si `markVoid` échouait après l'émission, un second appel récupère l'avoir déjà émis
  (`alreadyExisted:true`, 200) puis termine le passage à `VOID`. Aucun état coincé.
  *(Le `409 ALREADY_CREDIT_NOTE` de Compta ne concerne QUE la tentative d'avoir sur un avoir.)*
- ⛔ **REFUS si du stock a été décrémenté** (ligne `PRODUCT` + `stockSyncedAt`) → `409
  STOCK_DECREMENTED`, rien n'est touché. **Ce moteur est mutualisé** : remettre du stock est un
  geste distinct qu'on ne devine pas ici, et un stock faux se paie plus cher qu'un refus. La
  Rôtisserie n'est pas concernée (ses lignes sont `OTHER`, sans `productId`) ; V-Cut et Onéiti
  le seraient.

`DRAFT` → `VOID` direct, aucun appel externe. `VOID` → idempotent (`alreadyVoid:true`).
La logique est **pure et sans DB** (`lib/void-sale.ts`, même schéma d'injection que `lib/sync.ts`) :
c'est ce qui permet de tester « l'avoir échoue → la vente reste `PAID` » sans base.

✅ **189 tests** (180 avant, **+9**) · `tsc --noEmit` vert · **aucune migration, aucun changement
de schéma Prisma** — le déploiement est réversible par simple bascule de symlink.

## 🧾 LA FACTURE PORTE LA RÉFÉRENCE DU TICKET (2026-08-21) — ✅ EN PRODUCTION

Changement minuscule, sans lequel rien du circuit « qui a payé » ne fonctionne : `createInvoice` reçoit
désormais **`ticketRef: sale.sourceId`** — l'identifiant tiré par la tablette.

**Pourquoi `sourceId` ne suffisait pas** : la facture est créée avec `sourceId = sale.id` (l'uuid de la
VENTE), tandis que le circuit de paiement ne connaît que le **ticket**. Les deux références existaient,
elles ne se rencontraient nulle part. `SyncSaleSnapshot` porte donc `sourceId`, et le client Compta
l'accepte.

⚠️ **La caisse ne reçoit toujours AUCUN e-mail de client** — et ne doit pas en recevoir. C'est
core_paiement qui dépose l'attribution chez Compta, de serveur à serveur.

✅ `tsc` vert · **180 tests** ✔ (aucun cassé). ❌ Pas de test neuf sur ce passage — à écrire.

🚀 **EN PRODUCTION le 2026-08-21** — `ng-deploy core-caisse deploy claude/qui-a-paye`, PR **#21**
(`0bcfb6e`), release `20260821-152725`, **WEB OK**. Aucune migration : ce lot ne touche pas le schéma.
Livré **après** core_compta, qui devait savoir accepter `ticketRef` avant qu'on le lui envoie — l'ordre
inverse n'aurait rien cassé (l'ancien code ignore un champ inconnu), mais n'aurait rien attribué non plus.

🔗 **Ce lot ne vaut rien seul** — il va avec `01-Core-Paiement` (qui sait qui paie), `01-Core-Compta`
(qui attribue) et `PacifiClic` (qui déclare). Les quatre se déploient ensemble, migrations d'abord.

## ✅ 2026-08-15 — PLUSIEURS POSTES PAR MARCHAND + HORODATAGE FOURNI (`3e9cbcf`, PR #20)

**Migration appliquée en production et code déployé.** Décision Marco : la **Rôtisserie de
Pouembout** (première surface « snacking ») a **deux caisses et pas d'internet sur place**.
Deux blocages rendaient le branchement impossible :

1. Aucune notion de poste, et **une seule session ouverte par marchand** → deux comptoirs ne
   pouvaient pas tenir chacun la sienne.
2. **`createdAt`/`paidAt` posés par le serveur** → des ventes remontées le lendemain auraient
   été datées du jour de la synchronisation, faussant le CA quotidien et la ventilation TGC.

### Ce qui a changé — tout est ADDITIF

| | Avant | Après |
|---|---|---|
| `CashSession.posteId`, `Sale.posteId` | — | `text` **nullable**. NULL = mono-caisse |
| Unicité session ouverte | une par **tenant**, garde applicative | une par **(tenant, poste)**, garantie **en BASE** |
| `createdAt` d'une vente | `@default(now())` | idem, **sauf si** `occurredAt` est fourni |
| `paidAt` | `new Date()` en dur | idem, **sauf si** `paidAt` est fourni |

🔑 **`COALESCE("posteId", '')` dans l'index unique partiel est indispensable** : dans un index
unique, deux `NULL` sont **DISTINCTS**. Sans cette normalisation, un marchand mono-caisse
aurait pu ouvrir plusieurs sessions — la règle actuelle aurait été **relâchée** au lieu d'être
préservée.

⚠️ **`currentSession(tenantId)` cherche désormais la session dont `posteId IS NULL`**, et non
« n'importe quelle session ouverte ». Pour les trois marchands d'origine le résultat est
identique ; sur un marchand multi-postes, rendre la session d'un autre comptoir rattacherait
des ventes au mauvais tiroir.

**Dates** : une vente datée dans le futur est refusée (`FUTURE_DATE`, 400) ; un `paidAt` futur
est en revanche **ignoré** et retombe sur l'heure du serveur — le ticket est déjà encaissé au
comptoir, on ne bloque pas sa remontée pour une horloge mal réglée.

🕳️ **Piège à connaître avant de retoucher `checkoutSale`** : un test structurel
(`gift-card-routes.test.ts`) isole le bloc du passage à `PAID` entre `const issued = await
withTenant` et la **première** fermeture `});`, pour prouver son atomicité avec la création des
bons cadeaux. L'`update` doit donc rester **sur une seule ligne** — un update multiligne
introduit une fermeture intermédiaire qui tronque l'extraction, et le test échoue sur du code
pourtant correct. La date est calculée avant, pour cette raison.

**Vérifié** : 180 tests (169 d'origine + 11 sur la rétrocompatibilité), typecheck, migration
posée avec **0 session ouverte** en base (donc aucun conflit d'index), `/api/health` →
`rlsForced:true` et dépendances Compta/Stock `up`, et les trois marchands répondent après
déploiement.

**Reste à faire** côté rôtisserie : la surface n'envoie encore rien — le lot 4 (file d'attente
locale et synchronisation différée) est à écrire. Voir
`Rotisserie-Pouembout/AUDIT-ET-ROADMAP.md`.

## ✅ 2026-08-11 — BONS CADEAUX (PC-0064) : **MIGRATION APPLIQUÉE ET CODE EN PRODUCTION** (`986ee21`)

> 🔒 **L'invariant du module, et il commande tout le reste :**
> **le montant d'un bon entre dans le chiffre d'affaires UNE SEULE FOIS, le jour de son achat.**
> Un bon cadeau est une **prestation vendue à l'avance**, pas un moyen de paiement.

PR #18 mergée, moteur livré en `986ee21`, surface Onéiti en `df8028e`. Ordre respecté :
**migration → moteur → surface**.

### Comment la migration est réellement passée — pas par le chemin annoncé

⚠️ **Le canal `Actions > Ops` était HORS SERVICE** : le quota GitHub Actions s'est épuisé vers 02 h
le 2026-08-11 (dernier run vert à 01 h 55, puis des jobs `conclusion=failure` avec **`steps=0` et
`2 s`** — la signature d'un job qui **n'a jamais démarré**, pas d'un code rouge).

🔴 **Ce brief a affirmé l'inverse quelques heures plus tôt** — « le chemin outillé est VIVANT,
mesuré », en citant trois runs verts « le jour même ». Ils dataient de **la veille**. La leçon n'est
pas « il faut mesurer » : elle est que **`aujourd'hui` se relit sur l'horodatage du run**, jamais sur
la position dans une liste triée par date décroissante.

**Ce qui a marché :** `ops.sh` est un script bash qui prévoit explicitement d'être joué depuis le
poste (`# Sur le poste de Marco, VPS_KEY désigne une clé locale`). Il a donc été lancé en direct,
avec **toutes ses gardes et toutes ses preuves** :

```bash
OPS_PHASE=ecriture bash 00-Archi-NextGen/_routine/ops/ops.sh migrate core-caisse 20260811120000_gift_card
```

⚠️ **Le geste ne transporte PAS les fichiers** (le checkout VPS n'est pas un dépôt git) : `migration.sql`,
`rls.sql` et `schema.prisma` ont été copiés par `scp` **depuis les blobs git**, puis leur `sha256`
vérifié sur le serveur. C'est indispensable : Prisma enregistre le sha du fichier appliqué, et un
CRLF le change. *(Constaté au passage : `rls.sql` et `schema.prisma` traînaient en CRLF sur le VPS
depuis une copie Windows antérieure — sans conséquence, ces deux-là n'ont pas de somme de contrôle.
Les 4 `migration.sql` déjà appliquées, elles, étaient bien en LF et conformes à git.)*

### Les preuves rendues par le geste — une seule rouge aurait suffi à tout arrêter

- table **`GiftCard` créée**, propriétaire **`core_caisse_owner`** ✔
- DML complet (S/I/U/D) pour **`core_caisse_app`** ✔
- `ENABLE` + `FORCE` + policy `tenant_isolation` sur **les 6 tables** portant `tenantId` ✔
- **isolation sous le rôle APPLICATIF** : 0 ligne sans contexte de tenant, sur des tables **peuplées**
  (`Sale` ~47, `SaleLine` ~78, `CashSession` ~14) — donc **cloisonné**, pas « vide » ✔
- migration enregistrée dans `_prisma_migrations`, aucune ligne en échec ✔

**Bout en bout, sur la production servie :** `GET /api/gift-cards?tenantId=<uuid inconnu>` avec la
clé S2S rend **`200 {"ok":true,"giftCards":[]}`**. C'est LA preuve qui compte : le client Prisma de
`web-current/` connaît le modèle et la requête s'exécute sur la vraie table. Un `500` aurait signé un
client périmé — le piège classique, puisqu'un redémarrage ne régénère rien.

Sauvegarde de la structure d'avant, rapatriée hors du `/tmp` du serveur :
`C:\dev\_backup\core-caisse\ops-migrate-core-caisse-20260811T032647Z-avant.sql`.

⚠️ **Piège d'exploitation rencontré** : les valeurs du `.env` sont **entre guillemets**. Un
`sed -n 's/^CLE=//p'` rend `"abc"` et l'appel part en 401 — nettoyer par `tr -d '\r"'`.

`targets/core-caisse.conf` porte bien `OPS_MIGRATE_URL_VAR=DATABASE_URL_OWNER`.

⚠️ **Rôle : `core_caisse_owner`, jamais `postgres` ni `core_caisse_app`.** Le piège est symétrique
et il a déjà été payé ici : une table créée en superuser appartient à `postgres` et l'application
récolte « permission denied » à la première lecture ; à l'inverse `core_caisse_app` n'a pas
`CREATE`. Les droits DML de l'app viennent des DEFAULT PRIVILEGES du propriétaire, qui ne jouent
**que** si c'est bien lui qui a créé la table.

**Réversibilité : `DROP TABLE "GiftCard";`** — rien d'autre. Migration **additive pure**, générée
par `prisma migrate diff` (pas écrite à la main) : une seule table neuve, **aucun `ALTER TYPE`**
(ni `PayMethod` ni `LineKind` ne bougent — une valeur d'enum PostgreSQL ne se retire jamais),
aucune colonne sur une table existante, aucune contrainte sur une table en service.

`'GiftCard'` est dans le tableau de `prisma/rls.sql`, donc `db:rls` génère sa policy — **rejoué par
le geste**, et l'isolation est **prouvée en production** (détail plus haut). Le paragraphe qui vivait
ici disait « personne ne l'a vue tourner » : c'était vrai avant l'application, ça ne l'est plus.

### Ce que le code fait

- **Achat** = jumeau d'une vente au comptoir (argent encaissé, Z qui le compte, facture au nom de
  l'**acheteur**) → `checkoutSale` gagne un **4ᵉ paramètre optionnel** `options.giftCards`. Les
  bons naissent **dans la transaction du passage à `PAID`** : aucune fenêtre entre « l'argent est
  pris » et « le bon existe ». Les deux refus tombent **avant** tout encaissement.
- **Consommation = AUCUNE COMPTABILITÉ** : ni vente, ni paiement, ni mouvement de tiroir, ni
  facture. Un test interdit sept chaînes dans le corps de `redeemGiftCard`.
- **Atomicité** : `updateMany` avec `redeemedAt: null` dans le `WHERE` → un unique
  `UPDATE … WHERE "redeemedAt" IS NULL`. **Jamais** `SELECT` puis `UPDATE`. 0 ligne ⇒
  `ALREADY_REDEEMED`. La relecture n'existe qu'**après** l'échec, pour *nommer* le refus.
- **Z** : `giftCardRedeemedCount` / `giftCardRedeemedXpf`, **informatifs**, hors de `totalSalesXpf`
  et de `expectedXpf`. L'invariant tient par la **signature** (`expectedCashXpf` ne reçoit pas de
  bons) — pour le casser il faut changer un prototype, pas oublier une ligne. Rattachement par
  **fenêtre `redeemedAt`**, **aucune FK vers `CashSession`**.
- **Statut « expiré » dérivé à la lecture**, jamais stocké. Et l'expiration **ne bloque pas** la
  consommation : accepter un bon périmé est une décision **du commerce**, pas du moteur.

**Preuves** : **71 → 169 tests** verts sous `TZ=UTC` **et** `TZ=Pacific/Noumea` · `tsc` 0 · CI
verte · **zéro nom de marchand** dans les 2006 lignes ajoutées (contrôle par tokens).
**Et ces tests mordent** — deux régressions injectées puis annulées : remplacer l'`UPDATE`
conditionnel par un `findFirst`-puis-`update` ⇒ **1 rouge** ; rendre le champ `giftCards`
systématique dans la réponse ⇒ **1 rouge**.

**Les marchands qui n'ont rien demandé sont inchangés, et c'est verrouillé par test** : champ
optionnel de bout en bout, clé **omise** de la requête et de la réponse quand il n'y a pas de bon.

❓ **Un point non tranché** : `POST /api/gift-cards` crée un bon **sans encaissement** (geste
commercial, remplacement d'un bon papier abîmé, reprise d'historique). Il était dans la conception,
il est documenté comme n'étant **pas** le chemin d'achat, et **aucune surface ne l'appelle**. Si ce
cas n'est pas voulu, il se retire en supprimant un fichier.

## ✅ LIVRÉ 2026-08-10 — `GET /api/sales` rend la VENTILATION par moyen de paiement (PR #16)

> 🗣️ Marco : **« il faut faire la ventilation ici »** — dans l'application, pas via une requête SQL
> à la main sur le serveur.

**Le blocage annoncé était FAUX, et c'est la leçon de ce lot.** Un rapport avait classé la
ventilation comme « impossible sans un appel par ticket · capacité manquante du moteur ». Relecture
de la route : `GET /api/sales` **chargeait déjà les paiements** —
`include: { payments: { select: { method: true, amountXpf: true } } }` — et **jetait leur `method`** :
seule leur somme (`paidXpf`) sortait. Le correctif tient en **un `map` dans le rendu**, sans une
requête de plus.
⚠️ **« Le moteur ne sait pas le faire » se vérifie DANS LA ROUTE, pas dans un rapport.**

**Purement additif** : aucune requête supplémentaire (**pas de N+1**), aucun champ existant modifié,
aucun appelant cassé — une surface qui ignore `payments` marche à l'identique.
⚠️ On rend **la LISTE** des paiements, pas un moyen unique : une vente peut porter **plusieurs**
paiements (part carte + part espèces). Réduire à un seul obligerait à en choisir un arbitrairement
et ferait **mentir le total**. C'est à l'appelant d'agréger.

**Preuves** : `main` = `d4f75a3` · release **`20260810-214639`** · `/api/health` **200** ·
**71 tests** verts · `tsc` 0 · build vert · **vérifié en production** — la route rend
`payments:[{"method":"CARD","amountXpf":3100}]`.

**Nouveau test de contrat** : `core/lib/sales-list-route.test.ts` (8 assertions, même méthode que
`sale-read-route.test.ts` — on lit le source, le runner ne peut pas exécuter un route handler).
Il attrape : clé de service retirée · `withTenant` retiré (un salon lirait les tickets d'un autre) ·
**`payments` retiré du rendu** (la ventilation redeviendrait muette **sans erreur**) · un
`amountXpf` sans `xpf()` (un BigInt brut fait **LEVER** `NextResponse.json` → 500, le journal se
vide **sans message**) · `paidXpf` conservé · **garde anti-N+1**.

🛠️ **Lecture directe hors application**, pour un contrôle ou un doute :
`ssh deploy@46.250.245.33 "bash /home/deploy/ventilation-paiements.sh v-cut"` (accepte aussi
`oneiti` et `ellement`). Le `set_config` du tenant y est **obligatoire** : la RLS est FORCÉE, sans
contexte la requête rend **zéro ligne** — ce qui ressemble à « pas de données » alors que c'est le
cloisonnement qui répond.

## ✅ ÉCART DE CAISSE — LA MIGRATION EST APPLIQUÉE EN PROD DEPUIS LE 2026-08-05, LE CODE PART MAINTENANT (2026-08-10)

> 🗣️ **Marco, 2026-08-10, arbitrage `AskUserQuestion` sur le chantier caisse/compta : « GO —
> appliquer et livrer ».** Mesure faite avant d'agir : **« appliquer » était déjà fait.** Il ne
> restait que « livrer », qui est du **code**, donc **réversible**.

**⛔ Le bloc « LA MIGRATION N'EST PAS APPLIQUÉE » plus bas est PÉRIMÉ.** Il décrivait l'état du
2026-08-05 18:15 ; le geste `migrate` du canal ops a abouti **le même soir**. Ce brief l'a affirmé
faux pendant cinq jours, et le brief de V-Cut a repris l'erreur — d'où un diagnostic qui classait
`CashMovement` comme « à décider » alors que la partie irréversible était derrière nous.

**Relevé en base de production, le 2026-08-10** *(rôle de lecture `core_caisse_app`)* :

| Contrôle | Mesuré |
|---|---|
| `to_regclass('public."CashMovement"')` | **la table existe** |
| Propriétaire | **`core_caisse_owner`** — pas `postgres` (le piège symétrique est évité) |
| `relrowsecurity` / `relforcerowsecurity` | **`t` / `t`** — RLS active **et forcée** |
| `pg_policies` | **`tenant_isolation`**, `cmd=ALL` |
| `_prisma_migrations` | `20260805180000_cash_movement` — un essai **rolled_back** à 18:18:34, puis **`finished_at` 23:59:58** |
| **Isolation PROUVÉE** | `select count(*)` **sans contexte de tenant** → **`0`**. Ce n'est pas « table vide », c'est **le cloisonnement qui répond**. |

**Ce que le déploiement du code change aujourd'hui : RIEN, tant que personne n'enregistre un
mouvement.** `expectedCashXpf` vaut `openingFloat + cashSales + net(movements)`
(`core/lib/cash-movement.ts:68-74`) et la table est **vide** ⇒ `net = 0` ⇒ **le Z est identique à
celui d'hier**. C'est ce qui rend ce ship sûr : il n'y a pas de bascule de calcul, il y a
l'apparition d'une capacité.

### ✅ LIVRÉ — PR #14 mergée et déployée le 2026-08-10 09:32

| | Mesuré, pas supposé |
|---|---|
| `main` | `c99b9b8` |
| Release | `20260810-093227` · `.released_sha` = `c99b9b8…` |
| Santé | `/api/health` → **200** `{ok:true, db:true, rlsEnabled:true, rlsForced:true, deps:{compta:"up", stock:"up"}}` |
| La route | `GET /api/movements` → **405** (méthode refusée = **la route existe**, seul `POST` est défini) — contre **404** sur une route inventée, témoin de contrôle |
| pm2 | `core-caisse` **online** |
| Local avant ship | **63 tests verts** (dont **22** sur `cash-movement`), `tsc --noEmit` **0**, `next build` vert |

⚠️ **Le gate de réversibilité a refusé le premier ship** (`IRREVERSIBLE (schema Prisma). Rien
deploye.`) — il compare le diff `déployé..cible` et y voit `prisma/`. **C'est le gate qui a raison
sur la forme** : il ne peut pas savoir qu'une migration a déjà tourné. Le passage en
`--confirm-schema` n'a été fait **qu'après avoir mesuré la base** (tableau ci-dessus), pas pour
faire taire l'alerte. ⚠️ **`--confirm-schema` n'applique RIEN** : son seul effet est de laisser
passer le ship du code. Ne jamais le lire comme « le pipeline s'occupe de la migration ».

⚠️ **Ce que la prod servait AVANT ce ship** : HEAD du checkout `642a17c` (merge PR #8), **aucune
route `movements`**. La capacité est donc neuve à l'écran comme au réseau.

🛑 **CE QUI RESTE, ET C'EST L'ESSENTIEL : AUCUNE SURFACE N'APPELLE ENCORE CETTE ROUTE.** Le moteur
sait enregistrer un mouvement de tiroir ; **aucun écran ne le propose**. Tant que ce n'est pas fait,
un remboursement en espèces produit toujours un écart muet au Z — le trou fonctionnel n'est pas
refermé, il est seulement **devenu refermable**. Prochain lot : V-Cut, Onéiti, Ellément.

🕳️ **La leçon, et elle vaut pour tout l'écosystème** : ce dépôt a porté simultanément trois états
contradictoires — *un brief qui dit « rien n'est écrit »*, *une branche de 967 lignes qui
l'implémente*, *une base de prod où la migration est appliquée*. **Aucun des trois n'était
mensonger au moment où il a été écrit ; deux n'ont jamais été relus.** Ne jamais conclure sur un
brief : `_prisma_migrations` et `pg_class` sont l'autorité (règle 4).

## ✅ LIVRÉ — PR #11 mergée et déployée (2026-08-05 17:27)

`GET /api/sales/:id` **tourne en production**. C'était le chaînon manquant : sans lui, l'avoir ne
peut pas rendre le stock (la facture Core-Compta ne porte pas les `productId`, seule la vente les
connaît).

| | Mesuré, pas supposé |
|---|---|
| `main` | `bbc7599` (merge PR #11) |
| Release | `20260805-172726` · `.released_sha` = `bbc7599…` |
| Santé | `/api/health` → 200 `{ok:true, db:true, rlsEnabled:true, rlsForced:true, deps:{compta:"up", stock:"up"}}` |
| La route | `GET /api/sales/:id` sans clé de service → **401** (servie et gardée ; elle n'existait pas avant) |

**Le blocage annoncé le 04/08 n'existait plus.** Le verrou disait « gate de réversibilité refusé
(exit 10) : migrations Prisma jamais appliquées en prod ». Mesuré en frais le 05/08 : la prod était
à `09efd7d1`, et `git diff --name-only 09efd7d1 origin/claude/sale-read-route` ne rend que
`AGENT_BRIEF.md` + la route. **Aucune migration.** Réversible → livré sans décision Marco (§8).

**Ce que la branche n'avait pas, et qu'elle a maintenant : un test.** Elle livrait 66 lignes sans
une assertion, et les « 35/35 » étaient exactement les 35 de `main`. Ajouté :
`core/lib/sale-read-route.test.ts` — 6 assertions qui figent le contrat (clé de service exigée,
borne tenant, **tout montant sérialisé par `xpf()`**, lignes avec `productId`/`qty`/`kind`, 404 sur
inconnu). **41/41 verts.**

> 🔎 **Un piège attrapé en écrivant ce test, à connaître.** La première version cherchait la ligne
> du champ par sous-chaîne — or `subtotalXpf:` **contient** `totalXpf:`, donc l'assertion validait
> la mauvaise ligne et **la mutation de contrôle passait inaperçue**. Le test était décoratif.
> Ancré en début de propriété, re-vérifié par deux mutations (retirer `xpf()`, retirer la garde) :
> il tombe. *Un test qu'on n'a pas vu échouer ne prouve rien.*

---

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

- 2026-09-07 — ci.yml : paths-ignore (docs/briefs/workflows) + certificat ci-local dans la PR = pas de run GitHub. Zero minute depuis le poste.

## Dernières actions (2026-07-20)
- 🧹 **Ménage des branches `claude/*`, 2ᵉ passe : 4 → 3 sur ce remote**
  (2026-08-05, chantier écosystème ordonné par Marco. **Aucune ligne de code n'a quitté le dépôt**,
  rien n'a été déployé, la branche par défaut n'a pas bougé.)
  📐 Même méthode qu'au 04/08, à l'identique : miroir **jetable neuf**, mesure **sur le CONTENU** —
  **T1** (tout chemin touché est byte-identique sur la base) ou **T2** (100 % des lignes ajoutées non
  triviales retrouvées dans la version base du même fichier). Jamais le nom de la branche, jamais
  `merge-base`, jamais `git branch --merged` : on merge en **squash**, ces deux-là répondent
  « non mergée » sur du contenu absorbé. `git cherry`/patch-id mesuré mais **jamais décisif**.
  🔢 **4 mesurées → 1 supprimée(s) · 1 conservée(s)** (au moins un fichier diverge)
  **· 2 protégée(s)** (branche ouverte, interdiction explicite, ou sommet de moins de 24 h).
  ↩️ **Réversible** : SHA consignés dans
  `00-Archi-NextGen/_queue/branches/purge-20260805/manifeste-01-Core-Caisse-20260805.tsv`, script
  `restaurer-01-Core-Caisse-20260805.sh`. Sauvegarde : miroir `C:\dev\_backup\branch-purge-20260805\01-Core-Caisse.git`.
  ⚠️ Les miroirs du **04/08** sont la sauvegarde des 444 branches de la 1ʳᵉ passe : **ne pas les
  `--refresh`**, cela les prune et rend ces branches irrécupérables depuis eux.

- 🧹 **Ménage des branches `claude/*` : 8 → 4 sur ce remote, mesuré sur le CONTENU**
  (2026-08-04, ordonné par Marco, chantier écosystème. **Aucune ligne de code n'a quitté le dépôt**,
  rien n'a été déployé, `main`/`master` n'a pas bougé.)
  📐 Une branche n'a été supprimée que si son contenu est **intégralement retrouvable sur la base** :
  soit **T1** (tout chemin qu'elle a touché est byte-identique sur la base), soit **T2** (100 % de ses
  lignes ajoutées non triviales sont présentes dans la version base du même fichier). **Jamais** sur le
  nom de la branche, **jamais** sur `merge-base` ni `git branch --merged` — on merge en **squash**, et
  après un squash ces deux-là répondent « non mergée » sur du contenu entièrement absorbé.
  ⚠️ `git cherry` / patch-id a été mesuré mais **refusé comme critère** : il dit « absorbé » pour un
  commit appliqué **puis reverté** en amont.
  🔢 **8 mesurées → 4 supprimées · 1 conservées** (au moins un fichier diverge encore)
  **· 3 protégées** (branche ouverte, interdiction explicite de merge, ou sommet de moins de 24 h).
  ↩️ **Réversible** : chaque suppression est consignée avec son SHA dans
  `00-Archi-NextGen/_queue/branches/purge-20260804/manifeste-01-Core-Caisse-20260804.tsv`, avec un script de
  restauration (`restaurer-01-Core-Caisse-20260804.sh`). Sauvegarde intégrale : clone miroir
  `C:\dev\_backup\branch-purge-20260804\01-Core-Caisse.git`. Rejouable :
  `00-Archi-NextGen/_routine/branches-purge.py`.

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


