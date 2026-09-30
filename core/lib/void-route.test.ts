// Contrat de POST /api/sales/:id/void — annulation d'une vente (DRAFT/PAID/VOID).
//
// POURQUOI DEUX STYLES DE TEST DANS CE FICHIER
// La logique métier (lib/void-sale.ts, `runVoidSale`) est PURE — dépendances (client Compta,
// persistance) injectées, comme lib/sync.ts (cf. sync.test.ts) — donc EXÉCUTÉE ici, sans DB ni
// réseau : c'est ce qui permet d'affirmer réellement « si l'avoir échoue, la vente reste PAID ».
// Le chemin `SALE_NOT_FOUND` (dépend d'une lecture Prisma dans `annulerVente`) et la route HTTP
// elle-même ne peuvent PAS être exécutés par ce runner (`node --test`, pas de DB/next context) —
// on fige leur contrat en lisant le code source, exactement comme sale-read-route.test.ts et
// sales-list-route.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { runPreparedVoidSale, runVoidSale, type VoidSaleSnapshot, type VoidPersist } from "./void-sale.ts";
import type { ComptaClient, CreditNoteInput, CreditNoteResult } from "./clients.ts";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const routeFile = path.join(libDir, "..", "app", "api", "sales", "[id]", "void", "route.ts");
const caisseFile = path.join(libDir, "caisse.ts");

const TENANT = "00000000-0000-4000-8000-000000000001";
const connectionContext = new AsyncLocalStorage<{ active: number; max: number }>();

async function fakeTransaction<T>(run: () => Promise<T>): Promise<T> {
  const state = connectionContext.getStore();
  assert.ok(state, "transaction simulée hors contexte d'annulation");
  state.max = Math.max(state.max, ++state.active);
  assert.equal(state.active, 1, "une transaction ne doit pas ouvrir une seconde connexion");
  try { return await run(); } finally { state.active--; }
}

// ─── Fakes (même schéma que sync.test.ts) ─────────────────────────────────────

function makeSale(overrides: Partial<VoidSaleSnapshot> = {}): VoidSaleSnapshot {
  return {
    id: "sale-1",
    status: "DRAFT",
    invoiceId: null,
    stockSyncedAt: null,
    lines: [],
    ...overrides,
  };
}

function makeCompta(opts: { failCreditNote?: Error } = {}) {
  const calls = { creditNote: 0 };
  const issued = new Map<string, CreditNoteResult>();
  const client: ComptaClient = {
    async createInvoice() {
      throw new Error("non utilisé par ce test");
    },
    async settle() {
      throw new Error("non utilisé par ce test");
    },
    async creditNote(input: CreditNoteInput): Promise<CreditNoteResult> {
      assert.equal(connectionContext.getStore()?.active ?? 0, 0, "Compta doit être hors transaction");
      calls.creditNote++;
      if (opts.failCreditNote) throw opts.failCreditNote;
      const existing = issued.get(input.invoiceId);
      if (existing) return { ...existing, alreadyExisted: true };
      const result: CreditNoteResult = {
        creditNoteId: "cn-1",
        number: "AVOIR-1",
        totalXpf: 0,
        alreadyExisted: false,
        origin: { id: input.invoiceId, number: "FAC-1" },
      };
      issued.set(input.invoiceId, result);
      return result;
    },
    receiptUrl: (invoiceId) => `http://compta/receipt/${invoiceId}`,
  };
  return { client, calls, opts, issued };
}

function makePersist() {
  const state = { status: "DRAFT" as string, calls: 0 };
  const persist: VoidPersist = {
    async markVoid(creditNoteId) {
      state.calls++;
      state.status = "VOID";
      return { alreadyVoid: false, creditNoteId };
    },
  };
  return { persist, state };
}

// ─── Comportement (exécuté réellement, comme sync.test.ts) ───────────────────

test("une vente DRAFT passe à VOID sans appeler Compta", async () => {
  const compta = makeCompta();
  const { persist, state } = makePersist();

  const out = await runVoidSale(makeSale({ status: "DRAFT" }), TENANT, compta.client, persist);

  assert.deepEqual(out, { ok: true, alreadyVoid: false, creditNoteId: null });
  assert.equal(compta.calls.creditNote, 0, "aucun appel externe pour une vente jamais encaissée");
  assert.equal(state.calls, 1);
  assert.equal(state.status, "VOID");
});

test("une vente PAID avec facture émet un avoir PUIS passe à VOID", async () => {
  const compta = makeCompta();
  const { persist, state } = makePersist();
  const sale = makeSale({ status: "PAID", invoiceId: "inv-1" });

  const out = await runVoidSale(sale, TENANT, compta.client, persist);

  assert.deepEqual(out, { ok: true, alreadyVoid: false, creditNoteId: "cn-1" });
  assert.equal(compta.calls.creditNote, 1);
  assert.equal(state.calls, 1, "le passage à VOID a bien eu lieu, APRÈS l'avoir");
  assert.equal(state.status, "VOID");
});

