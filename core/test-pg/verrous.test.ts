// Recette PostgreSQL réelle : migrations + rls.sql, rôle applicatif sans BYPASSRLS.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import vm from "node:vm";
import ts from "typescript";
import { PrismaClient, type Prisma } from "@prisma/client";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL est obligatoire pour test:pg");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });

// Même chargeur que cash-day-db.test.ts : contourne les imports sans extension,
// sans remplacer Prisma ni les dépendances métier des fonctions testées.
const require = createRequire(import.meta.url);
function load(file: string, imports: Record<string, unknown>) {
  const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as any };
  const run = vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {
    Date, Error, Promise, Map, Set, WeakMap, BigInt, JSON, Number, String,
    Object, Array, URL, URLSearchParams, setTimeout, clearTimeout,
  });
  run((name: string) => name in imports ? imports[name] : require(name), module, module.exports);
  return module.exports;
}
const projection = load("cash-day-projection.ts", {});
const sync = load("caisse-sync.ts", {
  "./cash-day-projection.ts": projection,
  "./tenant.ts": { withTenant: () => { throw new Error("withTenant inutilisé dans cette recette"); } },
});
const locks = load("sale-lock.ts", {
  "./cash-day-projection": projection,
  "./caisse-sync": sync,
});

type Tx = Prisma.TransactionClient;
function transaction<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  }, { maxWait: 10000, timeout: 20000 });
}

// Le signal est émis APRÈS la prise effective. Toujours attendre les deux branches,
// même si une assertion échoue, avant de nettoyer les données ou déconnecter Prisma.
async function whileHeld(
  tenantId: string, lock: (tx: Tx) => Promise<unknown>, holdMs: number,
  contender: (releasingAt: () => number) => Promise<void>,
) {
  let signal!: () => void;
  let fail!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { signal = resolve; fail = reject; });
  // Heure où A cesse de tenir le verrou et lance son COMMIT. Pas l'heure où la promesse de
  // A se résout : la base libère le verrou au commit, avant que le client n'en reçoive
  // l'accusé, et B peut donc être servi avant (faux rouge observé sous ci-local).
  let releasingAt = Number.POSITIVE_INFINITY;
  const holder = transaction(tenantId, async tx => {
    await lock(tx);
    signal();
    await sleep(holdMs);
    releasingAt = performance.now();
  }).catch(error => { fail(error); throw error; });
  const other = (async () => { await ready; await contender(() => releasingAt); })();
  const results = await Promise.allSettled([holder, other]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

async function expectLockTimeout(attempt: () => Promise<unknown>) {
  const started = performance.now();
  await assert.rejects(attempt, (error: unknown) => error instanceof locks.SaleLockTimeoutError);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 2500 && elapsed <= 5000, `lock_timeout attendu en 2,5–5 s, reçu ${elapsed} ms`);
}

test("a) lockCashTenant termine la transaction", async () => {
  // Sans ::text, Prisma rejette la colonne void avec P2010 : ce test doit échouer.
  const tenantId = randomUUID();
  await transaction(tenantId, tx => sync.lockCashTenant(tx, tenantId));
});

test("b) lockCashTenant sérialise le même tenant et laisse passer un autre", async () => {
  const tenantId = randomUUID(), otherTenant = randomUUID();
  await whileHeld(tenantId, tx => sync.lockCashTenant(tx, tenantId), 1500, async releasingAt => {
    const sameStarted = performance.now();
    const same = transaction(tenantId, async tx => {
      await sync.lockCashTenant(tx, tenantId);
      return performance.now();
    });
    const different = (async () => {
      const started = performance.now();
      await transaction(otherTenant, tx => sync.lockCashTenant(tx, otherTenant));
      assert.ok(performance.now() - started < 1000, "un autre tenant ne doit pas attendre 1 s");
    })();
    const results = await Promise.allSettled([same, different]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const acquiredAt = (results[0] as PromiseFulfilledResult<number>).value;
    assert.ok(acquiredAt >= releasingAt(), "B doit obtenir le verrou après la fin de A");
    assert.ok(acquiredAt - sameStarted >= 1400, "B doit attendre la libération du verrou");
  });
});

test("c) lockVoidResource termine la transaction", async () => {
  // Sans ::text, Prisma rejette la colonne void avec P2010 : ce test doit échouer.
  const tenantId = randomUUID();
  await transaction(tenantId, tx => locks.lockVoidResource(tx, tenantId, `action:${randomUUID()}`));
});

test("d) lockVoidResource : timeout, autre ressource et validation", async () => {
  const tenantId = randomUUID(), resource = `action:${randomUUID()}`;
  await whileHeld(tenantId, tx => locks.lockVoidResource(tx, tenantId, resource), 5000, async () => {
    const started = performance.now();
    await transaction(tenantId, tx => locks.lockVoidResource(tx, tenantId, `action:${randomUUID()}`));
    assert.ok(performance.now() - started < 1000, "une autre ressource ne doit pas attendre 1 s");
    await expectLockTimeout(() => transaction(tenantId, tx => locks.lockVoidResource(tx, tenantId, resource)));
  });
  for (const invalid of ["mal-formee", "action:pas-un-uuid"]) {
    await assert.rejects(
      () => transaction(tenantId, tx => locks.lockVoidResource(tx, tenantId, invalid)),
      (error: unknown) => error instanceof projection.CashContractError
        && (error as Error).message === "INVALID_PAYLOAD",
    );
  }
});

async function withSale(fn: (tenantId: string, saleId: string) => Promise<void>) {
  const tenantId = randomUUID(), saleId = randomUUID();
  // SQL brut et non `tx.sale.create` : les migrations ne créent pas `Sale.posteId`
  // (ajoutée en prod par prisma/manual/2026-08-15_postes_de_caisse.sql), que le client
  // Prisma relirait. Seules colonnes sans défaut : id, tenantId, updatedAt.
  await transaction(tenantId, tx => tx.$executeRaw`
    INSERT INTO "Sale" (id, "tenantId", "updatedAt") VALUES (${saleId}::uuid, ${tenantId}::uuid, now())`);
  try { await fn(tenantId, saleId); }
  finally { await transaction(tenantId, tx => tx.$executeRaw`DELETE FROM "Sale" WHERE id = ${saleId}::uuid`); }
}

test("e) lockSaleRow : existence et isolation RLS", async () => {
  await withSale(async (tenantB, saleId) => {
    const tenantA = randomUUID();
    assert.equal(await transaction(tenantB, tx => locks.lockSaleRow(tx, saleId, tenantB)), true);
    assert.equal(await transaction(tenantB, tx => locks.lockSaleRow(tx, randomUUID(), tenantB)), false);
    assert.equal(await transaction(tenantA, tx => locks.lockSaleRow(tx, saleId, tenantA)), false);
    // Passer le tenant propriétaire au filtre SQL prouve que la RLS elle-même filtre.
    assert.equal(await transaction(tenantA, tx => locks.lockSaleRow(tx, saleId, tenantB)), false);
  });
});

test("f) lockSaleRow : timeout puis acquisition après commit", async () => {
  await withSale(async (tenantId, saleId) => {
    await whileHeld(tenantId, async tx => {
      assert.equal(await locks.lockSaleRow(tx, saleId, tenantId), true);
    }, 5000, async () => {
      await expectLockTimeout(() => transaction(tenantId, tx => locks.lockSaleRow(tx, saleId, tenantId)));
    });
    assert.equal(await transaction(tenantId, tx => locks.lockSaleRow(tx, saleId, tenantId)), true);
  });
});
