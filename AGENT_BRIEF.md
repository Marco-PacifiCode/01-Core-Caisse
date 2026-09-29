# AGENT_BRIEF — 01-Core-Caisse

## En cours

- **Tri des branches (29/09)** : `C:\dev\_backup\branches-inventaire-20260929\par-app\01-Core-Caisse.md` — 3 branche(s) `claude/*` à code unique, sommet antérieur au 08/09 (liste, fichiers divergents, couverture, colonne verdict). **Trier ces branches, puis QCM à Marco ; rien n'est supprimé avant.**

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

## 🎯 2026-09-15 — FIDÉLITÉ (lot C1 : schéma + calculs purs) — ✅ MIGRATION JOUÉE ET PROUVÉE (accord Marco), code livré le 15/09 (PR #46)

Branche `claude/caisse-fidelite-schema-20260916` (worktree jetable `_wt/caisse-fidelite-c1`), tâche
d'exécution cadrée : plan Salon-Reference (fidélité, 3 formes réglables : compteur/visites/points),
lot C1 seulement (schéma + moteur pur). **Ne déploie rien, n'exécute rien contre la base.**

**Schéma** : trois nouveaux modèles dans `core/prisma/schema.prisma` — `LoyaltyProgram` (réglages,
un par marchand), `LoyaltyAccount` (compte fidélité d'une cliente, rattaché à `core_auth
Client.id` par `clientFicheId`, **sans FK**, autre base), `LoyaltyEntry` (journal, jamais de solde
en cache — visites/points/récompenses tous DÉRIVÉS à la lecture). Idempotence par
`(tenantId, ref)`. **Pas de nouvel enum** : `mode`/`kind`/`rewardKind`/`rewardBase`/`pointsBase`
sont des `String`, validés par `core/lib/loyalty.ts`.

🛑 **Migration additive DÉPOSÉE, PAS jouée, aucun accès prod** :
`core/prisma/migrations/20260916120000_loyalty/migration.sql` — uniquement `CREATE TABLE` /
`CREATE INDEX` / `ADD CONSTRAINT` (aucun `ALTER`/`DROP` sur une table existante), générée par
`prisma migrate diff` depuis le schéma de `origin/main`. `prisma/rls.sql` complété (3 tables
ajoutées au tableau, même motif FORCE RLS que les 6 existantes). **Ordre impératif avant tout
déploiement, même esprit que les entrées crédit/bon cadeau ci-dessous** : migration
(`ops.sh migrate core-caisse`, accord Marco) → `rls.sql` rejoué → déploiement de ce Core → C2
(routes/écrans).

**Nouveau `core/lib/loyalty.ts`, pur (sans Prisma)** : `validateProgram`, `nextActivatedAt`,
`pointsForSale`, `rewardDiscountXpf`, `rewardsToCreate`, `expiresAtFor`, `isRewardAvailable`,
`LOYALTY_LINE_PREFIX`. 18 nouveaux tests dans `core/lib/loyalty.test.ts` (`node --test`), tous
verts ; 314 tests au total sur le repo. `tsc --noEmit` et `prisma validate`/`generate` verts.
Contrôle anti-fantôme fait : sabotage de `rewardDiscountXpf` (`base - 1n` → `base`) → le test
« 4 499n » rougit seul → restauré → suite verte.

⚠️ **Complément Marco reçu en cours de lot C1 (après le cadrage initial)** : un bon cadeau ne
rapporte JAMAIS de points, quelle que soit l'assiette. **Vérifié en lisant `core/lib/caisse.ts` et
`Salon-Reference/surface/lib/finance-actions.ts`** : une vente de bon cadeau N'EST PAS un
`LineKind` dédié (l'enum ne connaît que `SERVICE | PRODUCT | OTHER`, et un nouvel enum est exclu) —
c'est une `SaleLine` **ordinaire** de `kind: "OTHER"`, au label libre posé par la surface ; `OTHER`
est partagé avec toute autre ligne divers (remise, frais). **Rien dans `{kind, lineXpf}` ne
distingue donc structurellement une vente de bon d'une autre ligne `OTHER`** — seul
`GiftCard.saleId` (pas une ligne) identifie authentiquement les bons émis par une vente. `pointsForSale`
a donc reçu un 6e paramètre optionnel `giftCardSalesXpf: bigint = 0n` (soustrait de l'assiette
`ALL`), que l'appelant (C2) devra calculer en sommant `GiftCard.amountXpf` des bons émis par la
vente — jamais en inspectant les lignes. Test ajouté : 3 000 F prestations + 10 000 F vente de bon,
assiette `ALL`, 1 pt/100 F → 30 points. **Ce changement de signature n'a pas été validé par un
Lead** : à relire avant C2.

**Ne fait PAS** : C2 (routes, écrans, moteur d'écriture des `LoyaltyEntry`) — hors périmètre de ce
lot, cf. plan §6 piège 2 (C2 avant la migration jouée = 500 sur les routes fidélité).

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

## ⚖️ MARCO TRANCHE : la caisse close ne bloque plus, fenêtre d'1 MOIS (2026-08-26, soir) — ✅ **en production**

🚀 **PR #28 · `main 831c830` · release `20260826-202345` · WEB OK.** Livré après Compta (PR #45),
avant la surface Aurel'Styl (PR #50).

🗣️ **Verbatim** : *« le moyen de paiement n'est pas très important. tant que le montant ne change
pas. corrections jusqu'à 1 mois plus tard. ça se voit au recomptage de la caisse de toute façon. »*

- 🔓 **`SESSION_CLOSED` et `NO_SESSION` sont RETIRÉS.** Une correction reste possible après le Z, et
  sur une vente hors session. Le Z de la journée **n'est pas réécrit** : l'écart se constate au
  recomptage. Session **ouverte** : l'attendu se recalcule normalement (comportement inchangé) ;
  session **close** : figé, on n'y touche pas. Les deux cas sont testés.
- 🐛 **BUG DORMANT SORTI PAR CETTE DÉCISION — `closeSession` mentait.** Il annonce « une session déjà
  CLOSED renvoie son rapport figé », mais `buildReport` posait `expectedXpf` **recalculé à chaud**
  (seuls `closingCountedXpf` et `varianceXpf` venaient de la base). Tant que rien ne bougeait après
  la clôture, l'erreur était invisible. Maintenant qu'une correction peut changer les paiements
  d'une session close, le même écran aurait affiché un attendu et un écart qui ne se répondent plus.
  → `lib/z-report.ts` (`expectedXpfPourRapport`, pure et testée — `closeSession` importe
  `next/headers` via `./tenant` et n'est pas exécutable sous `node --test`). **Le tiroir du soir est
  figé ; `cashSalesXpf`, `byMethod` et `totalSalesXpf` restent recalculés**, et c'est voulu : ils
  décrivent les VENTES, pas le tiroir — c'est cette ventilation-là qu'on veut voir suivre la
  correction. Repli sur le recalcul si `expectedXpf` est `null` (vieille session).
- ⏳ **`TOO_OLD` : fenêtre d'1 MOIS** sur `sale.paidAt ?? sale.createdAt` (`lib/fenetre-correction.ts`).
  **Mois CALENDAIRE** et non 31 jours (« un mois plus tard » se lit sur un calendrier) ; **heure NC = UTC+11 FIXE** — compter en UTC décalait la
  limite d'un jour pour une partie des encaissements ; borne **incluse**. `maintenant` est **injecté**,
  sans quoi les bornes ne se testent pas. ⚠️ **Module JUMEAU dans `01-Core-Compta`** (dépôts séparés,
  aucun paquet partagé) : le modifier ici oblige à le modifier là-bas.
  🔄 **CORRIGÉ le 26/08 au soir (livré : `cbdb29a`) — le quantième DÉBORDE, il n'est plus raboté.** 🗣️ Marco : *« le
  problème du mois calendaire, c'est qu'une erreur faite le 31 n'est pas récupérée le 1er. »* Le
  rabotage au dernier jour du mois cible volait des jours aux quantièmes élevés : le 31 mars
  n'avait que jusqu'au **30 avril**, moins d'un mois — et moins que le 1er du même mois, qui allait
  jusqu'au 1er mai. Désormais : 31 mars → **1er mai**, 31 janv. → **3 mars** (28 fév. + 3),
  bissextile → **2 mars**. Règle : **au moins un mois, jamais moins**. Les deux jumeaux ont été
  changés ENSEMBLE et comparés côte à côte sur cinq cas de bord — limites identiques.
  🪤 Trois tests d'ici s'appuyaient sur le rabotage (dont « 23 h NC ne perd pas un jour », qui
  mêlait fuseau ET débordement) : réécrits pour ne mesurer qu'une chose à la fois.
- ✅ **254 tests** (234 avant), `tsc` 0, build OK. Mutations prouvées : `TOO_OLD` retiré → 3 rouges ;
  31 jours au lieu du mois → 5 rouges ; attendu recalculé sur session close → 1 rouge.
- 📌 `tsconfig.json` gagne `allowImportingTsExtensions` (même raison que côté Compta : un module pur
  qui en importe un autre doit satisfaire `node --test --experimental-strip-types` ET `tsc`).

## 📥 IMPORT DE CLÔTURE Z HORS LIGNE + TGC PAR LIGNE — ÉCRIT, **RIEN D'APPLIQUÉ** (2026-08-23)

Branche `claude/import-z-et-tgc-ligne` (2 commits), poussée, **PR non ouverte, migration non
jouée, aucun déploiement** — tâche d'exécution cadrée, pas de décision prise sur le périmètre.

**Lot A — `POST /api/sessions/import`** : la Rôtisserie de Pouembout encaisse hors ligne, remonte
ses ventes une fois par jour (`sessionId=null`) mais **archive son Z EN LOCAL** — il n'atteignait
jamais ce moteur. Route **SÉPARÉE** du chemin vivant (`openSession`/`closeSession`, **intouchés**,
qui servent Ellément/V-Cut/Onéiti en temps réel) : la tablette est la source de vérité, son Z est
une **pièce déjà établie** qu'on importe telle quelle — pas de rattachement de ventes, pas de
recalcul serveur. `varianceXpf` est **toujours** `closingCountedXpf − expectedXpf` recalculé
serveur, **jamais** repris de l'appelant. Logique pure dans `lib/import-cloture.ts` (même schéma
que `lib/void-sale.ts`) ; persistance idempotente `(tenantId, sourceType, sourceId)` dans
`caisse.ts::importerCloture` (même schéma P2002/relecture qu'`openSession`).

**Lot B — `tgcRatePpm` de ligne traverse jusqu'à Compta.** Il était jeté à 4 endroits (route
`/api/sales`, `SaleLineInput`/`linesData`, `toSnapshot`/`SyncLine`, `runSaleSync`→
`compta.createInvoice`/`InvoiceLineInput`) — Compta l'acceptait déjà côté producteur (Phase 2,
vérifié en frais). Optionnel partout : absent ⇒ `undefined` (champ **absent** du JSON, jamais
`0`, qui signifierait « hors champ TGC »). `contracts.test.ts` complété.

**Migration additive** (à passer par Marco, non jouée) :
`core/prisma/migrations/20260823090000_import_cloture_z/migration.sql` — `CashSession.sourceType`/`sourceId` +
index unique partiel `uniq_session_external_source`, `SaleLine.tgcRatePpm`.

✅ **207 tests** (189 avant, **+18**) · `tsc --noEmit` vert · aucune régression sur les 3
marchands en production (0 ligne existante touchée par le diff de code).

## 🛑 ÉCART DE CAISSE — ÉCRIT ET TESTÉ, **LA MIGRATION N'EST PAS APPLIQUÉE** (2026-08-05 18:15)

Marco a donné le **go** sur l'option `CashMovement` (celle recommandée ci-dessous). Le code est
écrit, testé, poussé. **Rien n'est en production, et rien ne doit y aller avant la migration.**

> 🔗 **PR ouverte, volontairement NON mergée** :
> **https://github.com/Marco-PacifiCode/01-Core-Caisse/pull/14**
> Le code lit `CashMovement`. Le merger avant la migration ferait **planter `closeSession` à
> chaque clôture de Z**. L'ordre n'est pas une préférence.

### Pourquoi je n'ai pas appliqué, alors que j'avais le go

Deux constats, dans cet ordre :

1. Le hook `_hooks/gate-deploy.sh:120` **refuse** la commande d'application (DOCTRINE §8, « migration
   même additive = irréversible »). C'est une contrainte machine, pas une consigne — je ne la
   contourne pas.
2. **Le chemin qu'il propose en remplacement ne fait pas ce qu'il annonce.** Le hook renvoie vers
   `ng-deploy.sh <app> deploy --confirm-schema` en expliquant que « c'est `engine.sh` qui lance
   prisma, en sous-processus ». **C'est inexact** : `engine.sh` ne lance aucun `prisma migrate`.
   Le seul effet de `ALLOW_SCHEMA=1` est, ligne 295, de ne pas sortir en `20` — donc de laisser
   passer **le ship du code**. Vérifié : `grep -n "prisma" engine.sh` ne rend que des commentaires
   et le motif `MIGRATION_GLOB`.

**Conclusion portée plus haut — et traitée le 2026-08-05 (Marco a validé la construction) :** il
n'existait aucun chemin outillé qui applique une migration. Le garde-fou était bon ; c'est la porte
qu'il désignait qui manquait. **Elle existe maintenant.**

### ✅ LE CHEMIN OUTILLÉ EXISTE — geste `migrate` du canal ops (2026-08-05)

`00-Archi-NextGen` PR **#664**, mergée sur `main`. `01-Core-Caisse` en est le **premier client**.

**Ce que Marco fait, et c'est tout :** GitHub > `00-Archi-NextGen` > **Actions** > **Ops** >
*Run workflow* (branche `main`) :

| champ | valeur |
|---|---|
| `geste` | `migrate` |
| `cible` | `core-caisse` |
| `argument` | `20260805180000_cash_movement` |
| `raison` | écart de caisse — PR #14 |

Puis **Review deployments → Approve** (le job d'écriture attend ; **aucune clé SSH n'est montée
avant ce clic**). ⚠️ **Prérequis, une seule fois :** `Settings > Environments > production >
Required reviewers` (s'ajouter). Tant que ce n'est pas fait, le geste **échoue** — comportement
voulu, pas un bug.

> 🔧 **Correction d'un point de ce brief, mesurée sur le VPS le 2026-08-05.** Il était écrit que le
> script appliquait la migration « **sous le rôle applicatif** ». C'est faux, et ça n'aurait pas
> marché : `core_caisse_app` **n'a pas `CREATE` sur `public`**. Le piège est **symétrique** de celui
> qu'on connaissait — `postgres` crée une table que l'app ne peut pas lire, le rôle de l'app ne peut
> rien créer. Le bon rôle est un **troisième**, `core_caisse_owner`, propriétaire de la base, et sa
> connexion est **déjà déclarée** dans le `.env` (`DATABASE_URL_OWNER`). Le geste refuse de partir
> sous tout autre rôle.

Le geste : garde de rôle → **sauvegarde de structure** → application → rejeu de `rls.sql` →
régénération du client → **preuves**. Ces preuves-ci, une seule rouge suffisant à tout arrêter :

| Contrôle | Attendu |
|---|---|
| migration en attente | **exactement** celle nommée dans `argument` (+ `sha256` du fichier imprimé) — refus sinon |
| table `CashMovement` présente | oui, et **propriétaire = `core_caisse_owner`** |
| droits DML de `core_caisse_app` | `SELECT`/`INSERT`/`UPDATE`/`DELETE` — ils viennent des `DEFAULT PRIVILEGES` du propriétaire, qui ne jouent **que** si c'est bien lui qui a créé la table |
| `relrowsecurity` **et** `relforcerowsecurity` | `t` sur **toute** table portant `tenantId`, pas seulement la neuve — c'est ce qui attrape une table oubliée dans `rls.sql` |
| policy `tenant_isolation` | présente |
| **lecture SANS contexte de tenant, sous le rôle APPLICATIF** | **0 ligne**, et le geste dit si la table est **peuplée** — seul cas où « 0 » veut dire *cloisonné* et non *vide* |

> ⚠️ **Pourquoi la preuve se fait sous le rôle applicatif et jamais sous le propriétaire** (mesuré le
> 2026-08-05) : sous `core_caisse_owner`, `SELECT count(*) FROM "Sale"` sans contexte de tenant rend
> **13** lignes — non pas que la RLS manque (elle est `ENABLE` **et** `FORCE`, et le rôle n'a ni
> `SUPERUSER` ni `BYPASSRLS`), mais parce que la policy `cron_sweep_read` (balayage de reprise,
> légitime) est `PERMISSIVE` et **s'ajoute**. Sous `core_caisse_app`, la même lecture rend **0**.
> Une preuve faite sous le propriétaire serait faussement rouge — ou, sur une table vide,
> **faussement verte**.

Si une seule échoue : `exit 1`, état rapporté, **et le code ne part pas**. Et si l'application
échoue, le geste compare la structure à celle d'avant : identique ⇒ il **solde** la ligne restée en
échec (`resolve --rolled-back`), qui sinon **bloquerait toutes les migrations suivantes** — c'est
exactement ce qui a dû être réparé à la main le 05/08.

**Ensuite seulement** : merger la PR #14, puis
`ng-deploy.sh core-caisse deploy main --confirm-schema` (le `--confirm-schema` ne fait que **laisser
passer le ship du code** : la base, elle, est déjà à jour à ce stade).

### État réel de la base au 2026-08-05 07:52Z (mesuré, pas supposé)

- `CashMovement` : **n'existe pas**. `to_regclass` → vide.
- `_prisma_migrations` : 3 lignes appliquées + `20260805180000_cash_movement` en `rolled_back`
  (trace de la tentative arrêtée, **soldée** — elle ne bloque rien, Prisma la ré-appliquera).
- Les fichiers sur le VPS (`schema.prisma`, `rls.sql`, `migration.sql`) ont le **sha256 identique**
  à ceux de la branche `claude/cash-movement-ecart-caisse`. Rien à re-copier.
- ⚠️ Le commentaire en tête de `migration.sql` dit encore « à appliquer sous le rôle applicatif » :
  **c'est faux** (cf. plus haut). Volontairement **non corrigé** — on ne touche pas au fichier qui
  est sur le point d'être appliqué, et il est inerte. À corriger après application.

### Sauvegarde — faite avant toute tentative

`C:\dev\_backup\2026-08-05-core-caisse-cashmovement\` — structure (`pg_dump -s`) + relevé de
l'état RLS des 5 tables **avant**.

> 🔎 **Le dump des DONNÉES est impossible sous le rôle applicatif**, et c'est une bonne nouvelle :
> `pg_dump` s'arrête sur *« query would be affected by row-level security policy for table
> CashSession »*. **`FORCE ROW LEVEL SECURITY` fonctionne, constaté en direct.** Pour une migration
> additive pure, la structure est de toute façon la sauvegarde pertinente — aucune ligne existante
> n'est touchée et le rollback est un `DROP TABLE`.

### Ce qui a été vérifié après le refus du hook

La base est **intacte** : `CashMovement` n'existe pas, `_prisma_migrations` porte toujours ses
**3** lignes. **Aucune DDL n'a tourné.**

### Ce qui est livré dans la PR #14

| Fichier | Rôle |
|---|---|
| `prisma/schema.prisma` | `enum CashMovementKind` + `model CashMovement`. `amountXpf` **toujours positif** : le sens vient du `kind`, jamais du signe — le reste du moteur suppose des montants positifs (`normalizePayments` écrase les ≤ 0) et on ne fabrique pas d'exception |
| `prisma/migrations/20260805180000_cash_movement/` | additive pure. FK en `RESTRICT` et non `CASCADE` : emporter en silence les mouvements qui expliquent un écart serait la « mine désamorcée mais pas déminée » relevée ailleurs |
| `prisma/rls.sql` | `'CashMovement'` ajouté à la liste → `ENABLE` + `FORCE` + policy, comme les 4 autres |
| `lib/cash-movement.ts` | règles **pures** : sens, agrégation, validation |
| `lib/caisse.ts` | `closeSession` agrège les mouvements · `ZReport` gagne 3 postes · `recordCashMovement` |
| `app/api/movements/route.ts` | S2S. **409 `NO_OPEN_SESSION`** |

**`@@unique([tenantId, ref])`** : un avoir ne se rembourse qu'**une** fois, garanti **en base** et
pas seulement au clic — `P2002` rattrape la course et rend le mouvement existant. *(C'est
exactement ce qui manque au garde anti-double-règlement des factures, trou n°5 de `MAP-ARGENT`.)*

**Le 409 est le dispositif, pas une limitation.** Pas de session ouverte ⇒ pas de mouvement :
l'écrire quand même le rendrait invisible de tout Z, ce qui **déplacerait** l'écart muet au lieu de
le supprimer. Le refus force le bon geste (« ouvrez une session de caisse pour rembourser en
espèces ») — c'est **lui** qui fait que le Z se ferme juste tout seul.

### Les tests (22 neufs, 63/63 verts, `tsc` 0 erreur)

Non-régression au franc près quand il n'y a aucun mouvement · le cas de Marco (3 000 F rendus →
attendu qui baisse de 3 000, **écart nul** quand la caissière compte le tiroir réel) · apports et
prélèvements dans le bon sens · `bigint`, au-delà de 2^31 · **le CA ne peut pas bouger** (il n'est
même pas une entrée de la fonction — ce test fige la séparation) · zéro/négatif/centime refusés ·
`ref` vide ⇒ `null`, sinon `@@unique` bloquerait au deuxième mouvement sans référence.

> ✅ **3 mutations de contrôle** : sens du `REFUND` inversé (**6 tests tombent**), montant négatif
> accepté (**1**), `ref` vide non normalisée (**1**).

### ⚠️ Ce qui N'EST PAS fait, et qui demande une coordination

**Le déclenchement depuis les surfaces n'est pas écrit.** Pour qu'un avoir remboursé en espèces
crée le mouvement, il faut modifier `surface/lib/finance-actions.ts` — **le fichier même qu'un
autre chantier est en train de modifier dans V-Cut** (remise / prix modifiable / droits staff,
arbre sale constaté le 2026-08-05). Signalé plutôt que livré en se croisant.

Il reste aussi une question de produit, **non tranchée** : comment sait-on qu'un avoir est remboursé
**en espèces** ? Le déduire du moyen de paiement d'origine serait une déduction — donc à écarter.
Il faut le **demander** à l'opératrice au moment de l'avoir (un choix : espèces / CB / virement).
Seul le choix « espèces » écrit un mouvement ; les autres ne touchent pas le tiroir.

---

## 🎯 LA CONCEPTION QUI A MENÉ À CE CHOIX — l'écart de caisse d'un remboursement

> **STATUT : l'option 2 a reçu le GO de Marco et elle est ÉCRITE** (PR #14, non mergée — la
> migration n'est pas appliquée, cf. section ci-dessus). Cette section est conservée telle
> qu'elle a été rendue : elle porte le raisonnement, et surtout **ce qui a été écarté et
> pourquoi** — c'est ce qu'on regrette de ne pas retrouver six mois plus tard.

### Le problème, en une phrase

Un salon rembourse 3 000 F en espèces sur un avoir. Le soir, le tiroir est court de 3 000 F et
**aucune ligne de l'application ne l'explique** : l'écart apparaît comme une erreur de caisse
anonyme. Marco refuse l'écart muet — il veut que **le Z se ferme juste tout seul**.

### Ce que le moteur sait déjà faire (lu, pas supposé)

```
expectedXpf = openingFloatXpf + Σ SalePayment.amountXpf   (method='CASH', Sale.status='PAID',
                                                           Sale.sessionId = la session)
varianceXpf = closingCountedXpf − expectedXpf
```
`lib/caisse.ts:91-107` et `:130`. **Rien d'autre n'entre dans l'attendu.**

- ❌ **Aucun mouvement de tiroir n'existe**, sous aucune forme : ni sortie, ni apport, ni
  prélèvement. Recherche exhaustive sur `movement|cashIn|cashOut|drawer|tiroir|refund|rembours|
  avoir|credit` → zéro occurrence désignant un mouvement de caisse (les `movement` du code sont les
  mouvements de **stock** sortants vers Core-Stock).
- ✅ Les montants sont **tous `BigInt`**, sans contrainte de signe en base (aucun `CHECK`).
- ⚠️ `normalizePayments` (`lib/money.ts:57-58`) **écrase tout montant ≤ 0** : un `SalePayment`
  négatif est donc impossible **par le chemin d'encaissement**, mais pas en base.
- 🔒 Une session **`CLOSED` ne recalcule jamais** son `varianceXpf` (`lib/caisse.ts:121-128`). Un
  événement postérieur ne peut pas corriger un Z passé, seulement en produire un nouveau.

**Corollaire qui tranche une question d'emblée :** un remboursement s'impute **sur la session
ouverte du jour où l'argent sort du tiroir**, jamais sur la session d'origine. Ce n'est pas un
choix de confort : la session d'origine est close et son écart est figé — il n'y a pas d'autre voie.

### Les trois options, et pourquoi je n'en recommande qu'une

#### Option 1 — « vente d'avoir » négative · **zéro migration**

Créer une `Sale` de total négatif, `PAID`, rattachée à la session du jour, portant un
`SalePayment{method:'CASH', amountXpf: −3000}`. Le Z se corrige seul, sans toucher `closeSession`.

- ✅ **Aucune migration.** Livrable comme réversible, tout de suite.
- 🔴 **Elle fausse le chiffre d'affaires — exactement ce que Marco a exclu.** `totalSalesXpf` est
  la somme des `Sale.totalXpf` : une vente négative fait **baisser le CA du jour**, et
  `salesCount` compte un ticket de plus qui n'est pas une vente.
- 🔴 **Elle injecte du négatif dans un modèle dont tout le reste suppose du positif** :
  `normalizePayments` écrase les ≤ 0, `checkoutSale` refuse `UNDERPAID`, `lineTotalXpf` multiplie.
  Il faudrait un chemin d'écriture qui contourne ces gardes — c'est-à-dire les affaiblir.
- 🔴 **Piège de synchro, et il coûte de l'argent.** L'index partiel `idx_sale_sync_pending`
  (`prisma/rls.sql:55-59`) sélectionne les `Sale` `PAID` dont `comptaSyncedAt IS NULL`. Une vente
  d'avoir y tomberait, et le **cron de rattrapage** (toutes les 15 min) tenterait de lui **créer
  une facture** — soit une seconde pièce comptable pour un avoir qui en a déjà une. Contournable
  en posant les dates de synchro à la création, mais c'est une chausse-trappe pour le prochain.

> 📌 **`CashMovement` sert un SECOND chantier, découvert le 2026-08-06** (question de Marco sur le
> bouton « Honoré » de V-Cut, conception dans `V-Cut/AGENT_BRIEF.md`). Marco veut matérialiser la
> **cliente venue qui n'a pas payé** — « *un ticket en attente de paiement* ». Or la Caisse ne sait pas
> faire de vente à crédit (`DRAFT|PAID|VOID` + `UNDERPAID` 409, `lib/caisse.ts:447-500`), et régler la
> créance depuis l'écran Compta ferait entrer l'argent **hors du Z** — le trou décrit ici, à l'identique.
> **Même cause, même remède** : un `kind` supplémentaire (encaissement d'une facture due) sur ce modèle
> règle les deux. Argument de plus pour l'option 2 — elle n'est plus au service d'un seul cas.
> *(Rien n'est engagé : la migration attend toujours le go de Marco.)*

#### Option 2 — `CashMovement`, un vrai mouvement de tiroir · **une migration additive** ⭐ RECOMMANDÉE

```prisma
enum CashMovementKind {
  REFUND      // remboursement d'un avoir : l'argent sort pour la cliente
  CASH_OUT    // prélèvement (dépôt en banque, achat)
  CASH_IN     // apport de fond en cours de journée
}

model CashMovement {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @db.Uuid
  sessionId     String   @db.Uuid           // OBLIGATOIRE : un mouvement hors session
  session       CashSession @relation(...)  //   serait invisible du Z, donc inutile
  kind          CashMovementKind
  amountXpf     BigInt                      // TOUJOURS POSITIF ; le sens vient de `kind`
  reason        String                      // obligatoire — un écart doit être justifié
  ref           String?                     // n° d'avoir (AVO-2026-0001) quand kind=REFUND
  createdBy     String?                     // qui a ouvert le tiroir
  createdByName String?
  createdAt     DateTime @default(now())
  @@index([tenantId, sessionId])
  @@unique([tenantId, ref])                 // un avoir ne se rembourse qu'une fois
}
```

Le Z devient :
```
expectedXpf = openingFloatXpf + cashSalesXpf + cashInXpf − cashOutXpf − refundsXpf
```
et `ZReport` gagne **trois champs distincts** (`refundsXpf`, `cashInXpf`, `cashOutXpf`) —
`totalSalesXpf` **ne bouge pas d'un franc**.

- ✅ **Le CA n'est pas touché.** C'est la demande de Marco, mot pour mot : le Z se ferme juste
  *sans inventer une écriture qui fausse le chiffre d'affaires*. Trésorerie et chiffre d'affaires
  restent deux choses différentes, parce qu'elles le sont.
- ✅ **L'écart cesse d'être anonyme** : le Z du soir affiche « Remboursements : −3 000 F (avoir
  AVO-2026-0001) » au lieu d'un manquant inexpliqué.
- ✅ **`@@unique([tenantId, ref])` empêche EN BASE de rembourser deux fois le même avoir** — une
  garantie, pas une vérification applicative. *(À comparer au trou n°5 de `MAP-ARGENT` : le garde
  anti-double-règlement des factures, lui, n'a aucun index unique.)*
- ✅ **`createdBy` est journalisé.** Ça répond, côté caisse et **sans migration compta**, à une
  partie de la réserve « un avoir ne dira jamais qui l'a émis ».
- ✅ Extensible aux besoins réels d'un salon (prélever la recette pour la banque, remettre du fond).
- ❌ **Une migration de schéma** → irréversible au sens du §8 → **elle ne s'applique pas sans
  Marco**. C'est le seul coût, et il est réel.

**Ordre imposé si Marco dit oui :** la migration s'applique **avant** le code (du code qui lit une
table absente plante au démarrage). Donc migration en rôle owner → puis `ng-deploy core-caisse`.

#### Option 3 — assumer l'écart et demander au salon de le noter à la main

C'est l'état actuel. **Écarté par Marco le 2026-08-05.**

### Ce que l'option 2 exige, en clair

1. La migration ci-dessus — **Marco l'applique, pas l'agent.**
2. `lib/caisse.ts` : `closeSession` agrège les mouvements ; `ZReport` gagne 3 champs.
3. `POST /api/sessions/:id/movements` (S2S, `X-Core-Key`) — refuse si la session est `CLOSED`, et
   **refuse s'il n'y a aucune session ouverte** : c'est ce refus qui rend le Z juste *tout seul*
   (« ouvrez une session de caisse pour rembourser en espèces »).
4. Les 3 surfaces : après un avoir réussi **payé en espèces**, poster le mouvement. Un avoir
   remboursé par CB ou virement **ne touche pas le tiroir** → aucun mouvement.
5. Les tests, écrits **avant** la livraison, sur le patron de ceux du geste d'avoir : le Z
   avec/sans mouvements, le refus hors session, l'unicité par `ref`, `bigint` partout, et le fait
   que `totalSalesXpf` **ne bouge pas**.

### Ce qui reste ouvert, et que je ne tranche pas

- **Le remboursement partiel** (rendre 2 000 sur un avoir de 3 000) : le modèle le permet
  (`amountXpf` libre), l'écran non. À décider si le besoin existe.
- **Le symétrique** — trou n°3 de `MAP-ARGENT` : encaisser une facture depuis l'écran Compta
  échappe aussi au Z (tiroir **long**, cette fois). Le même `CashMovement` (`CASH_IN`) le
  refermerait. Hors périmètre de ce chantier, mais c'est la même serrure.

---

## Modèles (Prisma, tenantId + RLS)

`CashSession` (fond de caisse, clôture Z : `expectedXpf`/`closingCountedXpf`/`varianceXpf`, OPEN/CLOSED) ·
`Sale` (DRAFT/PAID/VOID, totaux XPF BigInt figés, `sourceType`/`sourceId`, `invoiceId`/`invoiceNumber`) ·
`SaleLine` (kind SERVICE/PRODUCT/OTHER, `productId?`, qty, unitXpf, lineXpf) ·
`SalePayment` (method CASH/CARD/TRANSFER/CHEQUE/OTHER, amountXpf, `tenderedXpf?`, `settleRef` ; mixte).
Index unique **partiel** `uniq_sale_external_source` (RLS SQL) pour l'idempotence des ventes sourcées.
**Sale porte l'état de synchro** (migration additive `20260702220000_sale_sync_state`, backfill des
PAID existantes) : `comptaSyncedAt?`/`stockSyncedAt?`/`syncError?`/`syncAttempts` — « à réparer » ⇔
PAID + un des deux timestamps NULL (index partiel `idx_sale_sync_pending` dans rls.sql).

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

## 🗄️ Historique archivé

- 2026-09-29 : 20 section(s) datée(s) avant le 2026-09-15 → `AGENT_BRIEF_ARCHIVE.md` (déplacées telles quelles ; `grep -n '^## ' AGENT_BRIEF_ARCHIVE.md`).
