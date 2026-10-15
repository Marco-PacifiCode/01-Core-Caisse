import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as refundPolicy from "./partial-refund.ts";
import * as projection from "./cash-day-projection.ts";
import * as credit from "./credit.ts";
import { createHash } from "node:crypto";

type Row = Record<string, any>;
const tenant = "10000000-0000-0000-0000-000000000001";
const sessionId = "10000000-0000-0000-0000-000000000002";
const saleId = "10000000-0000-0000-0000-000000000003";
const dayId = "10000000-0000-0000-0000-000000000004";
const actionId = "10000000-0000-0000-0000-000000000005";
function load(path: string, imports: Row) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as Row };
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`)(
    (name: string) => { assert.ok(name in imports, `import non injecté : ${name}`); return imports[name]; }, module, module.exports);
  return module.exports;
}
function fixture(mode: "canonical" | "alias" | "sale-only" | "standalone" | "other-tenant", open = true) {
  const owner = mode === "other-tenant" ? "autre-tenant" : tenant;
  const days = mode === "standalone" ? [] : [{ id: dayId, tenantId: owner,
    canonicalSessionId: mode === "alias" ? "canonique" : sessionId, currentSession: { status: open ? "OPEN" : "CLOSED" } }];
  const aliases = mode === "alias" ? [{ tenantId: tenant, sessionId, cashDayId: dayId }] : [];
  const sales = [{ id: saleId, tenantId: tenant, sessionId, cashDayId: mode === "sale-only" ? dayId : null }];
  const match = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" ? match(row[key] ?? {}, value) : row[key] === value);
  const tx = {
    cashDay: { findFirst: async ({ where }: Row) => days.find(row => match(row, where)) ?? null },
    cashDaySession: { findUnique: async ({ where }: Row) => aliases.find(row => match(row, where.tenantId_sessionId)) ?? null },
    sale: { findFirst: async ({ where }: Row) => sales.find(row => match(row, where)) ?? null },
  };
  const guard = load("cash-day-guard.ts", { "./tenant": { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) },
    "./caisse-sync": { lockCashTenant: async () => {}, uuid: (v: string) => v }, "./cash-day-projection": projection });
  const writes: string[] = [];
  const native = Object.fromEntries(["openSession", "closeSession", "createSale", "checkoutSale", "annulerVente", "rembourserPartiellement", "corrigerMoyenPaiement", "importerCloture"].map(name =>
    [name, async () => { writes.push(name); return { ok: true, session: { id: sessionId, openingFloatXpf: 25000n }, report: {}, saleId }; }]));
  const imports = {
    "@/lib/cash-day-guard": guard,
    "next/server": { NextResponse: { json: (body: unknown, options: Row = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/service-auth": { hasServiceKey: () => true }, "@/lib/caisse": native,
    "@/lib/log": { log: { info() {} } }, "@/lib/postes": { noterPosteHorsLigne: async () => {} },
    "@/lib/tenant": {}, "@/lib/serialize": { xpf: Number }, "@/lib/partial-refund": refundPolicy,
    "@/lib/cash-day-projection": projection, "@/lib/credit": credit,
    "next/cache": { revalidatePath: () => {} }, "@/lib/guards": { requireStaff: async () => ({ user: { id: actionId }, tenant: { id: tenant } }) },
  };
  return { guard, writes, imports };
}
const cases: [string, Row][] = [
  ["sessions/import/route.ts", { openedBy: actionId, openingFloatXpf: 25000, expectedXpf: 25000, closingCountedXpf: 25000 }],
  ["sales/[id]/payment-correction/route.ts", { fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 }],
  ["sessions/route.ts", { openedBy: actionId }],
  ["sessions/[id]/close/route.ts", { closedBy: actionId, closingCountedXpf: 25000 }],
  ["sales/route.ts", { sessionId, lines: [{ kind: "OTHER", label: "Synthétique", qty: 1, unitXpf: 1000 }] }],
  ["sales/route.ts", { lines: [{ kind: "OTHER", label: "Synthétique", qty: 1, unitXpf: 1000 }] }],
  ["sales/[id]/checkout/route.ts", { payments: [{ method: "CASH", amountXpf: 1000 }] }],
  ["sales/[id]/void/route.ts", {}],
  ["sales/[id]/partial-refund/route.ts", { actionId, reason: "Retour synthétique", lines: [{ lineId: actionId, qty: 1 }], refundMethod: "CARD" }],
];
for (const [path, body] of cases) {
  test(`garde HTTP ${path} : canonique/alias refusés sans écriture, tenants natifs inchangés`, async () => {
    for (const mode of ["canonical", "alias", "standalone", "other-tenant"] as const) {
      const f = fixture(mode), route = load(`../app/api/${path}`, f.imports);
      const id = path.startsWith("sessions/") ? sessionId : saleId;
      const response = await route.POST({ json: async () => ({ tenantId: tenant, ...body }), headers: new Headers() }, { params: Promise.resolve({ id }) });
      const blocked = mode === "canonical" || mode === "alias";
      assert.equal(response.status, blocked ? 409 : 200, String(response.body.error ?? mode));
      assert.equal(f.writes.length, blocked ? 0 : 1);
      if (blocked) assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED");
    }
  });
}
test("garde : tenant avec CashDay fermé, toute écriture historique et tout avoir refusés", async () => {
  for (const mode of ["canonical", "alias", "sale-only"] as const) {
    const { guard } = fixture(mode, false);
    assert.equal(await guard.cashDayGuard(tenant, { saleId }), true);
    assert.equal(await guard.cashDayGuard(tenant, { saleId, refundCashDayId: dayId }), true);
    assert.equal(await guard.cashDayGuard(tenant, { saleId, refundCashDayId: actionId }), true);
    if (mode !== "sale-only") {
      assert.equal(await guard.cashDayGuard(tenant, { sessionId }), true);
      assert.equal(await guard.cashDayGuard(tenant, { openSession: true }), true);
    }
  }
});
test("garde : seul un avoir vers un CashDay du tenant avec session courante OPEN passe", async () => {
  for (const mode of ["canonical", "alias", "sale-only"] as const) {
    const { guard } = fixture(mode);
    assert.equal(await guard.cashDayGuard(tenant, { saleId, refundCashDayId: dayId }), false);
    assert.equal(await guard.cashDayGuard(tenant, { saleId, refundCashDayId: actionId }), true);
    assert.equal(await guard.cashDayGuard(tenant, { sessionId: null }), true);
  }
});
test("garde : tenant sans aucun CashDay, false partout et comportement historique conservé", async () => {
  for (const mode of ["standalone", "other-tenant"] as const) {
    const { guard } = fixture(mode);
    for (const target of [{ saleId }, { sessionId }, { sessionId: null }, {}, { openSession: true },
      { saleId, refundCashDayId: dayId }, { saleId, refundCashDayId: actionId }]) {
      assert.equal(await guard.cashDayGuard(tenant, target), false);
    }
  }
});
test("void HTTP : CashContractError pendant la transaction renvoie 409", async () => {
  const f = fixture("standalone");
  f.imports["@/lib/caisse"].annulerVente = async () => { throw new projection.CashContractError("CASHDAY_ROUTE_REQUIRED", 409); };
  const route = load("../app/api/sales/[id]/void/route.ts", f.imports);
  const response = await route.POST({ json: async () => ({ tenantId: tenant }), headers: new Headers() }, { params: Promise.resolve({ id: saleId }) });
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED");
});

test("correction HTTP : vente rattachée au journal autorisée, même après clôture", async () => {
  for (const open of [true, false]) {
    const f = fixture("sale-only", open);
    const route = load("../app/api/sales/[id]/payment-correction/route.ts", f.imports);
    const response = await route.POST({ json: async () => ({ tenantId: tenant, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 }) },
      { params: Promise.resolve({ id: saleId }) });
    assert.equal(response.status, 200); assert.equal(f.writes.length, 1);
  }
});

test("import Z HTTP : CashContractError après la garde renvoie 409", async () => {
  const f = fixture("standalone");
  f.imports["@/lib/caisse"].importerCloture = async () => { throw new projection.CashContractError("CASHDAY_ROUTE_REQUIRED", 409); };
  const route = load("../app/api/sessions/import/route.ts", f.imports);
  const response = await route.POST({ json: async () => ({ tenantId: tenant, openedBy: actionId }) });
  assert.equal(response.status, 409); assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED");
});

test("verrous consultatifs : UUID majuscules et minuscules produisent la même clé normalisée", async () => {
  const sync = load("caisse-sync.ts", { "node:crypto": { createHash }, "./tenant": {}, "./cash-day-projection": projection });
  const seen: unknown[] = [];
  const tx = { $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) { seen.push(values[0]); return Promise.resolve([]); } };
  const lower = "abcdefab-cdef-abcd-efab-cdefabcdefab";
  const upper = lower.toUpperCase();
  assert.notEqual(lower, upper);
  await sync.lockCashTenant(tx, upper);
  await sync.lockCashTenant(tx, lower);
  assert.equal(seen[0], `cash-l4:${lower}`);
  assert.equal(seen[1], `cash-l4:${lower}`);
  await assert.rejects(sync.lockCashTenant(tx, "invalid-uuid"), (e: Row) => e.status === 400);
  assert.equal(seen.length, 2, "UUID invalide refusé avant la requête SQL");
});

test("verrou d'action : tenant et UUID d'action normalisés et invalides refusés en 400", async () => {
  const locks = load("sale-lock.ts", { "./cash-day-projection": projection });
  const seen: unknown[] = [];
  const tx = {
    $executeRaw: async () => [],
    $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) { seen.push(values[0]); return Promise.resolve([]); },
  };
  const lowerTenant = "abcdefab-cdef-abcd-efab-cdefabcdefab";
  const lowerAction = "fedcbafe-dcba-fedc-bafe-dcbafedcbafe";
  const upperTenant = lowerTenant.toUpperCase();
  const upperAction = lowerAction.toUpperCase();
  assert.notEqual(lowerTenant, upperTenant);
  assert.notEqual(lowerAction, upperAction);
  for (const prefix of ["action", "partial-action"]) {
    await locks.lockVoidResource(tx, upperTenant, `${prefix}:${upperAction}`);
    await locks.lockVoidResource(tx, lowerTenant, `${prefix}:${lowerAction}`);
    assert.equal(seen.at(-2), `${lowerTenant}:${prefix}:${lowerAction}`);
    assert.equal(seen.at(-1), `${lowerTenant}:${prefix}:${lowerAction}`);
  }
  assert.deepEqual(seen, [
    `${lowerTenant}:action:${lowerAction}`, `${lowerTenant}:action:${lowerAction}`,
    `${lowerTenant}:partial-action:${lowerAction}`, `${lowerTenant}:partial-action:${lowerAction}`,
  ]);
  await assert.rejects(locks.lockVoidResource(tx, "tenant-invalid", `action:${actionId}`), (e: Row) => e.status === 400);
  await assert.rejects(locks.lockVoidResource(tx, tenant, "action:invalid"), (e: Row) => e.status === 400);
});

test("routes historiques renvoient 409 si la transaction signale CASHDAY_ROUTE_REQUIRED", async () => {
  const targets: [string, string][] = [
    ["sessions/route.ts", "openSession"], ["sessions/[id]/close/route.ts", "closeSession"],
    ["sales/route.ts", "createSale"], ["movements/route.ts", "recordCashMovement"],
  ];
  const bodies: Row[] = [
    { tenantId: tenant, openedBy: actionId },
    { tenantId: tenant, closedBy: actionId, closingCountedXpf: 25000 },
    { tenantId: tenant, lines: [{ kind: "OTHER", label: "Synthétique", qty: 1, unitXpf: 1000 }] },
    { tenantId: tenant, kind: "CASH_OUT", amountXpf: 500, reason: "Retrait synthétique" },
  ];
  for (let i = 0; i < targets.length; i++) {
    const f = fixture("standalone");
    f.imports["@/lib/cash-movement"] = { isCashMovementKind: () => true, normalizeMovementAmount: () => ({ ok: true, amountXpf: 500n }),
      normalizeMovementReason: () => "retrait", normalizeMovementRef: () => null, PARTIAL_REFUND_REF_PREFIX: "partial-refund:" };
    f.imports["@/lib/caisse"][targets[i][1]] = async () => { throw new projection.CashContractError("CASHDAY_ROUTE_REQUIRED", 409); };
    const route = load(`../app/api/${targets[i][0]}`, f.imports);
    const response = await route.POST({ json: async () => bodies[i], headers: new Headers() }, { params: Promise.resolve({ id: sessionId }) });
    assert.equal(response.status, 409, targets[i][0]);
    assert.equal(response.body.error, "CASHDAY_ROUTE_REQUIRED");
  }
});

test("actions historiques traduisent les erreurs transactionnelles en erreur métier", async () => {
  for (const method of ["openSession", "closeSession", "createSale", "checkoutSale"]) {
    const f = fixture("standalone");
    f.imports["@/lib/caisse"][method] = async () => { throw new projection.CashContractError("CASHDAY_ROUTE_REQUIRED", 409); };
    const actions = load("../app/caisse/actions.ts", f.imports);
    if (method === "openSession") assert.equal(await actions.openSessionAction(25000), "CASHDAY_ROUTE_REQUIRED");
    if (method === "closeSession") assert.equal((await actions.closeSessionAction(sessionId, 25000)).error, "CASHDAY_ROUTE_REQUIRED");
    if (method === "createSale" || method === "checkoutSale") {
      const result = await actions.checkoutAction(sessionId, [{ kind: "OTHER", label: "Synthétique", qty: 1, unitXpf: 1000 }], [{ method: "CASH", amountXpf: 1000 }]);
      assert.equal(result.ok, false, method); assert.equal(result.error, "CASHDAY_ROUTE_REQUIRED", method);
    }
  }
});
test("actions serveur : refus avant toute écriture CashDay, comportement natif conservé", async () => {
  for (const mode of ["canonical", "alias", "standalone"] as const) {
    const f = fixture(mode), actions = load("../app/caisse/actions.ts", f.imports);
    const opened = await actions.openSessionAction(25000);
    const closed = await actions.closeSessionAction(sessionId, 25000);
    const paid = await actions.checkoutAction(sessionId, [{ kind: "OTHER", label: "Synthétique", qty: 1, unitXpf: 1000 }], [{ method: "CASH", amountXpf: 1000 }]);
    if (mode === "standalone") { assert.equal(opened, undefined); assert.equal(closed.ok, true); assert.equal(paid.ok, true); assert.equal(f.writes.length, 4); }
    else { assert.equal(opened, "CASHDAY_ROUTE_REQUIRED"); assert.equal(closed.error, "CASHDAY_ROUTE_REQUIRED"); assert.equal(paid.error, "CASHDAY_ROUTE_REQUIRED"); assert.equal(f.writes.length, 0); }
  }
});
