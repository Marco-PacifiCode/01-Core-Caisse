// Contrat de lib/caisse.ts#toSnapshot / #repairSale — VENTE À CRÉDIT (lot A), volet REPRISE
// (repairSale / cron repair-sales), 2026-09-15.
//
// caisse.ts importe ./tenant (next/headers) : NON exécutable par ce runner (`node --test`, pas de
// contexte Next/DB) — même limite que void-route.test.ts et checkout-route.test.ts. Le contrat est
// donc figé par lecture de source, comme les autres tests « -route.test.ts » / structurels du dépôt.
// Le comportement DYNAMIQUE de la transmission de `dueAt` à Core-Compta (une fois dans la main de
// `runSaleSync`, qui LUI est pure) est prouvé par lib/sync.test.ts.
//
// CE QUE CE TEST PROUVE : `toSnapshot` (appelée par `syncLoadedSale`, donc par la synchro nominale
// ET par `repairSale`/le cron `repair-sales`) lit `dueAt` depuis `sale.dueAt` — la colonne PERSISTÉE
// (migration 20260915200000_sale_due_at) — et NON depuis un paramètre volatile de la requête
// d'origine. C'est CE qui permet à une reprise différée (après échec du 1er `createInvoice`) de
// retransmettre l'échéance à Core-Compta alors qu'elle n'a plus accès aux `options.credit` de la
// requête initiale (repairSale ne reçoit ni `options` ni `credit` en paramètre — seulement `saleId`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const caisseFile = path.join(libDir, "caisse.ts");

function readCaisse(): string {
  assert.ok(existsSync(caisseFile), `introuvable : ${caisseFile}`);
  return readFileSync(caisseFile, "utf8");
}

function corpsToSnapshot(): string {
  const src = readCaisse();
  const debut = src.indexOf("function toSnapshot(");
  assert.ok(debut > -1, "toSnapshot introuvable dans caisse.ts");
  // CRLF dans ce fichier (cf. `.gitattributes`/config Windows du dépôt) : on cherche une ligne qui
  // ne contient QUE "}" (tolérant \r), pas un littéral "\n}\n" qui ne matcherait jamais en CRLF.
  const fin = src.slice(debut).search(/\r?\n\}\r?\n/);
  assert.ok(fin > -1, "fermeture de toSnapshot introuvable");
  return src.slice(debut, debut + fin);
}

// ─── SABOTAGE-SENSIBLE : rougit si `toSnapshot` cesse de lire `sale.dueAt` (ex. retour à l'ancien
//     paramètre `creditDueAtIso`, ou un `dueAt: null` en dur) ────────────────────────────────────

test("toSnapshot lit dueAt depuis LA COLONNE PERSISTÉE (sale.dueAt), pas depuis un paramètre volatile", () => {
  const bloc = corpsToSnapshot();
  assert.match(
    bloc,
    /dueAt:\s*sale\.dueAt\s*\?\s*sale\.dueAt\.toISOString\(\)\s*:\s*null/,
    "sans cette lecture, une reprise différée (après échec du 1er createInvoice) perd l'échéance",
  );
});

test("toSnapshot n'a plus de 2e paramètre (l'ancien creditDueAtIso, retiré au profit de sale.dueAt)", () => {
  const src = readCaisse();
  const signatureIdx = src.indexOf("function toSnapshot(");
  const finSignature = src.indexOf(")", signatureIdx);
  const signature = src.slice(signatureIdx, finSignature + 1);
  assert.match(signature, /function toSnapshot\(sale: LoadedSale\)/);
  assert.doesNotMatch(signature, /creditDueAtIso/);
});

test("syncLoadedSale n'exige aucun paramètre credit — un seul argument, la vente rechargée", () => {
  const src = readCaisse();
  assert.match(src, /async function syncLoadedSale\(sale: LoadedSale\): Promise<SyncOutcome>/);
});

test("repairSale délègue à syncLoadedSale SANS lui passer d'échéance à part — sale.dueAt suffit", () => {
  const src = readCaisse();
  const debut = src.indexOf("export async function repairSale");
  assert.ok(debut > -1, "repairSale introuvable");
  const finRel = src.slice(debut).search(/\r?\n\}\r?\n/);
  assert.ok(finRel > -1, "fermeture de repairSale introuvable");
  const bloc = src.slice(debut, debut + finRel);
  assert.match(
    bloc,
    /await syncLoadedSale\(sale\)/,
    "repairSale doit transmettre la vente rechargée depuis la DB telle quelle : dueAt y est déjà",
  );
});
