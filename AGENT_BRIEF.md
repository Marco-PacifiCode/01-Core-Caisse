# AGENT_BRIEF — 01-Core-Caisse

## 🔒 PAS DE VENTE SANS CAISSE OUVERTE — **PR OUVERTE, RIEN DE DÉPLOYÉ** (2026-09-01)

> 🗣️ **Marco, 2026-09-01** : *« un encaissement ne devrait pas être possible sans ouvrir de caisse.
> aujourd'hui chez Ellément, son premier rdv n'est pas inscrit en caisse. »* puis, après arbitrage du
> périmètre : *« il faut seulement que la caisse soit ouverte pour encaisser à partir de maintenant. »*

🛑 **NON DÉPLOYÉ, ET CE N'EST PAS UN OUBLI.** C'est de l'argent : une garde mal posée bloque un
encaissement réel au comptoir. Marco voit la forme avant. Branche `claude/session-obligatoire`.

### Le trou

`Sale.sessionId` est **nullable** et personne ne le remplissait de force. Une vente sans session
n'entre dans **aucun Z** (`closeSession` filtre `sessionId = <la session>`) : elle est encaissée,
facturée côté Compta, et **absente de la clôture de caisse**. Mesuré en production le 2026-09-01 :
**4 ventes / 28 700 F** sur trois salons (Onéiti 2 · AurelStyl 1 · Ellément 1). Chez Ellément, ticket
créé à **10h22**, session ouverte à **10h25** — **trois minutes**.

### ⚠️ Il avait DEUX causes, et une seule se voit

1. **Aucune session ouverte** — le cas d'Ellément. Visible, racontable.
2. **Une session est ouverte, mais l'écran ne le sait pas.** Les cinq surfaces dérivent le
   `sessionId` au chargement de `app/app/admin/page.tsx` par un appel S2S `GET /api/sessions`
   terminé par **`.catch(() => null)`**. Moteur qui hoquette, clé S2S en défaut, page chargée avant
   l'ouverture de la caisse → la surface envoie `null` **alors que la session existe**. Aucun écran
   ne peut corriger ça : l'écran est justement celui qui se trompe.

➡️ D'où la forme retenue : **le `sessionId` de l'appelant n'est plus une consigne, c'est une
proposition.** Le moteur relit, tranche, et ne refuse qu'en dernier recours.

### 🔎 Pourquoi V-Cut n'a AUCUNE vente hors session — ce n'est PAS le code

Mesuré par quatre méthodes indépendantes (hash du corps de `checkoutTicket` **identique** sur les 5
surfaces, `diff -u` de `TicketLauncher.tsx`, de `admin/page.tsx`, de `CaisseManager.tsx`) :
**il n'existe aucune différence de code entre V-Cut et les quatre autres.** Le trou est le même
partout, à la ligne près. **V-Cut est propre par USAGE** : sa caisse est ouverte en permanence
(déjà constaté en prod la semaine du 4 août, cf. `01-Core-RDV`). La discipline d'un salon n'est pas
une garde — c'est pour ça qu'il en fallait une.

### La garde, telle qu'elle est posée

**Au moteur, dans `createSale` — le SEUL point d'écriture d'une vente du dépôt** (confirmé deux fois,
par motif et par inspection fichier par fichier : un unique `tx.sale.create`, et une unique route
`POST /api/sales`). Une garde d'écran n'aurait couvert qu'un chemin sur cinq.

Règle pure et testée dans **`core/lib/session-obligatoire.ts`** — l'ordre des quatre cas EST la
décision :
1. **remontée différée** → exemptée (jamais refusée) ;
2. session proposée et **OUVERTE** → gardée ;
3. sinon, **caisse ouverte du moment** → le moteur **estampille** *(c'est ce qui ferme la cause n°2)* ;
4. sinon → **refus `NO_OPEN_SESSION`**, **avant** toute écriture.

`POST /api/sales` répond **409** (et non 400) : « l'état du serveur s'y oppose », pas « ta requête est
malformée » — c'est ce que l'écran distingue pour proposer d'ouvrir la caisse.

### 🛑 La forme non bloquante — c'est la moitié qui compte

Un refus sec à une cliente carte à la main serait **pire que le trou**. Côté surface
(`TicketLauncher.tsx`), le 409 fait apparaître, **dans la fenêtre de paiement** : « La caisse n'est
pas ouverte » + **fond de caisse** + **« Ouvrir la caisse et encaisser »** → `openCashSession` puis
**rejeu à l'identique**. Le ticket reste ouvert, les montants restent saisis, **rien n'est à
ressaisir**. Rejouer est sûr : le refus n'a rien écrit, et l'idempotence `("rdv", appointmentId)`
tient de toute façon. Le fond de caisse est demandé **explicitement** (`0` accepté, vide refusé) : le
deviner à 0 fabriquerait un écart dès le premier Z.

### 🪤 Ce qui aurait cassé un marchand EN PRODUCTION

**La Rôtisserie de Pouembout** (`rotisserie-surface`, pm2, en ligne) encaisse **hors ligne**, tient
son Z **en local**, et remonte ses ventes une fois par jour **avec `sessionId` nul, délibérément**.
Une garde nue lui aurait refusé **chaque ticket**, en silence (`echecs.push`), tickets bloqués sur la
tablette, invisible jusqu'à la compta du mois.
→ **Exemption sur DEUX marqueurs indépendants** : `occurredAt` **ou** le nouveau `horsSession: true`.
Il faut que **les deux manquent** pour que la garde morde. Le second existe parce que le premier ne
suffit pas : la Rôtisserie tire `occurredAt` d'un champ **facultatif** de sa tablette
(`horodatage?: string` → `?? null`).

### 🚨 DEUX SURFACES EN PRODUCTION QUE PERSONNE N'AVAIT LISTÉES — **à trancher AVANT de merger**

Trouvées par un **second** balayage, à la fin du lot, sur **tous** les dépôts de l'écosystème (le
premier ratissage ne couvrait que les 5 salons + les Cores). **Ce moteur est mutualisé : la garde
s'applique à elles aussi, et elles n'ont pas la forme non bloquante.**

