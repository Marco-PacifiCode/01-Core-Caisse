// Vraie base (`npm run test:pg`) — démo privée : registre TenantMaquette, inscrire_tenant_maquette et
// effacer_tenant_maquette (migration 20261111130000_tenant_maquette).
//
// Harnais : migrations puis prisma/rls.sql joués par le PROPRIÉTAIRE (core_caisse_owner) ;
// DATABASE_URL = rôle applicatif core_caisse_app (NOSUPERUSER NOBYPASSRLS). Le cas (d) vérifie aussi
// qu'un rôle étranger (MAQUETTE_ROLE_ETRANGER, défaut caisse_etranger, s'il existe) ne peut pas
// appeler les fonctions. Le semis réel (lib/maquette-semis.ts) est chargé par la même mécanique que
// test-pg/cash-deposit-apply.test.ts (fonctions métier transpilées, caisse.ts découpé).
//
// SABOTAGES — un par garde, chacun JOUÉ une fois sur base jetable postgres:16 (11/11) et rétabli :
//   garde 1 (inscription) : retirer 'Sale' du tableau d'inscrire_tenant_maquette
//       → « (g) inscription refusée … » échoue (le tenant qui a une vente est inscrit).
//   garde 2 (lock_timeout) : retirer `set_config('lock_timeout', '3s', true)` de la fonction
//       → « (a) verrou tenu … » échoue (l'appel fait la queue au-delà du délai du test).
//   garde 3 (antériorité) : remplacer la condition MAQUETTE_FAIT_ANTERIEUR par `IF false THEN`
//       → « (c) fait l4 antérieur … » échoue (le tenant est effacé).
//   garde 4 (contexte avant contrôles) : retirer de effacer_tenant_maquette le
//       `set_config('app.current_tenant', p_tenant::text, true)` posé avant les contrôles
//       → « (b) non inscrit … » échoue (tout lu hors contexte paraît vide : compteurs à zéro au lieu
//       du refus ; (f) échoue aussi, rien n'est effacé).
//   garde 5 (droits) : `GRANT INSERT, DELETE ON "TenantMaquette" TO core_caisse_app`
//       → « (d) le rôle applicatif ne peut ni INSERT … » échoue.
//
// Données inventées, tenants aléatoires : aucune donnée réelle.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { Prisma, PrismaClient } from "@prisma/client";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base de recette uniquement)");
const prisma = new PrismaClient();
const second = new PrismaClient();
after(async () => { await prisma.$disconnect(); await second.$disconnect(); });
type Tx = Prisma.TransactionClient;
const ETRANGER = process.env.MAQUETTE_ROLE_ETRANGER ?? "caisse_etranger";

