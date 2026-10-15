import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const libDir = path.dirname(fileURLToPath(import.meta.url));
function load(file: string, imports: Record<string, unknown>) {
  const source = readFileSync(path.join(libDir, file), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as Record<string, any> };
  const run = vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {});
  run((name: string) => name in imports ? imports[name] : require(name), module, module.exports);
  return module.exports;
}

const projection = load("cash-day-projection.ts", {});
const tenantModule = { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn({}) };
const sync = load("caisse-sync.ts", {
  "./tenant": tenantModule,
  "./tenant.ts": tenantModule,
  "./cash-day-projection": projection,
  "./cash-day-projection.ts": projection,
  "node:crypto": require("node:crypto"),
});
const guard = load("cash-day-guard.ts", {
  "./tenant": tenantModule,
  "./tenant.ts": tenantModule,
  "./caisse-sync": sync,
  "./cash-day-projection": projection,
  "./cash-day-projection.ts": projection,
});

function route(file: string, calls: { compta: number; repair: number }) {
  const response = { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } };
  return load(file, {
    "next/server": response,
    "@/lib/service-auth": { hasServiceKey: () => true },
    "@/lib/cash-day-guard": guard,
    "@/lib/cash-day-projection": projection,
    "@/lib/log": { log: { info() {} } },
    "@/lib/caisse": {
      async corrigerMoyenPaiement() { calls.compta++; return { ok: true }; },
      async repairSale(tenantId: string, saleId: string) { sync.uuid(tenantId); sync.uuid(saleId); calls.repair++; return { ok: true }; },
    },
  });
}

const tenantId = "ab000000-0000-0000-0000-000000000001";

test("payment-correction répond INVALID_PAYLOAD 400 sur saleId invalide avant Compta", async () => {
  const calls = { compta: 0, repair: 0 };
  const { POST } = route(path.join("..", "app", "api", "sales", "[id]", "payment-correction", "route.ts"), calls);
  const response = await POST(
    { json: async () => ({ tenantId, fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 }) },
    { params: Promise.resolve({ id: "not-a-uuid" }) },
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "INVALID_PAYLOAD");
  assert.equal(calls.compta, 0);
});

test("payment-correction répond INVALID_PAYLOAD 400 sur tenantId invalide avant Compta", async () => {
  const calls = { compta: 0, repair: 0 };
  const { POST } = route(path.join("..", "app", "api", "sales", "[id]", "payment-correction", "route.ts"), calls);
  const response = await POST(
    { json: async () => ({ tenantId: "invalid", fromMethod: "CASH", toMethod: "CARD", amountXpf: 1000 }) },
    { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000002" }) },
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "INVALID_PAYLOAD");
  assert.equal(calls.compta, 0);
});

test("repair répond INVALID_PAYLOAD 400 sur UUID invalide", async () => {
  const calls = { compta: 0, repair: 0 };
  const { POST } = route(path.join("..", "app", "api", "sales", "[id]", "repair", "route.ts"), calls);
  const response = await POST(
    { json: async () => ({ tenantId }) },
    { params: Promise.resolve({ id: "not-a-uuid" }) },
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "INVALID_PAYLOAD");
  assert.equal(calls.repair, 0);
});