| Surface | pm2 | Ce qui se passe au merge du moteur |
|---|---|---|
| **`Pacifik`** (Le Pacifik Koné) | `pacifik-surface` **en ligne** | `surface/lib/caisse-actions.ts` **`creerNote`** poste `/api/sales` **sans `sessionId`, sans `occurredAt`, sans `horsSession`** → **refusé** si aucune caisse n'est ouverte. Message affiché : le texte brut du moteur (`corpsErreur` rend `corps.error`) → **« NO_OPEN_SESSION »** à l'écran. |
| **`ArtDuSoin`** | `lartdusoin-surface` **en ligne** | Même patron `checkoutTicket` que les 5 salons (`finance-actions.ts:583`, `sessionId: input.sessionId ?? undefined`) → refus possible, et **`created.error` brut** affiché. C'est un **PROSPECT**, hors périmètre d'unification (Marco, 22/08) — donc hors du lot, mais **pas hors du moteur**. |

⚠️ **Et pour le Pacifik, ce n'est pas qu'une question de message.** Le geste refusé serait
**« ouvrir une note de table »**, pas un encaissement : dans un restaurant on ouvre la note, on
encaisse plus tard. 🗣️ Marco a demandé *« que la caisse soit ouverte pour **encaisser** »*. Refuser
l'ouverture d'une note va **plus loin** que la demande.

**Ce que je n'ai pas fait, et pourquoi.** Ni l'un ni l'autre n'est dans le périmètre qu'on m'a donné
(« les 5 surfaces »), et élargir seul le rayon d'action d'une garde d'argent sur deux commerces en
production n'est pas une décision d'agent. **Trois issues possibles, Marco tranche :**
1. **porter la forme non bloquante** aux deux (le patron existe, c'est mécanique) ;
2. **les exempter** — `horsSession: true` sur `creerNote` du Pacifik (une note de table n'est pas un
   encaissement), et laisser ArtDuSoin tel quel tant qu'il est prospect ;
3. **assumer le refus** en n'améliorant que le message.

### ⛔ ORDRE DE DÉPLOIEMENT — non négociable

**1. `Rotisserie-Pouembout`** (PR `claude/hors-session-explicite`) · **2. les 5 surfaces** ·
**3. CE MOTEUR, en dernier.**
Chaque étape est **inerte** tant que la suivante n'est pas là (un champ inconnu de `POST /api/sales`
est ignoré ; un 409 que le moteur n'émet pas encore n'est jamais reçu). **Livrer le moteur en premier
casse la Rôtisserie et met un mur au comptoir des salons.**

### Vérifié

- **CI locale GREEN** (`ci-local.sh core-caisse`, exit 0, 5 étapes) · `tsc --noEmit` **0 erreur** ·
  **273 tests / 273 pass** (255 avant, **+18**).
- **Mutations prouvées rouges** : garde neutralisée → **3 rouges** · ordre des règles inversé →
  **1 rouge** · `return` de refus supprimé de `createSale` → **1 rouge**.
- 🪤 **Ce troisième test a été FAUX une heure**, et c'est la leçon du lot : il s'ancrait sur la chaîne
  `error: "NO_OPEN_SESSION"`, **qui apparaît aussi dans la signature** de `createSale`. La garde
  pouvait être entièrement supprimée sans faire rougir quoi que ce soit — trouvé par une mutation, pas
  par une relecture. **On s'ancre sur l'instruction, jamais sur un mot qui traîne aussi dans un type.**
- **Aucune migration.** `sessionId` reste nullable — le passer `NOT NULL` échouerait sur les lignes
  nulles restantes.

### Ce qui N'A PAS été fait, volontairement

- **Les 26 200 F restants** (Onéiti 2 ventes / 16 700 F · AurelStyl 1 / 9 500 F) ne sont **pas**
  régularisés : 🗣️ *« les autres on laisse pour l'instant »* (Marco, 2026-09-01). Ce sont les pièces
  d'un marchand. *(La vente d'Ellément — 2 500 F — a été rattachée séparément par le coordinateur,
  session encore ouverte, aucun Z arrêté touché ; sauvegarde `C:\dev\_backup\2026-09-01-ellement-vente-hors-session\`.)*
- **`checkoutSale` n'est pas gardé** : la garde est à la création, seul point d'écriture. Reste donc
  ouvert, et assumé pour l'instant — une vente créée pendant une session, **payée après sa clôture**,
  entre dans un Z dont l'`expectedXpf` est figé. Hors du « seulement que la caisse soit ouverte pour
  encaisser » demandé.

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
