import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { PrismaClient, Prisma } from "@prisma/client";

// Réouverture de la dernière caisse (2026-10-23) contre une VRAIE base : FOR UPDATE, RLS.
// Même montage que session-open.test.ts : DATABASE_URL = rôle applicatif (NOBYPASSRLS),
// app.current_tenant posé dans chaque transaction, fonctions de lib/caisse.ts extraites.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base de recette uniquement)");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });
const require = createRequire(import.meta.url);
const lib = fileURLToPath(new URL("../lib/", import.meta.url));
const source = readFileSync(join(lib, "caisse.ts"), "utf8");
const cache = new Map<string, any>();
function load(file: string): any {
  const path = resolve(lib, file.replace(/\.ts$/, "") + ".ts");
  if (cache.has(path)) return cache.get(path);
  if (path === join(lib, "caisse.ts")) return api;
  if (path === join(lib, "tenant.ts")) return { withTenant: transaction };
  const module = { exports: {} as any };
  cache.set(path, module.exports);
  const js = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const run = vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {
    Date, Error, Promise, Map, Set, WeakMap, BigInt, JSON, Number, String, Object, Array, console,
    URL, URLSearchParams, setTimeout, clearTimeout,
  });
  run((name: string) => name.startsWith(".") ? load(resolve(dirname(path), name)) : require(name), module, module.exports);
  return module.exports;
}
function transaction<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  }, { maxWait: 10000, timeout: 20000 });
}
function functions() {
  const globals: Record<string, any> = { Date, Error, BigInt, Prisma, randomUUID, withTenant: transaction };
  for (const file of ["cash-day-projection", "caisse-sync", "cash-day-guard", "cash-day-ledger", "money", "cash-movement", "gift-card", "z-report", "credit"]) {
    Object.assign(globals, load(file));
  }
  const context = vm.createContext(globals);
  const blocks = [
    source.slice(source.indexOf("export const REOPEN_MESSAGES"), source.indexOf("type ReopenResult")),
  ];
  for (const name of ["openSessionTx", "closeSessionTx", "reopenSessionTx"]) {
    const start = source.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, name);
    const end = source.indexOf("\nexport ", start + 10);
    blocks.push(source.slice(start, end < 0 ? undefined : end));
  }
  const js = ts.transpileModule(blocks.join("\n").replace(/export /g, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInContext(`${js}\n({ openSessionTx, closeSessionTx, reopenSessionTx })`, context);
}
const api = functions();
const reopenCashDay = load("cash-days").reopenCashDay as (tx: Prisma.TransactionClient, id: string, b: any) => Promise<any>;

async function cleanup(tenant: string) {
  await transaction(tenant, async tx => {
    await tx.cashSessionReopen.deleteMany({ where: { tenantId: tenant } });
    await tx.cashSession.deleteMany({ where: { tenantId: tenant } });
  });
}
const open = (tenant: string, actor: string, float: bigint) =>
  transaction(tenant, tx => api.openSessionTx(tx, tenant, { openedBy: actor, openingFloatXpf: float }));
const close = (tenant: string, sessionId: string, actor: string, counted: bigint) =>
  transaction(tenant, tx => api.closeSessionTx(tx, tenant, { sessionId, closedBy: actor, closingCountedXpf: counted }));
const reopen = (tenant: string, sessionId: string, by: string) =>
  transaction(tenant, tx => api.reopenSessionTx(tx, tenant, { sessionId, by }));

test("rouvre la dernière, trace, referme = nouveau Z, RLS réelle et politique présente", async () => {
  const tenant = randomUUID(), other = randomUUID(), actor = randomUUID();
  try {
    const o = await open(tenant, actor, 500n);
    assert.equal(o.ok, true);
    const id = o.session.id as string;
    const z1 = await close(tenant, id, actor, 400n);
    assert.equal(z1.ok, true); assert.equal(z1.alreadyClosed, false);

    // (1) réouverture
    const r = await reopen(tenant, id, "chef");
    assert.equal(r.ok, true, JSON.stringify(r));
    const s = await transaction(tenant, tx => tx.cashSession.findFirstOrThrow({ where: { id } }));
    assert.equal(s.status, "OPEN");
    for (const k of ["closedAt", "closedBy", "closedByName", "closingCountedXpf", "expectedXpf", "varianceXpf"] as const) assert.equal(s[k], null, k);
    const traces = await transaction(tenant, tx => tx.cashSessionReopen.findMany({ where: { tenantId: tenant, sessionId: id } }));
    assert.equal(traces.length, 1);
    assert.equal(traces[0].closingCountedXpf, 400n);
    assert.equal(traces[0].expectedXpf, 500n);
    assert.equal(traces[0].varianceXpf, -100n);
    assert.equal(traces[0].closedBy, actor);
    assert.equal(traces[0].reopenedBy, "chef");
    assert.ok(traces[0].closedAt);

    // (2) refermer = nouveau Z recalculé
    const z2 = await close(tenant, id, actor, 520n);
    assert.equal(z2.ok, true); assert.equal(z2.alreadyClosed, false);
    const s2 = await transaction(tenant, tx => tx.cashSession.findFirstOrThrow({ where: { id } }));
    assert.equal(s2.status, "CLOSED"); assert.ok(s2.closedAt);
    assert.equal(s2.varianceXpf, 20n); assert.equal(s2.closingCountedXpf, 520n);

    // (3) refus si une session plus récente existe
    const o2 = await open(tenant, actor, 0n);
    assert.equal(o2.ok, true);
    await close(tenant, o2.session.id, actor, 0n);
    const refus = await reopen(tenant, id, "chef");
    assert.equal(refus.ok, false);
    assert.equal(refus.error, "NOT_LAST_SESSION");
    assert.equal(refus.message, "Seule la dernière caisse fermée peut être rouverte.");

    // (4) rôle applicatif + autre tenant : trace invisible (RLS réelle)
    const [{ bypass }] = await prisma.$queryRaw<{ bypass: boolean }[]>`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
    assert.equal(bypass, false, "le test doit tourner sous le rôle applicatif");
    const seen = await transaction(other, tx => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "CashSessionReopen" WHERE "sessionId" = ${id}::uuid`);
    assert.equal(seen[0].n, 0n);
    const mine = await transaction(tenant, tx => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "CashSessionReopen" WHERE "sessionId" = ${id}::uuid`);
    assert.equal(mine[0].n, 1n);
    const crossReopen = await reopen(other, o2.session.id, "x");
    assert.equal(crossReopen.error, "SESSION_NOT_FOUND");

    // (5) politique RLS présente et FORCE actif
    const pol = await prisma.$queryRaw<{ policyname: string }[]>`SELECT policyname FROM pg_policies WHERE tablename = 'CashSessionReopen'`;
    assert.deepEqual(pol.map(p => p.policyname), ["tenant_isolation"]);
    const [rel] = await prisma.$queryRaw<{ rls: boolean; force: boolean }[]>`SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'CashSessionReopen'`;
    assert.equal(rel.rls, true); assert.equal(rel.force, true);
  } finally {
    await cleanup(tenant);
  }
});

test("CashDay : administration conserve son contrat même jour et jour passé", async () => {
  const tenant = randomUUID(), actor = randomUUID();
  const execute = async (businessDay: string, occurredAt: string, actionId: string) => {
    const { day, b } = await transaction(tenant, async tx => {
    const session = await tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor, status: "CLOSED", closedAt: new Date(occurredAt), openedAt: new Date(occurredAt), openingFloatXpf: 0n } });
    const day = await tx.cashDay.create({ data: { tenantId: tenant, businessDay, canonicalSessionId: session.id, currentSessionId: session.id } });
    await tx.cashDaySession.create({ data: { tenantId: tenant, cashDayId: day.id, sessionId: session.id, cycle: 0 } });
    const b = { tenantId: tenant, actionId, deviceId: "pg-test", entityKey: day.id, occurredAt, businessDay, actorId: actor, actorName: "Test", receivedById: actor, administration: true };
    return { day, b };
    });
    const result = await load("caisse-sync").cashAction(`cash-days:${day.id}:reopen`, b, (tx: Prisma.TransactionClient) => reopenCashDay(tx, day.id, b));
    return { day, result };
  };
  try {
    const today = new Date(Date.now() + 11 * 3600000).toISOString().slice(0, 10);
    const todayAt = new Date(`${today}T01:00:00.000Z`).toISOString();
    const same = await execute(today, todayAt, randomUUID());
    assert.equal(same.result.status, 200); assert.equal(same.result.body.data.status, "OPEN"); assert.equal(same.result.body.data.cycle, 1);
    const event = await transaction(tenant, tx => tx.cashDayEvent.findFirstOrThrow({ where: { tenantId: tenant, cashDayId: same.day.id, kind: "REOPEN" } }));
    assert.equal(event.snapshot.reopenMode, "ADMINISTRATION"); assert.equal(event.snapshot.actorId, actor);
    const openAgainRequest = {
      tenantId: tenant, actionId: randomUUID(), deviceId: "pg-test", entityKey: same.day.id, occurredAt: todayAt,
      businessDay: today, actorId: actor, actorName: "Test", receivedById: actor, administration: true,
    };
    const openAgain = await load("caisse-sync").cashAction(`cash-days:${same.day.id}:reopen`, openAgainRequest,
      (tx: Prisma.TransactionClient) => reopenCashDay(tx, same.day.id, openAgainRequest));
    assert.equal(openAgain.status, 409); assert.equal(openAgain.body.error, "DAY_ALREADY_OPEN");
    const past = new Date(Date.now() - 48 * 3600000 + 11 * 3600000).toISOString().slice(0, 10);
    const pastResult = await execute(past, new Date(`${past}T01:00:00.000Z`).toISOString(), randomUUID());
    assert.equal(pastResult.result.status, 409); assert.equal(pastResult.result.body.error, "DAY_MISMATCH");
  } finally { /* Faits de caisse immuables (IMMUTABLE_CASH_FACT) : tenant aléatoire, base jetable, rien à effacer. */ }
});

test("CashDay : mode caisse jour même rouvre, refusés, retard ignoré idempotent et OPEN ignoré", async () => {
  for (const toCloseEnabled of [false, true]) {
  const tenant = randomUUID(), actor = randomUUID();
  try {
    await transaction(tenant, tx => tx.cashSettings.create({ data: { tenantId: tenant, toCloseEnabled } }));
    const today = new Date(Date.now() + 11 * 3600000).toISOString().slice(0, 10);
    const at = new Date(`${today}T01:00:00.000Z`).toISOString();
    const session = await transaction(tenant, tx => tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor, status: "CLOSED", closedAt: new Date(at), openedAt: new Date(at), openingFloatXpf: 0n } }));
    const day = await transaction(tenant, async tx => {
      const d = await tx.cashDay.create({ data: { tenantId: tenant, businessDay: today, canonicalSessionId: session.id, currentSessionId: session.id } });
      await tx.cashDaySession.create({ data: { tenantId: tenant, cashDayId: d.id, sessionId: session.id, cycle: 0 } }); return d;
    });
    const receiver = randomUUID();
    const request = (actionId: string, extra: Record<string, unknown> = {}) => ({ tenantId: tenant, actionId, deviceId: "pg-test", entityKey: day.id, occurredAt: at, businessDay: today, actorId: actor, actorName: "Acteur réel", receivedById: receiver, reopenMode: "CAISSE_JOUR_MEME", ...extra });
    const apply = (b: any) => load("caisse-sync").cashAction(`cash-days:${day.id}:reopen`, b, (tx: Prisma.TransactionClient) => reopenCashDay(tx, day.id, b));
    const appliedRequest = request(randomUUID());
    const reopened = await apply(appliedRequest);
    assert.equal(reopened.status, 200); assert.equal(reopened.body.data.cycle, 1);
    const trace = await transaction(tenant, tx => tx.cashDayEvent.findFirstOrThrow({ where: { tenantId: tenant, cashDayId: day.id, kind: "REOPEN" } }));
    assert.equal(trace.snapshot.reopenMode, "CAISSE_JOUR_MEME"); assert.equal(trace.snapshot.actorId, actor); assert.equal(trace.snapshot.actorName, "Acteur réel"); assert.equal(trace.snapshot.receivedById, receiver);
    assert.equal(await transaction(tenant, tx => tx.cashDaySession.count({ where: { tenantId: tenant, cashDayId: day.id } })), 2);
    assert.deepEqual(await apply(appliedRequest), reopened, "rejeu de la réouverture appliquée renvoie le même accusé");
    const sessionsAfterReopen = await transaction(tenant, tx => tx.cashDaySession.count({ where: { tenantId: tenant, cashDayId: day.id } }));
    const ignoredOpen = await apply(request(randomUUID()));
    assert.equal(ignoredOpen.status, 200); assert.equal(ignoredOpen.body.data.ignored, true);
    assert.equal(ignoredOpen.body.data.cycle, 1);
    assert.equal(await transaction(tenant, tx => tx.cashDaySession.count({ where: { tenantId: tenant, cashDayId: day.id } })), sessionsAfterReopen);
    assert.equal(await transaction(tenant, tx => tx.cashDeposit.count({ where: { tenantId: tenant } })), 0);
    for (const extra of [{ reopenMode: "UNKNOWN" }, { reopenMode: undefined }, { actorId: undefined }]) {
      const denied = await apply(request(randomUUID(), extra)); assert.equal(denied.status, 403); assert.equal(denied.body.error, "MODE_CAISSE");
    }
    const past = new Date(Date.now() - 48 * 3600000 + 11 * 3600000).toISOString().slice(0, 10);
    const oldSession = await transaction(tenant, tx => tx.cashSession.create({ data: { tenantId: tenant, openedBy: actor, status: "CLOSED", closedAt: new Date(`${past}T01:00:00Z`), openedAt: new Date(`${past}T01:00:00Z`), openingFloatXpf: 0n } }));
    const oldDay = await transaction(tenant, async tx => { const d = await tx.cashDay.create({ data: { tenantId: tenant, businessDay: past, canonicalSessionId: oldSession.id, currentSessionId: oldSession.id } }); await tx.cashDaySession.create({ data: { tenantId: tenant, cashDayId: d.id, sessionId: oldSession.id, cycle: 0 } }); return d; });
    const late = { ...request(randomUUID()), entityKey: oldDay.id, businessDay: past, occurredAt: new Date(`${past}T01:00:00Z`).toISOString() };
    const lateApply = () => load("caisse-sync").cashAction(`cash-days:${oldDay.id}:reopen`, late, (tx: Prisma.TransactionClient) => reopenCashDay(tx, oldDay.id, late));
    const first = await lateApply(), replay = await lateApply();
    assert.equal(first.status, 200); assert.equal(first.body.data.ignored, true); assert.equal(first.body.data.code, "REOUVERTURE_TARDIVE");
    assert.deepEqual(replay, first);
    const lateState = await transaction(tenant, async tx => ({ day: await tx.cashDay.findFirstOrThrow({ where: { tenantId: tenant, id: oldDay.id } }),
      sessions: await tx.cashDaySession.count({ where: { tenantId: tenant, cashDayId: oldDay.id } }) }));
    assert.equal(lateState.day.cycle, 0); assert.equal(lateState.day.currentSessionId, oldSession.id); assert.equal(lateState.sessions, 1);
    assert.equal(await transaction(tenant, tx => tx.cashDeposit.count({ where: { tenantId: tenant, operation: "REOUVERTURE_TARDIVE", entityKey: past } })), 1);
    assert.equal(await transaction(tenant, tx => tx.cashDaySession.count({ where: { tenantId: tenant, cashDayId: oldDay.id } })), 1);
    // Horloge d'appareil fausse sur le jour du commerce : ignoré + conflit, jamais un 4xx qui bloquerait la file.
    const skewed = { ...request(randomUUID()), occurredAt: new Date(`${past}T01:00:00Z`).toISOString() };
    const skewedResult = await apply(skewed);
    assert.equal(skewedResult.status, 200); assert.equal(skewedResult.body.data.ignored, true); assert.equal(skewedResult.body.data.code, "REOUVERTURE_TARDIVE");
    assert.equal(await transaction(tenant, tx => tx.cashDaySession.count({ where: { tenantId: tenant, cashDayId: day.id } })), sessionsAfterReopen);
    assert.equal(await transaction(tenant, tx => tx.cashDeposit.count({ where: { tenantId: tenant, operation: "REOUVERTURE_TARDIVE", entityKey: today } })), 1);
  } finally { /* Faits de caisse immuables (IMMUTABLE_CASH_FACT) : tenant aléatoire, base jetable, rien à effacer. */ }
  }
});
