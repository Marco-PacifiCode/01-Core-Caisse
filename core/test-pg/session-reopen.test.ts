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