test("si l'avoir échoue, la vente reste PAID (le test qui compte le plus)", async () => {
  const compta = makeCompta({ failCreditNote: new Error("Compta indisponible") });
  const { persist, state } = makePersist();
  const sale = makeSale({ status: "PAID", invoiceId: "inv-1" });

  const out = await runVoidSale(sale, TENANT, compta.client, persist);

  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.error, "CREDIT_NOTE_FAILED");
  assert.match((out as { detail: string }).detail, /Compta indisponible/);
  assert.equal(state.calls, 0, "markVoid ne doit JAMAIS être appelé si l'avoir échoue");
  assert.equal(state.status, "DRAFT", "l'état simulé n'a pas bougé — la vente resterait PAID en base");
});

test("une vente PAID avec ligne PRODUCT + stockSyncedAt renvoie STOCK_DECREMENTED et ne touche à rien", async () => {
  const compta = makeCompta();
  const { persist, state } = makePersist();
  const sale = makeSale({
    status: "PAID",
    invoiceId: "inv-1",
    stockSyncedAt: new Date(),
    lines: [{ kind: "PRODUCT", productId: "prod-1" }],
  });

  const out = await runVoidSale(sale, TENANT, compta.client, persist);

  assert.deepEqual(out, { ok: false, error: "STOCK_DECREMENTED" });
  assert.equal(compta.calls.creditNote, 0, "aucun avoir tant que le stock n'est pas traité");
  assert.equal(state.calls, 0, "rien n'est écrit");
});

test("une vente PAID sans ligne PRODUCT (ou sans stockSyncedAt) n'est PAS bloquée par STOCK_DECREMENTED", async () => {
  const compta = makeCompta();
  const { persist, state } = makePersist();
  // Ligne SERVICE uniquement : le refus stock ne doit jamais se déclencher sur une vente 100% service.
  const sale = makeSale({
    status: "PAID",
    invoiceId: "inv-1",
    stockSyncedAt: new Date(),
    lines: [{ kind: "SERVICE", productId: null }],
  });

  const out = await runVoidSale(sale, TENANT, compta.client, persist);

  assert.equal(out.ok, true);
  assert.equal(state.calls, 1);
});

test("rejouer sur une vente déjà VOID rend alreadyVoid:true sans erreur", async () => {
  const compta = makeCompta();
  const { persist, state } = makePersist();
  const sale = makeSale({ status: "VOID", invoiceId: "inv-1", stockSyncedAt: new Date() });

  const out = await runVoidSale(sale, TENANT, compta.client, persist);

  assert.deepEqual(out, { ok: true, alreadyVoid: true, creditNoteId: null });
  assert.equal(compta.calls.creditNote, 0, "IDEMPOTENT : rejouer ne rappelle jamais Compta");
  assert.equal(state.calls, 0, "IDEMPOTENT : rejouer n'écrit rien de plus");
});

// ─── Contrat SALE_NOT_FOUND / route HTTP — figé par lecture de source ─────────
// (dépend d'une lecture Prisma dans `annulerVente` / d'un contexte Next dans la route :
// non exécutable par ce runner, cf. en-tête du fichier.)

function readCaisse(): string {
  assert.ok(existsSync(caisseFile), `introuvable : ${caisseFile}`);
  return readFileSync(caisseFile, "utf8");
}

function readRoute(): string {
  assert.ok(existsSync(routeFile), `introuvable : ${routeFile}`);
  return readFileSync(routeFile, "utf8");
}

test("une vente inconnue rend SALE_NOT_FOUND (annulerVente)", () => {
  const src = readCaisse();
  const debut = src.indexOf("export async function annulerVente");
  assert.ok(debut > -1, "annulerVente introuvable dans caisse.ts");
  const body = src.slice(debut);
  assert.match(body, /if \(!sale\) return \{ error: "SALE_NOT_FOUND" as const \}/);
});

test("la route d'annulation existe et exige la clé de service", () => {
  const body = readRoute();
  assert.ok(body.length > 200);
  assert.match(body, /hasServiceKey\(req\)/);
});

test("la route mappe les erreurs sur les bons statuts HTTP", () => {
  const body = readRoute();
  assert.match(body, /SALE_NOT_FOUND:\s*404/);
  assert.match(body, /STOCK_DECREMENTED:\s*409/);
  assert.match(body, /CREDIT_NOTE_FAILED:\s*502/);
  assert.match(body, /ACTION_ID_CONFLICT:\s*409/);

});

