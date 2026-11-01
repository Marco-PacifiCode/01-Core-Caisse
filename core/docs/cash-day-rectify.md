# Rectifier un Z clos

`POST /api/cash-days/:id/rectify`, S2S `X-Core-Key`, portée du tenant contrôlée par `withTenant`.
Le relais doit vérifier le mode Administration signé et attester `administration: true`,
exactement comme pour `reopen`. Ne jamais transmettre cette attestation depuis le mode Caisse.

Corps JSON (UUID pour `:id`, `tenantId`, `actionId`, `actorId`, `receivedById`) :

```json
{
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "actionId": "22222222-2222-4222-8222-222222222222",
  "administration": true,
  "occurredAt": "2026-11-02T01:00:00.000Z",
  "actorId": "33333333-3333-4333-8333-333333333333",
  "actorName": "Administrateur",
  "receivedById": "33333333-3333-4333-8333-333333333333",
  "deviceId": "administration",
  "deviceName": "Administration",
  "countedXpf": "105700",
  "motif": "Ventes reçues après clôture"
}
```

`occurredAt` doit être à ±300 secondes du serveur pour la première application.
Le serveur ne change jamais l'heure d'un ancien Z. `motif` : 3 à 300 caractères,
espaces de bord retirés ; `countedXpf` : chaîne décimale entière positive ou nulle,
bornée par bigint PostgreSQL. `deviceId` : 1 à 120 caractères ; noms : 1 à 200.
Aucun `entityKey` ni `Idempotency-Key` supplémentaire n'est nécessaire.

200 : `{ok:true,id,revision,alreadyApplied,data}` où `data` contient
`{id,closureId,cashDayId,cycle,revision,cutoffRevision,alreadyApplied,report}`.
Les deux id désignent le nouveau Z ; révisions et montants sont des chaînes décimales.
`report` contient les totaux courants du jour, `sessionId`, `openingFloatXpf`,
`cashSalesXpf`, `creditXpf`, `countedXpf`, `varianceXpf`.
Un rejeu du même contenu renvoie ces mêmes données avec `alreadyApplied:true`,
sans écrire, même après expiration des cinq minutes et après une nouvelle rectification.
`cutoffRevision` et `revision` désignent le fait CLOSURE, comme pour `closeCashDay` : lue à la révision du REOPEN, la journée montre encore l'ancien Z.

Erreurs : `{ok:false,error}` (éventuellement `data`) :

| HTTP | error |
| --- | --- |
| 400 | INVALID_PAYLOAD (UUID, montant, motif, date ou champs invalides) |
| 400 | OCCURRED_AT_OUT_OF_RANGE |
| 401 | Unauthorized (clé S2S) |
| 403 | MODE_CAISSE (attestation Administration absente) |
| 403 | HORS_PORTEE (clé de service hors du tenant autorisé ; enveloppe du garde S2S) |
| 404 | NOT_FOUND (journée absente de ce tenant) |
| 409 | DAY_ALREADY_OPEN (session courante non CLOSED) |
| 409 | NO_AUTHORITATIVE_Z (aucun Z à remplacer) |
| 409 | ACTION_ID_CONFLICT (actionId déjà utilisé avec un autre contenu) |
| 409 | SOURCE_CONFLICT / CORRUPT_CASH_FACT (journal incohérent) |
| 500 | INTERNAL_ERROR |

La journée reste CLOSED. Une session technique fermée, sans second fond, conserve
le comptage ; le fait REOPEN porte `ADMINISTRATION_RECTIFICATION`. Aucun ancien
Z ou fait n'est modifié. Le nouveau Z authoritative porte `closureMode: "ONLINE"` (sans migration).
`legacySnapshot.rectification` conserve `{motif, remplaceClosureId, remplaceCycle}`.
`legacySnapshot.request` et `legacySnapshot.result` conservent le recu idempotent.
La projection ledger renvoie `zRemplaces` :
`[{id,cycle,compte,ecart,occurredAt,remplacéPar,motif}]` ; `ecart` est l'écart
figé de l'ancien Z et `motif` celui du remplacement. Les recomptages restent distincts.
Les ventes tardives continuent d'être reçues et modifient la régularisation.

## Consommateurs à raccorder

Dans ce dépôt, aucun envoi de Z vers Core-Compta ou export TGC autonome n'a été
trouvé : Compta reçoit les ventes, pas le comptage du tiroir. Le ledger CashDay et
la liste CashDay exposent le Z rectifié. Le relais et l'écran Administration des
surfaces restent à raccorder hors de ce dépôt.
`core/app/api/sessions/route.ts:86` expose aussi les sessions techniques fermées :
les consommateurs de cette API historique doivent lire le ledger CashDay pour
identifier les Z remplacés et ne pas additionner les comptages des cycles.


