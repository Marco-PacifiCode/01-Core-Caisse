// Lot 4a : ports simulés, code de production exécuté sans Prisma ni TypeScript installé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { expectedXpfPourRapport } from "./z-report.ts";
import { verifierCorrection, type SaleSnapshotForCorrection } from "./payment-correction.ts";
import * as projection from "./cash-day-projection.ts";

// Lectures de l'inventaire confirmées une par une (lignes du lot 4a, avant → après).
// prisma/schema.prisma:25,69 : enum binaire → troisième valeur connue par le client livré.
// cash-day-ledger.ts:14 : relations Prisma → mêmes relations, statut transmis ; test ci-dessous.
// cash-days.ts:30,32,33 : ouverture/sélection/rejet veille OPEN → inchangés (transition en 4b).
// cash-days.ts:60 : statut brut → statut brut TO_CLOSE ; :64 CLOSED/closedLate → false pour TO_CLOSE.
// cash-days.ts:79,82,85,86 : relations/liste/dernier CLOSURE → inchangés, pas de coercition CLOSED.
// cash-days.ts:116 : sessions legacy avec statut → transmission brute inchangée.
// cash-days.ts:159,164,172 : pièces CLOSED uniquement → TO_CLOSE exclu, inchangé.
// cash-days.ts:262 : réouverture seulement CLOSED → TO_CLOSE non fermé, refus DAY_ALREADY_OPEN.
// cash-days.ts:274,285 : lockDay/rapport ledger → projection sans branche de statut, inchangée.
// cash-day-sales.ts:13 : OPEN/offline/import → inchangé, garde de vente à élargir en 4b.
// cash-day-sales.ts:59,61 : mouvement sans garde statut/date stricte → inchangé (y compris CLOSED).
// cash-day-guard.ts:44 : remboursement historique avec jour OPEN → inchangé, reprise en 4b.
// caisse.ts:143 : unicité OPEN par poste → inchangée, TO_CLOSE n'est pas le tiroir actif.
// caisse.ts:191 : session courante OPEN → inchangée (/sessions).
// caisse.ts:358,376 : seul CLOSED figé, sinon comptage → TO_CLOSE clôturable, inchangé.
// caisse.ts:411,439,443 : réouverture CLOSED/recherche OPEN → inchangée (/sessions).
// caisse.ts:610,613 : remplacement par session OPEN → inchangé (/sessions).
// caisse.ts:1841,1843,1866 : gardes remboursement OPEN → inchangées, reprise en 4b.
// caisse.ts:2074 : statut transmis à correction → type élargi dans payment-correction.ts:37.
// caisse.ts:2180,2182,2188,2202 : mouvement historique OPEN → inchangé (/sessions).
// partial-refund-db.ts:35,36,86,110,113,117 : tiroir historique OPEN → inchangé, CashDay EXTERNAL.
// postes.ts:172 : session active OPEN → inchangé, TO_CLOSE n'est pas une session active.
// z-report.ts:22,28 : type binaire/figé si CLOSED → type élargi/recalcul pour TO_CLOSE.
// payment-correction.ts:37,146 : type binaire/aucune garde statut → type élargi/correction permise.
// app/api/cash-days/route.ts:9,13 : liste/dayState → mêmes fonctions, test HTTP ci-dessous.
// app/api/cash-days/[id]/ledger/route.ts:7 : ledgerPage → projection tolérante testée ci-dessous.
// app/api/cash-days/{legacy,legacy/pending-closures}/route.ts:5 : fonctions ci-dessus, inchangées.
// app/api/cash-days/{import,[id]/close,[id]/reopen,[id]/attach-legacy}/route.ts : délégations inchangées.
// app/api/cash-days/[id]/{movements,sales,sales/[saleId]/[operation]}/route.ts : gardes 4b inchangées.
// app/api/sessions/route.ts:56,80,90 : statut transmis/filtre libre/statut brut → inchangés.
// app/api/sessions/[id]/close/route.ts:37 : closeSession → Z ci-dessus, contrat inchangé.
// Rôtisserie, Mixy et témoins deploy : hors fichiers autorisés ; prérequis clients livrés séparément.
// Le client Prisma doit être généré au build/CI depuis le schéma 4a avant toute lecture réelle
// de TO_CLOSE : aucun contournement SQL global ni changement de /sessions dans cette étape.

const tenantId = "ab000000-0000-0000-0000-000000000001";
const id = "ab000000-0000-0000-0000-000000000002";
function load(file: string, names: string[], ports: Record<string, unknown>) {
  const js = stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"))
    .replace(/^import .*from .*;\r?$/gm, "").replace(/^export /gm, "");
  return vm.runInNewContext(`(function(){${js}\nreturn {${names.join(",")}};})()`, {
    Date, URLSearchParams, ...ports,
  });
}
function dayPorts() {
  const session = { id, tenantId, status: "TO_CLOSE", openingFloatXpf: 25000n,
    openedAt: new Date("2026-10-28T01:00:00Z"), closedAt: null, expectedXpf: null };
  const day = { id, tenantId, businessDay: "2026-10-28", scope: "rotisserie-caisse", cycle: 0,
    currentSessionId: id, canonicalSessionId: id, revision: 0n,
    canonicalSession: session, currentSession: session, events: [] };
  const tx = {
    $queryRaw: async (_sql: TemplateStringsArray, tenant: string, dayId: string) => {
      assert.equal(tenant, tenantId); assert.equal(dayId, id); return [{ id }];
    },
    cashDay: {
      findFirstOrThrow: async (q: any) => { assert.equal(q.where.tenantId, tenantId); return day; },
      findMany: async (q: any) => { assert.equal(q.where.tenantId, tenantId); return [day]; },
    },
    cashDayEvent: { findMany: async () => [] },
    cashDayClosure: { findMany: async () => [] },
    cashDayOpening: { findMany: async () => [] },
  };
  const sync = { uuid: (value: string) => value, lockCashTenant: async () => {} };
  const ledger = load("cash-day-ledger.ts", ["lockDay", "readFacts"], { ...projection, ...sync });
  const days = load("cash-days.ts", ["listCashDays", "dayState", "ledgerPage"], { ...projection, ...sync, ...ledger });
  return { tx, day, ledger, days };
}