function harness() {
  const sale = makeSale({ status: "PAID", invoiceId: "inv-1" });
  const compta = makeCompta();
  const actions = new Map<string, { saleId: string; status: string }>();
  const tails = new Map<string, Promise<void>>();
  const sales = new Map([[sale.id, sale], ['sale-2', makeSale({ id: 'sale-2', status: 'PAID', invoiceId: 'inv-2' })]]);
  async function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    tails.set(key, new Promise<void>(resolve => { release = resolve; }));
    await previous;
    try { return await fn(); } finally { release(); }
  }
  let failPersist = false;
  let voidWrites = 0;
  const connectionMaxima: number[] = [];
  const run = async (actionId?: string, saleId = sale.id) => {
    const attempt = { active: 0, max: 0 };
    return connectionContext.run(attempt, async () => {
      const result = await runPreparedVoidSale({
      async prepare() {
        return fakeTransaction(() => {
          const prepareSale = async () => {
            if (actionId && actions.has(actionId) && actions.get(actionId)!.saleId !== saleId)
              return { error: "ACTION_ID_CONFLICT" as const };
            const current = sales.get(saleId)!;
            if (current.status === "VOID") return current;
            if (actionId && !actions.has(actionId)) actions.set(actionId, { saleId, status: "PENDING" });
            return { ...current };
          };
          return actionId
            ? lock('action:' + actionId, () => lock('sale:' + saleId, prepareSale))
            : lock('sale:' + saleId, prepareSale);
        });
      },
      compta: compta.client, tenantId: TENANT, reason: undefined,
      persist: {
      async markVoid(creditNoteId) {
        if (failPersist) throw new Error("transaction interrompue");
        return fakeTransaction(() => lock('sale:' + saleId, async () => {
          const current = sales.get(saleId)!;
          if (current.status === "VOID") return { alreadyVoid: true, creditNoteId: current.creditNoteId ?? null };
          voidWrites++;
          current.status = "VOID";
          current.creditNoteId = creditNoteId;
          if (actionId) actions.set(actionId, { saleId, status: "DONE" });
          return { alreadyVoid: false, creditNoteId };
        }));
      },
    }});
      connectionMaxima.push(attempt.max);
      return result;
    });
  };
  return { run, compta, actions, sales, connectionMaxima, get voidWrites() { return voidWrites; }, setFailPersist(value: boolean) { failPersist = value; } };
}

for (const nextKey of ["key-1", "key-2"]) {
  test("?chec Compta puis rejeu " + nextKey + " r?ussit sans erreur m?moris?e", async () => {
    const h = harness();
    h.compta.opts.failCreditNote = new Error("timeout Compta");
    assert.equal((await h.run("key-1")).ok, false);
    assert.equal(h.actions.size, 1);
    h.compta.opts.failCreditNote = undefined;
    assert.equal((await h.run(nextKey)).ok, true);
    assert.equal(h.compta.calls.creditNote, 2);
    assert.equal(h.compta.issued.size, 1);
    assert.ok(h.connectionMaxima.every(max => max === 1));
  });
}

test("échec Compta puis rejeu sans clé réussit et n'émet qu'un avoir", async () => {
  const h = harness();
  h.compta.opts.failCreditNote = new Error("timeout Compta");
  assert.equal((await h.run(undefined)).ok, false);
  h.compta.opts.failCreditNote = undefined;
  assert.equal((await h.run(undefined)).ok, true);
  assert.equal(h.compta.issued.size, 1);
  assert.ok(h.connectionMaxima.every(max => max === 1));
});

test("succ?s puis toute cle ou aucune rend l'avoir existant", async () => {
  const h = harness();
  await h.run("key-1");
  for (const key of ["key-1", "key-2", undefined]) {
    assert.deepEqual(await h.run(key), { ok: true, alreadyVoid: true, creditNoteId: "cn-1" });
  }
  assert.equal(h.compta.calls.creditNote, 1);
  assert.ok(h.connectionMaxima.every(max => max === 1));
});

for (const keys of [[undefined, "key-1"], ["key-1", undefined], ["key-1", "key-2"]]) {
  test("course " + keys.join("/") + " : un seul appel Compta", async () => {
    const h = harness();
    const results = await Promise.all(keys.map(key => h.run(key)));
    assert.equal(results.filter(r => r.ok && !r.alreadyVoid).length, 1);
    assert.equal(h.compta.calls.creditNote, 2);
    assert.equal(h.compta.issued.size, 1);
    assert.ok(h.connectionMaxima.every(max => max === 1));
  });
}

test("exception de finalisation : reservation rejouable", async () => {
  const h = harness();
  h.setFailPersist(true);
  await assert.rejects(h.run("key-1"), /transaction interrompue/);
  assert.equal(h.actions.size, 1);
  h.setFailPersist(false);
  assert.equal((await h.run("key-1")).ok, true);
});

