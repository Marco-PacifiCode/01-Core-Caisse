import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import vm from "node:vm";
import ts from "typescript";
import { PrismaClient, Prisma } from "@prisma/client";

// Commande depuis core : node --test --experimental-strip-types "test-pg/**/*.test.ts"
// Base jetable ci-local uniquement : migrations, manual/*.sql, rls.sql, rôle app RLS.
// Les fonctions métier sont extraites comme dans cash-day-db.test.ts ; leurs helpers
// sont les vrais modules. Seule la synchro externe APRÈS commit est neutralisée.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base de recette uniquement)");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });
const require = createRequire(import.meta.url);
const lib = fileURLToPath(new URL("../lib/", import.meta.url));
const sourcePath = join(lib, "caisse.ts");
const original = readFileSync(sourcePath, "utf8");
const cache = new Map<string, any>();
function load(file: string): any {
  const path = resolve(lib, file.replace(/\.ts$/, "") + ".ts");
  if (cache.has(path)) return cache.get(path);
  if (path === join(lib, "tenant.ts")) return { withTenant: transaction };
  const module = { exports: {} as any };
  cache.set(path, module.exports);
  const js = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const run = vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {
    Date, Error, Promise, Map, Set, WeakMap, BigInt, JSON, Number, String, Object, Array,
    URL, URLSearchParams, setTimeout, clearTimeout,
  });
  run((name: string) => name.startsWith(".") ? load(resolve(dirname(path), name)) : require(name), module, module.exports);
  return module.exports;
}
let transactionName = "session-open-test";
function transaction<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    await tx.$executeRaw`SELECT set_config('application_name', ${transactionName}, true)`;
    return fn(tx);
  }, { maxWait: 10000, timeout: 20000 });
}
const projection = load("cash-day-projection");
function functions(source: string) {
  const globals: Record<string, any> = { Date, Error, BigInt, Prisma, randomUUID, withTenant: transaction };
  for (const file of ["cash-day-projection", "caisse-sync", "cash-day-guard", "cash-day-ledger", "sale-lock", "money", "cash-movement", "gift-card", "z-report", "credit", "loyalty", "sync"]) {
    Object.assign(globals, load(file));
  }
  // Aucun réseau. Le test vérifie exclusivement l'encaissement et la clôture locaux.
  globals.comptaClient = () => ({ receiptUrl: () => null });
  globals.syncLoadedSale = async () => ({ synced: true, invoiceId: null, invoiceNumber: null, stockDecremented: 0 });
  globals.log = { error() {}, warn() {} };
  const context = vm.createContext(globals);
  for (const name of ["openSaleSession", "getSale", "createSale", "checkoutSale", "closeSessionTx"]) {
    const start = source.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0);
    const end = source.indexOf("\nexport ", start + 10);
    const js = ts.transpileModule(source.slice(start, end < 0 ? undefined : end).replace("export ", ""), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    globals[name] = vm.runInContext(`${js}\n${name}`, context);
  }
  return globals;
}
const api = functions(original);
const lines = [{ kind: "SERVICE", label: "Recette synthétique", qty: 1, unitXpf: 1000n }];
const payments = [{ method: "CASH", amountXpf: 1000n }];
async function fixture(fn: (tenant: string, session: string, actor: string) => Promise<void>) {
  const tenant = randomUUID(), actor = randomUUID();
  const session = await transaction(tenant, tx => tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor } }));
  try { await fn(tenant, session.id, actor); }
  finally {
    await transaction(tenant, async tx => {
      await tx.sale.deleteMany({ where: { tenantId: tenant } });
      await tx.cashSession.deleteMany({ where: { tenantId: tenant } });
    });
  }
}
async function sale(tenant: string, sessionId: string | null, engine = api) {
  const result = await engine.createSale(tenant, { sessionId, lines });
  assert.equal(result.ok, true);
  return result.saleId as string;
}
function closedError(error: unknown) {
  return error instanceof projection.CashContractError && error.message === "SESSION_NOT_OPEN" && error.status === 409;
}
async function race(engine: typeof api, reopen = false) {
  await fixture(async (tenant, session, actor) => {
    const id = await sale(tenant, session);
    let ready!: () => void, release!: () => void;
    const held = new Promise<void>(r => { ready = r; });
    const gate = new Promise<void>(r => { release = r; });
    transactionName = `checkout-close-${randomUUID()}`;
    let closeReport: any;
    let nextSession: string | undefined;
    const holder = transaction(tenant, async tx => {
      closeReport = await api.closeSessionTx(tx, tenant, { sessionId: session, closedBy: actor, closingCountedXpf: 0n });
      ready();
      await gate;
      if (reopen) nextSession = (await tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor } })).id;
    });
    // Un échec de la clôture ne laisse pas le concurrent suspendu.
    const heldOrFailed = Promise.race([held, holder.then(() => { throw Error("clôture terminée avant signal"); })]);
    let contender: Promise<unknown> | undefined;
    let refused: Promise<void> | undefined;
    try {
      await heldOrFailed;
      contender = engine.checkoutSale(tenant, id, payments);
      // Attacher immédiatement le rejet, pour éviter un unhandledRejection.
      refused = reopen ? contender.then(result => { assert.equal((result as any).status, "PAID"); }) : assert.rejects(contender, closedError);
      void refused.catch(() => {});
      await sleep(200);
      const waiting = await prisma.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE application_name = ${transactionName} AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0) AS waiting`;
      assert.equal(waiting[0].waiting, true, "checkout doit attendre le verrou de la clôture");
      release();
      await Promise.all([holder, refused]);
      assert.equal(closeReport.report.salesCount, 0);
      const stored = await transaction(tenant, tx => tx.sale.findFirstOrThrow({ where: { id }, include: { payments: true } }));
      assert.equal(stored.status, reopen ? "PAID" : "DRAFT");
      assert.equal(stored.sessionId, reopen ? nextSession : session);
      assert.equal(stored.payments.length, reopen ? 1 : 0, "aucun paiement partiel après le 409");
    } finally {
      release();
      await Promise.allSettled([holder, ...(contender ? [contender] : []), ...(refused ? [refused] : [])]);
      transactionName = "session-open-test";
    }
  });
}

test("a) OPEN : vente encaissée PAID et comptée au Z", async () => {
  await fixture(async (tenant, session, actor) => {
    const id = await sale(tenant, session);
    assert.equal((await api.checkoutSale(tenant, id, payments)).status, "PAID");
    assert.equal((await api.getSale(tenant, id)).status, "PAID");
    const z = await transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId: session, closedBy: actor, closingCountedXpf: 1000n }));
    assert.equal(z.report.salesCount, 1);
    assert.equal(z.report.totalSalesXpf, 1000);
    assert.equal(z.report.cashSalesXpf, 1000);
  });
});
test("b) clôture sous verrou : checkout attend puis 409, zéro paiement", async () => { await race(api); });
test("b bis) clôture sous verrou puis nouvelle OPEN : checkout attend et rattache", async () => { await race(api, true); });
test("c,d,e) CLOSED refuse la création ; sans session accepté ; nouvelle OPEN accepte", async () => {
  await fixture(async (tenant, session, actor) => {
    await transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId: session, closedBy: actor, closingCountedXpf: 0n }));
    await assert.rejects(() => api.createSale(tenant, { sessionId: session, lines }), closedError);
    const noSession = await sale(tenant, null);
    assert.equal((await api.checkoutSale(tenant, noSession, payments)).status, "PAID");
    const next = await transaction(tenant, tx => tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor } }));
    const id = await sale(tenant, next.id);
    assert.equal((await api.checkoutSale(tenant, id, payments)).status, "PAID");
    const reattached = await sale(tenant, session);
    assert.equal((await api.getSale(tenant, reattached)).sessionId, next.id);
  });
});
test("f) rejeu source externe après clôture : vente existante, sans 409", async () => {
  await fixture(async (tenant, session, actor) => {
    const input = { sessionId: session, sourceType: "session-open-test", sourceId: randomUUID(), lines };
    const first = await api.createSale(tenant, input);
    await transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId: session, closedBy: actor, closingCountedXpf: 0n }));
    const replay = await api.createSale(tenant, input);
    assert.equal(replay.saleId, first.saleId);
    assert.equal(replay.alreadyExisted, true);
    assert.equal(await transaction(tenant, tx => tx.sale.count({ where: { tenantId: tenant } })), 1);
  });
});

async function reattach(engine: typeof api, offline = false) {
  await fixture(async (tenant, session, actor) => {
    // Poste de l'ancienne session retrouvé même si Sale.posteId est absent.
    await transaction(tenant, tx => tx.cashSession.update({ where: { id: session }, data: { posteId: "poste-temoin" } }));
    const id = await sale(tenant, session, engine);
    const oldZ = await transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId: session, closedBy: actor, closingCountedXpf: 0n }));
    const paidAt = new Date(Date.now() - 86400_000);
    const next = await transaction(tenant, tx => tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor, posteId: "poste-temoin" } }));
    // Une autre caisse OPEN ne doit pas recevoir ce ticket.
    await transaction(tenant, tx => tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor, posteId: "autre-poste" } }));
    assert.equal((await engine.checkoutSale(tenant, id, payments, offline ? { paidAt } : undefined)).status, "PAID");
    const stored = await api.getSale(tenant, id);
    assert.equal(stored.sessionId, next.id);
    assert.equal(stored.payments.length, 1);
    if (offline) assert.equal(stored.paidAt.getTime(), paidAt.getTime());
    const newZ = await transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId: next.id, closedBy: actor, closingCountedXpf: 1000n }));
    assert.equal(newZ.report.salesCount, 1);
    assert.equal(newZ.report.totalSalesXpf, 1000);
    assert.equal(newZ.report.expectedXpf, 1000);
    const reread = await transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId: session, closedBy: actor, closingCountedXpf: 0n }));
    assert.deepEqual(reread.report, oldZ.report, "ancien Z inchangé et vente absente");
  });
}
test("g) DRAFT CLOSED : PAID dans la nouvelle session du poste et son Z", async () => { await reattach(api); });
test("h) DRAFT CLOSED sans OPEN : 409, vente et paiements inchangés", async () => {
  await fixture(async (tenant, session, actor) => {
    const id = await sale(tenant, session);
    await transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId: session, closedBy: actor, closingCountedXpf: 0n }));
    const before = await api.getSale(tenant, id);
    await assert.rejects(() => api.checkoutSale(tenant, id, payments), closedError);
    assert.deepEqual(await api.getSale(tenant, id), before);
    await assert.rejects(() => api.createSale(tenant, { sessionId: session, lines }), closedError);
    assert.equal(await transaction(tenant, tx => tx.sale.count({ where: { tenantId: tenant } })), 1);
  });
});
test("i) paidAt hors ligne après clôture : accepté et rattaché", async () => { await reattach(api, true); });

test("sabotages sur copie : garde seule échoue g ; sans garde échoue b", async () => {
  const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".session-sabotage-"));
  const copy = join(directory, "caisse.ts");
  try {
    writeFileSync(copy, readFileSync(sourcePath));
    assert.equal(Buffer.compare(readFileSync(sourcePath), readFileSync(copy)), 0, "cmp avant sabotage");
    const source = readFileSync(copy, "utf8");
    const start = source.indexOf("export async function openSaleSession(");
    const end = source.indexOf("\nexport ", start + 10);
    const signature = source.slice(start, source.indexOf('  // Appelé', start));
    const replaceBody = (body: string) => source.slice(0, start) + signature + body + "\n}\n" + source.slice(end);
    writeFileSync(copy, replaceBody('  const session = await tx.cashSession.findFirst({ where: { tenantId, id: sessionId } });\n  if (session?.status !== "OPEN") throw new CashContractError("SESSION_NOT_OPEN", 409);\n  return sessionId;'));
    await assert.rejects(() => reattach(functions(readFileSync(copy, "utf8"))), closedError);
    writeFileSync(copy, replaceBody("  return sessionId;"));
    await assert.rejects(() => race(functions(readFileSync(copy, "utf8"))), /Missing expected rejection/);
    assert.equal(readFileSync(sourcePath, "utf8"), original, "production intacte");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
