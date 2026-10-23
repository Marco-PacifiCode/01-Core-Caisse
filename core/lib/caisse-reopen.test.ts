// Réouverture de la dernière caisse fermée (2026-10-23) — ports Prisma simulés, sans DB.
// La RLS PostgreSQL est portée par la migration ; ici l'isolation est prouvée par les filtres tenantId.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type Row = Record<string, any>;
const T = "ab000000-0000-0000-0000-000000000001", T2 = "cd000000-0000-0000-0000-000000000002";
const source = readFileSync(new URL("caisse.ts", import.meta.url), "utf8");

function fn(name: string, globals: Row) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\nexport ", start + 10);
  const js = ts.transpileModule(source.slice(start, end < 0 ? undefined : end).replace("export ", ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${js}\n${name}`, { Date, BigInt, ...globals });
}
function pureExports() {
  const start = source.indexOf("export const REOPEN_MESSAGES");
  const end = source.indexOf("type ReopenResult");
  const js = ts.transpileModule(source.slice(start, end).replace(/export /g, ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${js}\n({ REOPEN_MESSAGES, refusReouverture })`, {});
}
const pure = pureExports();

function match(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return row[k] !== v.not;
      if ("gte" in v) return row[k] >= v.gte;
    }
    return (row[k] ?? null) === v;
  });
}
function fakeDb() {
  const db = { cashSession: [] as Row[], cashSessionReopen: [] as Row[] };
  let n = 0;
  const tx = {
    $queryRaw: async () => [],
    cashSession: {
      findFirst: async ({ where }: Row) => db.cashSession.find(r => match(r, where)) ?? null,
      update: async ({ where, data }: Row) => Object.assign(db.cashSession.find(r => r.id === where.id)!, data),
    },
    cashSessionReopen: {
      create: async ({ data }: Row) => { const r = { id: `r${++n}`, reopenedAt: new Date(), ...data }; db.cashSessionReopen.push(r); return r; },
    },
  };
  return { db, tx };
}
function load() {
  return fn("reopenSessionTx", { uuid: (x: string) => x, lockCashTenant: async () => {}, refusReouverture: pure.refusReouverture, REOPEN_MESSAGES: pure.REOPEN_MESSAGES });
}
const closed = (id: string, at: string, extra: Row = {}) => ({
  id, tenantId: T, posteId: null, status: "CLOSED", openedAt: new Date(at), closedAt: new Date(at.replace("T08", "T18")),
  closedBy: "u1", closedByName: "Ana", closingCountedXpf: 1000n, expectedXpf: 1200n, varianceXpf: -200n, ...extra,
});

test("rouvre la dernière : OPEN, champs de clôture à null, trace créée", async () => {
  const { db, tx } = fakeDb();
  db.cashSession.push(closed("s1", "2026-10-21T08:00:00Z"), closed("s2", "2026-10-22T08:00:00Z"));
  const r = await load()(tx, T, { sessionId: "s2", by: "chef" });
  assert.equal(r.ok, true);
  const s = db.cashSession.find(x => x.id === "s2")!;
  assert.equal(s.status, "OPEN");
  for (const k of ["closedAt", "closedBy", "closedByName", "closingCountedXpf", "expectedXpf", "varianceXpf"]) assert.equal(s[k], null, k);
  assert.equal(db.cashSessionReopen.length, 1);
  const t = db.cashSessionReopen[0];
  assert.equal(t.tenantId, T); assert.equal(t.sessionId, "s2"); assert.equal(t.closingCountedXpf, 1000n);
  assert.equal(t.expectedXpf, 1200n); assert.equal(t.varianceXpf, -200n); assert.equal(t.closedBy, "u1"); assert.equal(t.reopenedBy, "chef");
});

test("refus si une session plus récente existe", async () => {
  const { db, tx } = fakeDb();
  db.cashSession.push(closed("s1", "2026-10-21T08:00:00Z"), closed("s2", "2026-10-22T08:00:00Z"));
  const r = await load()(tx, T, { sessionId: "s1" });
  assert.deepEqual({ ...r }, { ok: false, error: "NOT_LAST_SESSION", message: "Seule la dernière caisse fermée peut être rouverte." });
  assert.equal(db.cashSessionReopen.length, 0);
});

test("refus si une session est déjà ouverte sur la portée", async () => {
  const { db, tx } = fakeDb();
  db.cashSession.push(closed("s1", "2026-10-22T08:00:00Z"), { ...closed("s0", "2026-10-20T08:00:00Z"), status: "OPEN" });
  const r = await load()(tx, T, { sessionId: "s1" });
  assert.equal(r.error, "SESSION_ALREADY_OPEN"); assert.equal(r.message, "Une caisse est déjà ouverte.");
});

test("refus si la session n'est pas CLOSED", async () => {
  const { db, tx } = fakeDb();
  db.cashSession.push({ ...closed("s1", "2026-10-22T08:00:00Z"), status: "OPEN" });
  const r = await load()(tx, T, { sessionId: "s1" });
  assert.equal(r.error, "SESSION_NOT_CLOSED"); assert.equal(r.message, "Cette caisse n'est pas fermée.");
});

test("portée poste : une session d'un autre poste ne bloque pas", async () => {
  const { db, tx } = fakeDb();
  db.cashSession.push(closed("a", "2026-10-21T08:00:00Z", { posteId: "P1" }), closed("b", "2026-10-22T08:00:00Z", { posteId: "P2", status: "OPEN" }));
  const r = await load()(tx, T, { sessionId: "a" });
  assert.equal(r.ok, true);
});

test("isolation tenant : session d'un autre marchand introuvable, et ses sessions ne bloquent pas", async () => {
  const { db, tx } = fakeDb();
  db.cashSession.push(closed("s1", "2026-10-21T08:00:00Z"), closed("x", "2026-10-22T08:00:00Z", { tenantId: T2 }));
  assert.equal((await load()(tx, T2, { sessionId: "s1" })).error, "SESSION_NOT_FOUND");
  assert.equal((await load()(tx, T, { sessionId: "s1" })).ok, true);
  assert.equal(db.cashSessionReopen[0].tenantId, T);
});

test("refermer après réouverture produit un nouveau Z (closeSessionTx recalcule, pas alreadyClosed)", async () => {
  // closeSessionTx ne prend la branche « déjà clôturée / figée » que si status === CLOSED
  // (cf. caisse.ts) : une session rouverte est OPEN, donc la clôture suivante recalcule et réécrit.
  const start = source.indexOf("export async function closeSessionTx(");
  const body = source.slice(start, source.indexOf("\nexport ", start + 10));
  assert.match(body, /if \(session\.status === "CLOSED"\)/);
  assert.match(body, /status: "CLOSED",\s*closedAt: new Date\(\)/);
  const { db, tx } = fakeDb();
  db.cashSession.push(closed("s1", "2026-10-22T08:00:00Z"));
  await load()(tx, T, { sessionId: "s1" });
  assert.equal(db.cashSession[0].status, "OPEN");
  assert.equal(db.cashSession[0].expectedXpf, null);
});
