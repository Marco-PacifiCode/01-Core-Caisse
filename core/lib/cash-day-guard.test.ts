import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as refundPolicy from "./partial-refund.ts";
import * as projection from "./cash-day-projection.ts";
import * as credit from "./credit.ts";

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
  const days = mode === "standalone" || mode === "sale-only" ? [] : [{ id: dayId, tenantId: owner,
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
  const guard = load("cash-day-guard.ts", { "./tenant": { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) } });
  const writes: string[] = [];
  const native = Object.fromEntries(["openSession", "closeSession", "createSale", "checkoutSale", "annulerVente", "rembourserPartiellement"].map(name =>
    [name, async () => { writes.push(name); return { ok: true, session: { id: sessionId, openingFloatXpf: 25000n }, report: {}, saleId }; }]));
  const imports = {
    "@/lib/cash-day-guard": guard,
    "next/server": { NextResponse: { json: (body: unknown, options: Row = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/service-auth": { hasServiceKey: () => true }, "@/lib/caisse": native,
    "@/lib/tenant": {}, "@/lib/serialize": { xpf: Number }, "@/lib/partial-refund": refundPolicy,
    "@/lib/cash-day-projection": projection, "@/lib/credit": credit,
    "next/cache": { revalidatePath: () => {} }, "@/lib/guards": { requireStaff: async () => ({ user: { id: actionId }, tenant: { id: tenant } }) },
  };
  return { guard, writes, imports };
}
const cases: [string, Row][] = [
  ["sessions/route.ts", { openedBy: actionId }],
  ["sessions/[id]/close/route.ts", { closedBy: actionId, closingCountedXpf: 25000 }],
  ["sales/route.ts", { sessionId, lines: [{ kind: "OTHER", label: "Synthétique", qty: 1, unitXpf: 1000 }] }],
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
test("garde : vente liée directement, jour fermé, et exception d'avoir strictement du même CashDay", async () => {
  for (const mode of ["canonical", "alias", "sale-only"] as const) {
    const { guard } = fixture(mode, false);
    assert.equal(await guard.cashDayGuard(tenant, { saleId }), mode !== "sale-only");
    assert.equal(await guard.cashDayGuard(tenant, { saleId, refundCashDayId: dayId }), false);
    assert.equal(await guard.cashDayGuard(tenant, { saleId, refundCashDayId: actionId }), true);
    if (mode !== "sale-only") {
      assert.equal(await guard.cashDayGuard(tenant, { sessionId }), true);
      assert.equal(await guard.cashDayGuard(tenant, { openSession: true }), true);
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