// ── Chargement des fonctions métier (même mécanique que cash-deposit-apply.test.ts) ───────────────
const require = createRequire(import.meta.url), lib = fileURLToPath(new URL("../lib/", import.meta.url));
let currentTx: Tx | null = null;
function chez<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, client: PrismaClient = prisma) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  }, { maxWait: 20000, timeout: 120000 });
}
function transaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return currentTx ? fn(currentTx) : chez(tenantId, fn);
}
const native: Record<string, any> = {}, cache = new Map<string, any>();
function load(file: string): any {
  const path = resolve(lib, file.replace(/\.ts$/, "") + ".ts");
  if (path === resolve(lib, "tenant.ts")) return { withTenant: transaction };
  if (path === resolve(lib, "caisse.ts")) return native;
  if (cache.has(path)) return cache.get(path);
  const module = { exports: {} as any }; cache.set(path, module.exports);
  const source = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const run = vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { Date, Error, Promise, Map, Set, WeakMap,
    BigInt, JSON, Number, String, Object, Array, Buffer, URL, URLSearchParams, Math, console: { warn() {}, log() {}, error() {} } });
  run((name: string) => name.startsWith(".") ? load(resolve(dirname(path), name)) : require(name), module, module.exports);
  return module.exports;
}
const globals: Record<string, any> = { Date, Error, BigInt, Prisma, randomUUID, createHash, withTenant: transaction };
for (const file of ["cash-day-projection", "caisse-sync", "cash-day-guard", "cash-day-ledger", "sale-lock", "money", "cash-movement", "gift-card", "z-report", "credit", "sync", "partial-refund", "partial-refund-db"]) Object.assign(globals, load(file));
globals.log = { warn() {}, error() {} }; globals.assertTenantId = (value: string) => value;
const context = vm.createContext(globals), caisseSource = readFileSync(resolve(lib, "caisse.ts"), "utf8");
for (const name of ["openSessionTx", "closeSessionTx"]) {
  const start = caisseSource.indexOf(`export async function ${name}(`), end = caisseSource.indexOf("\nexport ", start + 10);
  assert.ok(start >= 0, name);
  const js = ts.transpileModule(caisseSource.slice(start, end < 0 ? undefined : end).replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  native[name] = globals[name] = vm.runInContext(`${js}\n${name}`, context);
}
const semis = load("maquette-semis"), maquette = load("maquette");

// ── Outils ───────────────────────────────────────────────────────────────────────────────────────
const L4 = ["CashDayEvent", "CashDayClosure", "CashDayOpening", "CashDaySession"];
let tablesTenant: string[] = [];
async function tables(): Promise<string[]> {
  if (!tablesTenant.length) {
    const r = await prisma.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'tenantId' AND table_name <> 'TenantMaquette' ORDER BY 1`;
    tablesTenant = r.map(x => x.t);
  }
  return tablesTenant;
}
async function compter(t: string): Promise<Record<string, number>> {
  const ts_ = await tables();
  return chez(t, async tx => {
    const out: Record<string, number> = {};
    for (const table of ts_) {
      const r = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1::uuid`, t);
      out[table] = r[0].n;
    }
    return out;
  });
}
const total = (c: Record<string, number>) => Object.values(c).reduce((s, n) => s + n, 0);
const effacer = (t: string, client: PrismaClient = prisma, contexte = t) =>
  chez(contexte, tx => tx.$queryRaw<{ c: Record<string, number> }[]>`SELECT effacer_tenant_maquette(${t}::uuid) AS c`, client).then(r => r[0].c);
/** Effacement appelé depuis le contexte d'un AUTRE tenant : la fonction doit poser le sien, puis rendre celui de l'appelant. */
const effacerDepuis = (contexte: string, t: string) => chez(contexte, async tx => {
  const [{ c }] = await tx.$queryRaw<{ c: Record<string, number> }[]>`SELECT effacer_tenant_maquette(${t}::uuid) AS c`;
  const [{ apres }] = await tx.$queryRaw<{ apres: string }[]>`SELECT current_setting('app.current_tenant', true) AS apres`;
  assert.equal(apres, contexte, "contexte de l'appelant rétabli");
  return c;
});
const inscrire = (t: string) =>
  chez(t, tx => tx.$queryRaw<{ i: boolean }[]>`SELECT inscrire_tenant_maquette(${t}::uuid) AS i`).then(r => r[0].i);
const inscrit = (t: string) => chez(t, tx => tx.tenantMaquette.findUnique({ where: { tenantId: t } }));
async function declencheursActifs() {
  const r = await prisma.$queryRaw<{ n: string; e: string }[]>`SELECT tgname AS n, tgenabled::text AS e FROM pg_trigger
    WHERE tgname IN ('cash_event_immutable','cash_closure_immutable','cash_opening_immutable','cash_alias_immutable') ORDER BY 1`;
  assert.equal(r.length, 4);
  for (const x of r) assert.equal(x.e, "O", `${x.n} doit rester actif`);
}
const refuse = async (p: Promise<unknown>, motif: RegExp) =>
  assert.rejects(p, (e: unknown) => motif.test(String((e as Error)?.message ?? e) + JSON.stringify((e as any)?.meta ?? null)), String(motif));

const JEU = { articles: [{ nom: "Poulet rôti", prix: 1800, tgc: 11 }, { nom: "Frites", prix: 500, tgc: 11 }, { nom: "Boisson", prix: 300, tgc: 22 }],
  ticketsParJour: { min: 2, max: 4 }, jours: 3 };
