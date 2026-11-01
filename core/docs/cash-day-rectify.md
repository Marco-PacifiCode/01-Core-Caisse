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
`cutoffRevision` désigne le REOPEN ; `revision` le CLOSURE qui suit.

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
Z ou fait n'est modifié. Le nouveau Z authoritative porte `RECTIFICATION` et son
`legacySnapshot` conserve `motif`, `replacedClosureId` et le reçu d'idempotence.
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