## Contraintes SQL de la rectification (sans migration)

Audit du schema Prisma, des migrations, des SQL manuels et de rls.sql.
Les contraintes des tables non ecrites (ventes, paiements, ouvertures) ne sont pas sollicitees.

| Table / contrainte | Valeur ecrite ou garantie |
| --- | --- |
| CashDayClosure : CHECK closureMode | ONLINE, admis avec OFFLINE et IMPORT |
| CashDayClosure : CHECK countedXpf >= 0 | countedXpf valide comme entier non negatif |
| CashDayClosure : NOT NULL | tenantId, cashDayId, sourceKey=rectify:actionId, cycle=ancien+1, deviceId/deviceName, actorName/receivedById, occurredAt, countedXpf, localExpectedXpf=expected, localVarianceXpf=counted-expected, baselineExpectedXpf=expected, closureMode=ONLINE, cutoffRevision=sequence du fait CLOSURE, authoritative=true ; id UUID genere, receivedAt par defaut |
| CashDayClosure : FK composites tenant/jour et tenant/session | Jour verrouille et session technique nouvellement creee du meme tenant |
| CashDayClosure : UNIQUE tenant/sourceKey ; authoritative_cycle | Cle rectify:actionId avec recu de rejeu ; nouveau cycle sous verrou tenant/jour |
| CashSession : NOT NULL, UUID et enum SessionStatus | id UUID genere, tenantId/ openedBy UUID, openedAt=occurredAt, openingFloatXpf=0, status=CLOSED ; closedAt=occurredAt, closedBy=actorId, noms=auteur, note=motif |
| CashSession : BIGINT | closingCountedXpf=counted ; expectedXpf=expected ; varianceXpf=counted-expected, tous bornes au bigint PostgreSQL |
| CashSession : PK et UNIQUE tenant/id | Nouvelle session UUID ; aucun ancien identifiant reutilise |
| CashSession : uniq_session_open_par_poste | CLOSED exclut la nouvelle session de cet index ; posteId repris de la session courante, nullable et sans FK |
| CashSession : uniq_session_external_source | sourceType/sourceId laisses NULL, hors index partiel |
| CashDaySession : NOT NULL, PK, UNIQUE tenant/session, FK composites | id UUID genere, meme tenant/jour, nouvelle session, cycle=ancien+1, createdAt par defaut |
| CashDay : CHECK cycle >= 0 ; FK currentSession ; NOT NULL | cycle=ancien+1, currentSessionId=nouvelle session du tenant, updatedAt Prisma ; revision incrementee deux fois par appendDayFact |
| CashDay : scope CHECK, PK et uniques tenant/id et tenant/scope/businessDay | Valeurs existantes conservees |
| CashDayEvent : NOT NULL, PK et BIGINT | id UUID genere, tenant/jour, sequences revision+1/+2, kind=REOPEN puis CLOSURE, sourceRef=actionId puis rectify:actionId, deviceId/occurredAt fournis, receivedAt par defaut, cashDeltaXpf=0, snapshot JSON |
| CashDayEvent : UNIQUE tenant/jour/sequence et tenant/jour/kind/sourceRef | S?quences sous verrou ; actionId unique et rejeu arrete avant insertion |
| CashDayEvent : FK tenant/jour, tenant/vente, tenant/avoir | Jour du tenant ; saleId et refundActionId NULL |
| Triggers cash_closure_immutable, cash_event_immutable, cash_alias_immutable | INSERT seulement ; aucun UPDATE/DELETE des anciens faits, Z ou alias |
| RLS ENABLE/FORCE et tenant_isolation sur les cinq tables ecrites | tenantId valide, identique au contexte transactionnel withTenant (USING et WITH CHECK) |

La branche de listCashDays (cash-days.ts, anciennement ligne 144) choisit le fait
CLOSURE correspondant au dernier Z authoritative, au lieu du dernier recomptage.
Le marqueur rectification conserve cette selection lorsque TO_CLOSE est eteint.
La projection utilise ce meme marqueur pour zRemplaces ; ONLINE conserve le cutoff
comme frontiere des ventes connues. Les remontees suivantes restent tardives.
La preuve PostgreSQL/RLS doit etre rejouee sur une base de recette.

Le ledger n'expose un Z qu'apres son fait CLOSURE dans la revision demandee. Au
milieu d'une rectification, entre REOPEN et CLOSURE, l'ancien Z reste effectif.
Les snapshots legacy absents ou non objets sont ignores comme marqueurs.