/** Semis réel (comme la route) : inscription puis journées, dans UNE transaction. */
const semer = (t: string, jeu = JEU) => chez(t, async tx => {
  const [{ i }] = await tx.$queryRaw<{ i: boolean }[]>`SELECT inscrire_tenant_maquette(${t}::uuid) AS i`;
  if (!i) return { deja: true };
  return { deja: false, compteurs: await semis.semerJournees(tx, t, maquette.planifierSemis(jeu, t, new Date())) };
});
/** Une vente et ses faits l4, écrits directement (tenant « réel », jamais inscrit). */
async function venteReelle(t: string, receivedAt?: Date) {
  const session = randomUUID(), jour = randomUUID(), vente = randomUUID();
  await chez(t, async tx => {
    await tx.$executeRaw`INSERT INTO "CashSession" ("id","tenantId","openedBy") VALUES (${session}::uuid, ${t}::uuid, ${t}::uuid)`;
    await tx.$executeRaw`INSERT INTO "CashDay" ("id","tenantId","businessDay","canonicalSessionId","currentSessionId","updatedAt")
      VALUES (${jour}::uuid, ${t}::uuid, '2026-11-01', ${session}::uuid, ${session}::uuid, now())`;
    await tx.$executeRaw`INSERT INTO "Sale" ("id","tenantId","sessionId","status","totalXpf","subtotalXpf","updatedAt","cashDayId")
      VALUES (${vente}::uuid, ${t}::uuid, ${session}::uuid, 'PAID', 1000, 1000, now(), ${jour}::uuid)`;
    await tx.$executeRaw`INSERT INTO "CashDayEvent" ("id","tenantId","cashDayId","sequence","kind","sourceRef","saleId","deviceId","occurredAt","cashDeltaXpf","snapshot","receivedAt")
      VALUES (${randomUUID()}::uuid, ${t}::uuid, ${jour}::uuid, 1, 'SALE_PAID', ${vente}, ${vente}::uuid, 'pg', now(), 1000, '{}'::jsonb, ${receivedAt ?? new Date()})`;
  });
  return { session, jour, vente };
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────

test("rôle applicatif soumis à la RLS", async () => {
  const [{ bypass }] = await prisma.$queryRaw<{ bypass: boolean }[]>`SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  assert.equal(bypass, false, "le test exige le rôle applicatif RLS");
});

test("semer idempotent : 2e inscription → faux, rien n'est réécrit", async () => {
  const t = randomUUID();
  const r1 = await semer(t);
  assert.equal(r1.deja, false);
  const avant = await compter(t);
  assert.deepEqual(await semer(t), { deja: true });
  assert.equal(await inscrire(t), false);
  assert.deepEqual(await compter(t), avant);
  await effacer(t);
});

test("(f) tenant inscrit et semé : effacé ENTIÈREMENT, voisin intact, registre vidé, 2e appel à zéro ; (a) déclencheurs actifs", async () => {
  const t = randomUUID(), voisin = randomUUID(), reel = randomUUID();
  const r = await semer(t);
  assert.equal(r.deja, false);
  assert.ok((r as any).compteurs.ventes > 0);
  await semer(voisin);
  await venteReelle(reel);
  const avant = await compter(t), voisinAvant = await compter(voisin), reelAvant = await compter(reel);
  for (const table of [...L4, "CashDay", "CashSession", "Sale", "SaleLine", "SalePayment"]) assert.ok(avant[table] > 0, `semis : ${table}`);
  // Point D : les ventes semées ne sont jamais à reprendre (Compta/Stock).
  const enAttente = await chez(t, tx => tx.sale.count({ where: { tenantId: t, status: "PAID", OR: [{ comptaSyncedAt: null }, { stockSyncedAt: null }] } }));
  assert.equal(enAttente, 0);
  // Les dates d'écriture des faits l4 ne sont PAS antidatées.
  const ins = (await inscrit(t))!.inscritLe;
  const [{ min }] = await chez(t, tx => tx.$queryRaw<{ min: Date }[]>`SELECT min("receivedAt") AS min FROM "CashDayEvent" WHERE "tenantId" = ${t}::uuid`);
  assert.ok(min.getTime() >= ins.getTime() - 1);

  const c = await effacerDepuis(voisin, t);
  assert.equal(total(c), total(avant));
  for (const [table, n] of Object.entries(avant)) assert.equal(c[table], n, table);
  assert.equal(total(await compter(t)), 0);
  assert.equal(await inscrit(t), null);
  assert.deepEqual(await compter(voisin), voisinAvant);
  assert.deepEqual(await compter(reel), reelAvant);
  assert.ok(await inscrit(voisin));
  await declencheursActifs();
  const encore = await effacer(t);
  assert.equal(total(encore), 0);
  assert.deepEqual(Object.keys(encore).sort(), [...(await tables())].sort());
  await effacer(voisin);
});

test("(b) tenant NON inscrit qui a des ventes : refusé, toutes ses lignes restent", async () => {
  const t = randomUUID();
  await venteReelle(t);
  const avant = await compter(t);
  await refuse(effacer(t), /MAQUETTE_NON_INSCRITE/);
  await refuse(effacer(t, prisma, randomUUID()), /MAQUETTE_NON_INSCRITE/);
  assert.deepEqual(await compter(t), avant);
  await declencheursActifs();
});

test("(c) tenant inscrit puis fait l4 dont receivedAt est antérieur à l'inscription : refusé", async () => {
  const t = randomUUID();
  assert.equal(await inscrire(t), true);
  await venteReelle(t, new Date("2000-01-01T00:00:00Z"));
  const avant = await compter(t);
  await refuse(effacer(t), /MAQUETTE_FAIT_ANTERIEUR/);
  assert.deepEqual(await compter(t), avant);
  assert.ok(await inscrit(t));
  await declencheursActifs();
});

test("(d) le rôle applicatif ne peut ni INSERT, ni UPDATE, ni DELETE sur TenantMaquette ; un autre rôle ne peut pas appeler les fonctions", async () => {
  const t = randomUUID();
  assert.equal(await inscrire(t), true);
  await refuse(chez(randomUUID(), async tx => { const x = randomUUID(); await tx.$executeRaw`SELECT set_config('app.current_tenant', ${x}, true)`;
    await tx.$executeRaw`INSERT INTO "TenantMaquette" ("tenantId") VALUES (${x}::uuid)`; }), /permission denied|42501/);
  await refuse(chez(t, tx => tx.$executeRaw`UPDATE "TenantMaquette" SET "inscritLe" = now() - interval '10 days' WHERE "tenantId" = ${t}::uuid`), /permission denied|42501/);
  await refuse(chez(t, tx => tx.$executeRaw`DELETE FROM "TenantMaquette" WHERE "tenantId" = ${t}::uuid`), /permission denied|42501/);
  await refuse(chez(t, tx => tx.$executeRaw`TRUNCATE "TenantMaquette"`), /permission denied|42501/);
  assert.ok(await inscrit(t));
  const droits = await prisma.$queryRaw<{ r: string; i: boolean; e: boolean }[]>`SELECT r,
      has_function_privilege(r, 'inscrire_tenant_maquette(uuid)', 'EXECUTE') AS i,
      has_function_privilege(r, 'effacer_tenant_maquette(uuid)', 'EXECUTE') AS e
    FROM unnest(ARRAY['public', current_user::text]
      || CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ETRANGER}) THEN ARRAY[${ETRANGER}::text] ELSE ARRAY[]::text[] END) AS r`;
  for (const d of droits) {
    const attendu = d.r !== "public" && d.r !== ETRANGER;
    assert.equal(d.i, attendu, `inscrire pour ${d.r}`);
    assert.equal(d.e, attendu, `effacer pour ${d.r}`);
  }
  assert.ok(droits.some(d => d.r === ETRANGER), `rôle étranger ${ETRANGER} absent : volet non prouvé`);
  const [{ definer }] = await prisma.$queryRaw<{ definer: boolean }[]>`SELECT bool_and(prosecdef) AS definer FROM pg_proc WHERE proname IN ('inscrire_tenant_maquette','effacer_tenant_maquette')`;
  assert.equal(definer, true);
  await effacer(t);
});

test("(e) UPDATE ou DELETE direct du rôle applicatif sur CashDayEvent d'un tenant INSCRIT : toujours IMMUTABLE_CASH_FACT", async () => {
  const t = randomUUID();
  await semer(t);
  await refuse(chez(t, tx => tx.$executeRaw`UPDATE "CashDayEvent" SET "deviceId" = 'x' WHERE "tenantId" = ${t}::uuid`), /IMMUTABLE_CASH_FACT/);
  await refuse(chez(t, tx => tx.$executeRaw`DELETE FROM "CashDayEvent" WHERE "tenantId" = ${t}::uuid`), /IMMUTABLE_CASH_FACT/);
  await refuse(chez(t, tx => tx.$executeRaw`DELETE FROM "CashDayClosure" WHERE "tenantId" = ${t}::uuid`), /IMMUTABLE_CASH_FACT/);
  await refuse(chez(t, tx => tx.$executeRaw`ALTER TABLE "CashDayEvent" DISABLE TRIGGER cash_event_immutable`), /must be owner|42501/);
  await effacer(t);
});

test("(g) l'inscription d'un tenant qui a déjà une vente ou un fait l4 est refusée", async () => {
  const avecVente = randomUUID();
  await chez(avecVente, tx => tx.$executeRaw`INSERT INTO "Sale" ("id","tenantId","status","updatedAt") VALUES (${randomUUID()}::uuid, ${avecVente}::uuid, 'DRAFT', now())`);
  await refuse(inscrire(avecVente), /MAQUETTE_INSCRIPTION_REFUSEE/);
  assert.equal(await inscrit(avecVente), null);
  const avecFait = randomUUID();
  await venteReelle(avecFait);
  await refuse(inscrire(avecFait), /MAQUETTE_INSCRIPTION_REFUSEE/);
  assert.equal(await inscrit(avecFait), null);
});

test("(a) verrou tenu sur CashDayEvent pendant l'appel : échec en ~3 s (lock_timeout), rien d'effacé, déclencheurs actifs", async () => {
  const t = randomUUID();
  await semer(t);
  const avant = await compter(t);
  let liberer!: () => void;
  const tenu = new Promise<void>(r => { liberer = r; });
  let pris!: () => void;
  const verrouPris = new Promise<void>(r => { pris = r; });
  const autre = second.$transaction(async tx => {
    await tx.$executeRawUnsafe(`LOCK TABLE "CashDayEvent" IN ROW EXCLUSIVE MODE`);
    pris();
    await tenu;
  }, { maxWait: 20000, timeout: 60000 });
  await verrouPris;
  const debut = Date.now();
  try {
    await refuse(effacer(t), /55P03|lock timeout/i);
  } finally { liberer(); await autre; }
  assert.ok(Date.now() - debut < 20000, "l'appel ne fait pas la queue");
  assert.deepEqual(await compter(t), avant);
  assert.ok(await inscrit(t));
  await declencheursActifs();
  await effacer(t);
});

test("(a) erreur AU MILIEU de la fonction (déclencheurs déjà désactivés) : tout est annulé, déclencheurs actifs", async () => {
  const t = randomUUID();
  await semer(t);
  const avant = await compter(t);
  const [{ id }] = await chez(t, tx => tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Sale" WHERE "tenantId" = ${t}::uuid LIMIT 1`);
  let liberer!: () => void;
  const tenu = new Promise<void>(r => { liberer = r; });
  let pris!: () => void;
  const verrouPris = new Promise<void>(r => { pris = r; });
  // Verrou de LIGNE sur une vente : les ALTER passent, le DELETE FROM "Sale" échoue sur lock_timeout.
  const autre = chez(t, async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Sale" WHERE "id" = ${id}::uuid FOR UPDATE`;
    pris();
    await tenu;
  }, second);
  await verrouPris;
  try {
    await refuse(effacer(t), /55P03|lock timeout/i);
  } finally { liberer(); await autre; }
  assert.deepEqual(await compter(t), avant);
  assert.ok(await inscrit(t));
  await declencheursActifs();
  await effacer(t);
  await declencheursActifs();
});