test("TO_CLOSE : lockDay, liste et état HTTP gardent une journée non fermée, à fermer", async () => {
  const { tx, ledger, days } = dayPorts();
  const locked = await ledger.lockDay(tx, tenantId, id);
  assert.equal(locked.currentSession.status, "TO_CLOSE");
  assert.equal(locked.currentSession.closedAt, null);
  const views = [(await days.listCashDays(tx, tenantId, new URLSearchParams())).days[0],
    await days.dayState(tx, tenantId, id)];
  for (const view of views) {
    assert.equal(view.status, "TO_CLOSE"); assert.equal(view.closedLate, false);
    assert.equal(view.closedAt, null); assert.equal(view.businessDay, "2026-10-28");
  }
  const route = load("../app/api/cash-days/route.ts", ["GET"], { ...projection, ...days,
    cashRead: (_req: unknown, fn: Function) => fn(tx, tenantId, new URLSearchParams()) });
  assert.equal((await route.GET({})).days[0].status, "TO_CLOSE");
  const report = await days.ledgerPage(tx, tenantId, id, new URLSearchParams());
  assert.equal(report.projection.totauxCourants.expectedXpf, 25000n);
  assert.equal(report.closures.length, 0);
});

test("TO_CLOSE : le Z recalcule le tiroir et la correction reste autorisée", () => {
  assert.equal(expectedXpfPourRapport({ status: "TO_CLOSE", expectedXpf: 999n }, 200n), 200n);
  assert.equal(expectedXpfPourRapport({ status: "CLOSED", expectedXpf: 999n }, 200n), 999n);
  const now = new Date("2026-10-29T01:00:00Z");
  const sale: SaleSnapshotForCorrection = { id, status: "PAID", sessionId: id, sessionStatus: "TO_CLOSE",
    comptaSyncedAt: now, invoiceId: "synthetic-invoice", paidAt: now, createdAt: now,
    payments: [{ method: "CASH", amountXpf: 200n, settleRef: null }] };
  assert.deepEqual(verifierCorrection(sale, { fromMethod: "CASH", toMethod: "CARD", amountXpf: 200, maintenant: now }), { ok: true });
});

test("cash-settings : GET false, PATCH seul refusé, clé ignorée avec un champ autorisé", async () => {
  let row: any = null;
  const tx = { cashSettings: {
    findUnique: async () => row,
    create: async ({ data }: any) => (row = { defaultFloatXpf: 25000n, allowNegativeStock: false, toCloseEnabled: false, ...data }),
    updateMany: async ({ data }: any) => { assert.ok(!("toCloseEnabled" in data)); row = { ...row, ...data }; return { count: 1 }; },
    findUniqueOrThrow: async () => row,
  } };
  const shared = load("cash-shared-data.ts", ["changeSettings"], { ...projection, revisionOf: (v: number) => v });
  const route = load("../app/api/cash-settings/route.ts", ["GET", "PATCH"], {
    ...shared, cashRead: (_req: unknown, fn: Function) => fn(tx, tenantId),
    cashWrite: (body: unknown, _key: string, fn: Function) => fn(tx, body),
  });
  assert.equal((await route.GET({})).toCloseEnabled, false);
  await assert.rejects(route.PATCH({ tenantId, baseRevision: 0, toCloseEnabled: true }), /INVALID_PAYLOAD/);
  assert.equal(row, null);
  await route.PATCH({ tenantId, baseRevision: 0, defaultFloatXpf: "30000", toCloseEnabled: true });
  assert.equal((await route.GET({})).toCloseEnabled, false);
  await route.PATCH({ tenantId, baseRevision: 1, defaultFloatXpf: "35000", toCloseEnabled: true });
  assert.equal((await route.GET({})).toCloseEnabled, false);
  assert.equal(row.defaultFloatXpf, 35000n);
  const before = row;
  await assert.rejects(route.PATCH({ tenantId, baseRevision: 2, toCloseEnabled: true }), /INVALID_PAYLOAD/);
  assert.equal(row, before);
});

test("4a : aucun usage runtime de TO_CLOSE et aucun écrivain de toCloseEnabled", () => {
  const roots = [new URL("./", import.meta.url), new URL("../app/api/", import.meta.url)];
  let statusTypes = 0;
  function scan(dir: URL) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const line of source.split(/\r?\n/).filter(line => line.includes("TO_CLOSE"))) {
        assert.ok(["z-report.ts", "payment-correction.ts"].includes(entry.name), file.pathname);
        assert.match(line, /^\s*(session: \{ status|sessionStatus):?\s*:?.*"OPEN" \| "TO_CLOSE" \| "CLOSED"/);
        statusTypes++;
      }
      if (source.includes("toCloseEnabled")) {
        assert.ok(file.pathname.endsWith("/app/api/cash-settings/route.ts"), file.pathname);
        assert.ok(!source.slice(source.indexOf("export function PATCH")).includes("toCloseEnabled"));
      }
    }
  }
  roots.forEach(scan);
  assert.equal(statusTypes, 2);
});