test("meme cle sur une autre vente : conflit", async () => {
  const h = harness();
  await h.run("key-1");
  assert.deepEqual(await h.run("key-1", "sale-2"), { ok: false, error: "ACTION_ID_CONFLICT" });
  assert.equal(h.compta.calls.creditNote, 1);
});

test("deux annulations legacy simultanées effectuent une seule écriture VOID", async () => {
  const h = harness();
  await Promise.all([h.run(), h.run()]);
  assert.equal(h.sales.get("sale-1")!.status, "VOID");
  assert.equal(h.voidWrites, 1);
  assert.equal(h.compta.issued.size, 1);
  assert.ok(h.connectionMaxima.every(max => max === 1));
});

test("route actionId UUID", () => {
 const body = readRoute();
 assert.match(body, /Idempotency-Key/);
 assert.match(body, /body\.actionId/);
});
test("migration additive avec index action et RLS", () => {
 const migration = readFileSync(path.join(libDir, "..", "prisma", "migrations", "20261001090000_void_action_idempotency", "migration.sql"), "utf8");
 assert.match(migration, /CREATE TABLE "VoidAction"/);
 assert.match(migration, /UNIQUE INDEX "VoidAction_tenantId_actionId_key"/);
 assert.doesNotMatch(migration, /UNIQUE INDEX "VoidAction_tenantId_saleId/);
 assert.match(migration, /FORCE ROW LEVEL SECURITY/);
 assert.doesNotMatch(migration, /DROP/i);
});

test("production wiring uses short preparation and finalization transactions", () => {
 const src = readCaisse();
 const body = src.slice(src.indexOf("export async function annulerVente"), src.indexOf("export type LoyaltyProgramView"));
 assert.doesNotMatch(body, /prisma\.\$transaction/);
 assert.match(body, /lockSaleRow\(tx, saleId, safeTenantId\)/);
 const prepareBody = body.slice(body.indexOf("async prepare()"), body.indexOf("compta: comptaClient()"));
 assert.ok(prepareBody.indexOf("lockSaleRow") < prepareBody.indexOf("tx.sale.findFirst"));
 assert.match(body, /tx\.sale\.update/);
 assert.match(body, /voidAction\.create\(\{ data: \{ tenantId: safeTenantId, saleId, actionId, status: "PENDING" \} \}\)/);
 assert.match(body, /status: "DONE"/);
 assert.doesNotMatch(body, /ACTION_IN_PROGRESS|ACTION_ALREADY_USED|getSale\(/);
 assert.match(readRoute(), /catch\s*\{/);
 assert.doesNotMatch(readRoute(), /ACTION_IN_PROGRESS|ACTION_ALREADY_USED/);
});

 test("deux ventes simultanees, meme cle : un seul avoir, conflit sans mutation", async () => {
  const h = harness();
  const results = await Promise.all([h.run('key-1'), h.run('key-1', 'sale-2')]);
  assert.deepEqual(results[1], { ok: false, error: 'ACTION_ID_CONFLICT' });
  assert.equal(h.compta.calls.creditNote, 1);
  assert.equal(h.sales.get('sale-1')!.status, 'VOID');
  assert.equal(h.sales.get('sale-2')!.status, 'PAID');
  assert.equal(h.sales.get('sale-2')!.creditNoteId, undefined);
  assert.equal((await h.run('key-2', 'sale-2')).ok, true);
  assert.equal(h.sales.get('sale-2')!.status, 'VOID');
 });
 test("les verrous independants permettent deux ventes en parallele", async () => {
  const h = harness();
  let entered = 0;
  let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const original = h.compta.client.creditNote;
  h.compta.client.creditNote = async input => {
    if (++entered === 2) release();
    await both;
    return original(input);
  };
  await Promise.all([h.run('key-1'), h.run('key-2', 'sale-2')]);
  assert.equal(h.compta.calls.creditNote, 2);
 });
test("préparation et finalisation courtes, Compta hors verrou de ligne", () => {
  const src = readCaisse();
  const body = src.slice(src.indexOf('export async function annulerVente'), src.indexOf('export type LoyaltyProgramView'));
  const prepareBody = body.slice(body.indexOf("async prepare()"), body.indexOf("compta: comptaClient()"));
  assert.ok(prepareBody.indexOf("lockVoidResource(tx, safeTenantId, 'action:'") < prepareBody.indexOf("lockSaleRow(tx"));
  assert.ok(body.indexOf('voidAction.create') > body.indexOf('async prepare()'));
  assert.doesNotMatch(body, /prisma\.\$transaction\s*\(/);
  assert.equal((body.match(/withTenant\(safeTenantId, async \(tx\)/g) ?? []).length, 2);
 assert.ok(prepareBody.indexOf("lockVoidResource") < prepareBody.indexOf("lockSaleRow(tx"));
 });
