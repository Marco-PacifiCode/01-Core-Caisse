import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { canonical } from "./cash-day-projection.ts";
import { claimDeposits, depositActions, recordDepositResult, validateClaimInput, validateResultInput, validateDepositInput, readDepositBody, MAX_BODY_BYTES } from "./cash-deposits.ts";

const tenantId = randomUUID();
const makeAction = (actionId = randomUUID(), payload: any = { a: 1, b: 2 }) => ({ actionId, deviceId: "tablet", kind: "SALE", payload });
test("contrat apply complet (source courante ou base Git pour la preuve rouge)", () => {
  const source = process.env.CASH_DEPOSIT_TEST_BASE
    ? execFileSync("git", ["show", `${process.env.CASH_DEPOSIT_TEST_BASE}:core/lib/cash-deposits.ts`], { encoding: "utf8" })
    : readFileSync(new URL("cash-deposits.ts", import.meta.url), "utf8");
  const js = stripTypeScriptTypes(source).replace(/^import .*from .*;\r?$/gm, "").replace(/^export /gm, "");
  const api = vm.runInNewContext(`(function(){${js}\nreturn {validateDepositInput, validateClaimInput, validateResultInput, claimDeposits, recordDepositResult};})()`, {
    Buffer, Date, Error, Set, Map, Object, Array, Number, String, JSON, Promise, BigInt,
    createHash, randomUUID,
    canonical: (v: unknown) => JSON.stringify(v), date: (v: string) => new Date(v),
    uuid: (v: string) => { if (!/^[0-9a-f-]{36}$/i.test(v)) throw Error("INVALID_UUID"); return v; },
    object: (v: any) => { if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("INVALID_OBJECT"); return v; },
    requireCash: (ok: boolean, code = "INVALID") => { if (!ok) throw Error(code); },
    CashContractError: class extends Error {},
  });
  const actionId = randomUUID(), payload = { total: 42 };
  const core = { tenantId, actionId, deviceId: "tablet", kind: "SALE", payload };
  const v2 = api.validateDepositInput({ tenantId, actions: [{ ...core, formatVersion: 2, sequence: 3, actorId: tenantId, receivedById: tenantId }] }).actions[0];
  const v1 = api.validateDepositInput({ tenantId, actions: [{ ...core, formatVersion: 1, sequence: 0 }] }).actions[0];
  assert.equal(v2.payloadHash, v1.payloadHash);
  assert.equal(v2.sequence, 3n);
  assert.equal(typeof api.claimDeposits, "function");
  assert.equal(typeof api.recordDepositResult, "function");
  assert.throws(() => api.validateClaimInput({ tenantId, holder: "h", leaseSeconds: 61, limit: 1 }));
  assert.throws(() => api.validateResultInput({ tenantId, token: actionId, actionId, outcome: "APPLIED", code: "OK", reason: "", result: { n: Number.NaN } }));
});
test("routes claim/result refusent hors portée même en mode journal", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripTypeScriptTypes } = await import("node:module");
  const vm = await import("node:vm");
  const { execFileSync } = await import("node:child_process");
  for (const routePath of ["../app/api/cash-deposits/claim/route.ts", "../app/api/cash-deposits/result/route.ts"]) {
    const relative = routePath.replace(/^\.\.\//, "core/");
    let source: string;
    if (process.env.CASH_DEPOSIT_TEST_BASE) {
      try { source = execFileSync("git", ["show", `${process.env.CASH_DEPOSIT_TEST_BASE}:${relative}`], { encoding: "utf8" }); }
      catch { source = ""; }
    } else source = readFileSync(new URL(routePath, import.meta.url), "utf8");
    const js = stripTypeScriptTypes(source).replace(/^import .*from .*;\r?$/gm, "").replace(/^export /gm, "");
    let tenantCalls = 0;
    const api = vm.runInNewContext(`(function(){${js}\nreturn {POST};})()`, {
      cashHttp: (_req: unknown, fn: () => Promise<unknown>) => fn(),
      cashResponse: (_body: unknown, status = 200) => ({ status }),
      identifierCle: () => ({ tenants: [randomUUID()] }),
      HorsPorteeError: class extends Error {},
      withTenant: async () => { tenantCalls++; throw new Error("withTenant ne doit pas être appelé"); },
      readDepositBody: async () => routePath.includes("claim")
        ? { tenantId, holder: "worker", leaseSeconds: 5, limit: 1 }
        : { tenantId, token: randomUUID(), actionId: randomUUID(), outcome: "WAITING", code: "WAIT", reason: "x" },
      validateClaimInput, validateResultInput, claimDeposits, recordDepositResult,
    });
    const response = await api.POST({ body: null, headers: { get: () => "synthetic-key" } });
    assert.equal(response.status, 403); assert.equal(tenantCalls, 0);
  }
});
test("valide les UUID, l'objet payload et les limites du lot", () => {
  assert.throws(() => validateDepositInput({ tenantId: "bad", actions: [makeAction()] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: Array.from({ length: 201 }, () => makeAction()) }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [] }), "corps vide refusé");
  assert.throws(() => validateDepositInput({ tenantId, actions: [], applied: [] }), "corps vide refusé");
  assert.deepEqual(validateDepositInput({ tenantId, actions: [], applied: [tenantId] }).actions, [], "applied seul accepté");
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), actionId: "bad" }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), payload: [] }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), payload: null }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), payload: 5 }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), kind: "k".repeat(41) }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), entityKey: "e".repeat(301) }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), deviceId: "d".repeat(201) }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), dependsOn: [1] }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [makeAction()], applied: ["bad"] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [makeAction()], applied: Array.from({ length: 1001 }, randomUUID) }));
});
test("empreinte canonique indépendante de l'ordre des clés", () => {
  const first = { b: 2, a: 1 }, second = { a: 1, b: 2 };
  const [one] = validateDepositInput({ tenantId, actions: [makeAction(randomUUID(), first)] }).actions;
  const [two] = validateDepositInput({ tenantId, actions: [makeAction(randomUUID(), second)] }).actions;
  const expected = createHash("sha256").update(canonical(first)).digest("hex");
  assert.equal(one.payloadHash, expected); assert.equal(two.payloadHash, expected);
  assert.deepEqual(first, { b: 2, a: 1 }); assert.deepEqual(second, { a: 1, b: 2 });
});
test("les métadonnées format 2 restent hors de payloadHash", () => {
  const payload = { total: 12 }, actionId = randomUUID();
  const [one] = validateDepositInput({ tenantId, actions: [{ ...makeAction(actionId, payload), formatVersion: 2, sequence: 4, actorId: tenantId, receivedById: tenantId }] }).actions;
  const [two] = validateDepositInput({ tenantId, actions: [{ ...makeAction(actionId, payload), formatVersion: 1, sequence: 9 }] }).actions;
  assert.equal(one.payloadHash, two.payloadHash);
  assert.equal(one.sequence, 4n); assert.equal(one.formatVersion, 2); assert.equal(one.actorId, tenantId);
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), formatVersion: 3 }] }));
  assert.throws(() => validateDepositInput({ tenantId, actions: [{ ...makeAction(), sequence: -1 }] }));
});
test("décide stored, seen, conflict et applied", async () => {
  const rows = new Map<string, any>(); let now = Date.now();
  const tx: any = { $queryRaw: async () => [], cashDeposit: {
    findUnique: async ({ where }: any) => rows.get(where.tenantId_actionId.actionId) ?? null,
    create: async ({ data }: any) => { rows.set(data.actionId, { ...data, lastSeenAt: new Date(now), status: "PENDING" }); },
    update: async ({ where, data }: any) => { const row = rows.get(where.tenantId_actionId.actionId); rows.set(row.actionId, { ...row, ...data, conflictCount: data.conflictCount?.increment ? (row.conflictCount ?? 0) + data.conflictCount.increment : row.conflictCount ?? 0 }); },
    updateMany: async ({ where, data }: any) => { for (const id of where.actionId.in) { const row = rows.get(id); if (row?.tenantId === where.tenantId && (!where.status || row.status === where.status)) rows.set(id, { ...row, ...data }); } },
  } };
  const a = { ...makeAction(), clientState: "queued", clientErrorCode: "OFFLINE" };
  assert.equal((await depositActions(tx, { tenantId, actions: [a] })).results[0].result, "stored");
  const received = rows.get(a.actionId).lastSeenAt;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await depositActions(tx, { tenantId, actions: [a] })).results[0].result, "seen");
  assert.ok(rows.get(a.actionId).lastSeenAt > received);
  assert.equal(rows.get(a.actionId).clientState, "queued"); assert.equal(rows.get(a.actionId).clientErrorCode, "OFFLINE");
  assert.equal((await depositActions(tx, { tenantId, actions: [makeAction(a.actionId, { a: 3 })] })).results[0].result, "conflict");
  assert.deepEqual(rows.get(a.actionId).payload, a.payload); assert.equal(rows.get(a.actionId).conflictCount, 1);
  await depositActions(tx, { tenantId, actions: [a], applied: [a.actionId] });
  assert.equal(rows.get(a.actionId).status, "APPLIED");
  const appliedAt = rows.get(a.actionId).appliedAt;
  await depositActions(tx, { tenantId, actions: [a], applied: [a.actionId] });
  assert.equal(rows.get(a.actionId).appliedAt, appliedAt);
});
test("rejette un corps supérieur à 2 Mio avec 413", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); controller.close(); } });
  await assert.rejects(() => readDepositBody(stream), (e: any) => e.status === 413);
});
test("valide le bail et les résultats APPLIED/REFUSED", () => {
  assert.throws(() => validateClaimInput({ tenantId, holder: "x".repeat(101), leaseSeconds: 5, limit: 3 }));
  assert.throws(() => validateClaimInput({ tenantId, holder: "h", leaseSeconds: 61, limit: 3 }));
  assert.throws(() => validateResultInput({ tenantId, token: randomUUID(), actionId: randomUUID(), outcome: "REFUSED", code: "bad-code", reason: "x" }));
  assert.throws(() => validateResultInput({ tenantId, token: randomUUID(), actionId: randomUUID(), outcome: "APPLIED", code: "OK", reason: "", result: { data: "x".repeat(17000) } }));
  assert.equal(validateResultInput({ tenantId, token: randomUUID(), actionId: randomUUID(), outcome: "WAITING", code: "WAIT", reason: "attente" }).result, null);
});
test("claim marque v1 et renvoie v2 trié avec dépendances", async () => {
  let marked = false, findArgs: any;
  const rows: any[] = [
    { actionId: randomUUID(), deviceId: "b", sequence: 0n, clientCreatedAt: new Date(0), dependsOn: [tenantId], payload: {}, actorId: tenantId, receivedById: null, attempts: 0, lastResultCode: null },
    { actionId: randomUUID(), deviceId: "a", sequence: 2n, clientCreatedAt: new Date(0), dependsOn: ["invalid"], payload: {}, actorId: null, receivedById: tenantId, attempts: 1, lastResultCode: "E" },
  ];
  const tx: any = { $queryRaw: async () => [{ token: randomUUID(), until: new Date(Date.now() + 10000) }], cashDeposit: {
    updateMany: async ({ where }: any) => { marked = where.OR.some((x: any) => x.formatVersion === 1) && where.lastResultCode === null; },
    findMany: async (args: any) => { if (!args.select) findArgs = args; return args.select ? [{ actionId: tenantId, status: "APPLIED", resultJson: { ok: true } }] : [...rows].sort((a, b) => a.deviceId.localeCompare(b.deviceId) || (a.sequence < b.sequence ? -1 : 1)); },
  } };
  const result = await claimDeposits(tx, validateClaimInput({ tenantId, holder: "worker", leaseSeconds: 10, limit: 20 }));
  assert.equal(marked, true); assert.equal(result!.items[0].deviceId, "a");
  assert.deepEqual(findArgs.orderBy, [{ deviceId: "asc" }, { sequence: "asc" }, { clientCreatedAt: "asc" }, { actionId: "asc" }]);
  assert.deepEqual(findArgs.where, { tenantId, status: "PENDING", formatVersion: 2 }); assert.equal(findArgs.take, 20);
  assert.deepEqual(result!.items[1].dependances, [{ actionId: tenantId, status: "APPLIED", resultJson: { ok: true } }]);
  assert.deepEqual(result!.items[0].dependances, [{ actionId: "invalid", status: "MISSING", resultJson: null }]);
});
test("result refuse un ancien bail et garde APPLIED idempotent", async () => {
  const token = randomUUID(), actionId = randomUUID();
  const input = validateResultInput({ tenantId, token, actionId, outcome: "APPLIED", code: "OK", reason: "", result: { total: 1 } });
  let findCalls = 0;
  const tx: any = { $queryRaw: async (strings: TemplateStringsArray) => strings[0].includes("SELECT token") ? [{ token: randomUUID(), until: new Date(Date.now() + 10000) }] : [{ now: new Date() }], cashDeposit: {
    findUnique: async () => { findCalls++; return { status: "APPLIED", resultJson: { total: 1 } }; },
  } };
  assert.deepEqual(await recordDepositResult(tx, input), { error: "LEASE_LOST" }); assert.equal(findCalls, 0);
  tx.$queryRaw = async (strings: TemplateStringsArray) => strings[0].includes("SELECT token") ? [{ token, until: new Date(Date.now() + 10000) }] : [{ now: new Date() }];
  assert.deepEqual(await recordDepositResult(tx, input), { status: "APPLIED", resultJson: { total: 1 } });
});
test("result REFUSED/WAITING compte les tentatives, APPLIED persiste le JSON et un bail expiré est perdu", async () => {
  const token = randomUUID(), actionId = randomUUID(); let row: any = { status: "PENDING", attempts: 0, resultJson: null };
  let leaseUntil = new Date(Date.now() + 10000);
  const tx: any = {
    $queryRaw: async (strings: TemplateStringsArray) => strings[0].includes("SELECT token") ? [{ token, until: leaseUntil }] : [{ now: new Date() }],
    cashDeposit: { findUnique: async () => row, update: async ({ data }: any) => {
      row = { ...row, ...data, attempts: data.attempts?.increment ? row.attempts + 1 : row.attempts };
      return row;
    } },
  };
  for (const outcome of ["REFUSED", "WAITING"] as const) {
    await recordDepositResult(tx, validateResultInput({ tenantId, token, actionId, outcome, code: "RETRY", reason: "later" }));
  }
  assert.equal(row.attempts, 2); assert.equal(row.lastResultCode, "RETRY");
  const applied = await recordDepositResult(tx, validateResultInput({ tenantId, token, actionId, outcome: "APPLIED", code: "OK", reason: "", result: { total: 5 } }));
  assert.equal(applied.status, "APPLIED"); assert.deepEqual(row.resultJson, { total: 5 }); assert.equal(row.lastResultCode, null);
  row = { status: "PENDING", attempts: 0, resultJson: null }; leaseUntil = new Date(Date.now() - 1000);
  assert.deepEqual(await recordDepositResult(tx, validateResultInput({ tenantId, token, actionId, outcome: "WAITING", code: "WAIT", reason: "expired" })), { error: "LEASE_LOST" });
  assert.equal(row.attempts, 0);
});
