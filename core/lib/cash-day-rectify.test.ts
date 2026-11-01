import { stripTypeScriptTypes } from "node:module";
import * as projection from "./cash-day-projection.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { factDelta, projectCashDay, taxes, type DayClosure, type DayFact } from "./cash-day-projection.ts";

const time = new Date("2026-10-30T04:00:00.000Z");
function fact(sequence: bigint, kind: string, sourceRef: string, snapshot: unknown): DayFact {
  return { sequence, kind, sourceRef, deviceId: "test", occurredAt: time,
    receivedAt: new Date(time.getTime() + Number(sequence) * 1000), cashDeltaXpf: factDelta(kind, snapshot), snapshot };
}
function sale(sequence: bigint, sourceRef: string, cash: number): DayFact {
  const lines = [{ lineXpf: String(cash), tgcRatePpm: 0 }];
  const snapshot = { totalXpf: String(cash), lines, parTaux: taxes(lines), payments: [{ method: "CASH", amountXpf: String(cash) }] };
  return fact(sequence, "SALE_PAID", sourceRef, snapshot);
}
function closure(id: string, cycle: number, counted: bigint, cutoffRevision: bigint, legacySnapshot: unknown = null, baseline = 25000n): DayClosure {
  return { id, cycle, authoritative: true, countedXpf: counted, baselineExpectedXpf: baseline,
    cutoffRevision, closureMode: "ONLINE", occurredAt: time,
    receivedAt: time, actorName: "Admin", legacySnapshot };
}

test("rectification du Z : le nouveau comptage absorbe les ventes tardives et référence le Z remplacé", () => {
  const sales = Array.from({ length: 56 }, (_, i) => sale(BigInt(i + 2), `vente-${i}`, i === 0 ? 80700 : 0));
  const first = closure("z-cycle-0", 0, 25000n, 1n);
  const replacement = closure("z-cycle-1", 1, 105700n, 58n,
    { rectification: { motif: "Correction du comptage après réception des ventes", remplaceClosureId: first.id } }, 105700n);
  const facts = [fact(1n, "CLOSURE", first.id, {}), ...sales,
    fact(58n, "REOPEN", "rectification-action", { cycle: 1, reopenMode: "ADMINISTRATION_RECTIFICATION" }),
    fact(59n, "CLOSURE", replacement.id, {})];
  const projected = projectCashDay({ fond: 25000n, revision: 59n, cycle: 1, facts, closures: [first, replacement] });
  assert.equal(projected.compte, 105700n);
  assert.equal(projected.totauxCourants.expectedXpf, 105700n);
  assert.equal(projected.ecartCloture, 0n);
  assert.equal(projected.regularisation, 0n);
  assert.equal(projected.ecartZ, 0n);
  assert.deepEqual(projected.zRemplaces, [{ id: first.id, cycle: 0, compte: 25000n, ecart: 0n,
    occurredAt: time, remplacéPar: replacement.id, motif: "Correction du comptage après réception des ventes" }]);
});

test("la vente tardive après rectification reste acceptée et est signalée après clôture", () => {
  const first = closure("z0", 0, 25000n, 0n);
  const corrected = closure("z1", 1, 25000n, 2n, { rectification: { motif: "Comptage", remplaceClosureId: first.id } });
  const late = sale(3n, "late-sale", 1200);
  const projected = projectCashDay({ fond: 25000n, revision: 3n, cycle: 1,
    facts: [fact(1n, "REOPEN", "r", { cycle: 1 }), fact(2n, "CLOSURE", "z1", {}), late], closures: [first, corrected] });
  assert.equal(projected.compte, 25000n);
  assert.equal(projected.ecartZ, -1200n);
  assert.equal(projected.remonteesApresCloture.some((item: DayFact) => item.sourceRef === "late-sale"), true);
});

test("deux rectifications successives affichent chaque Z antérieur comme remplacé par son successeur", () => {
  const z0 = closure("z0", 0, 25000n, 0n);
  const z1 = closure("z1", 1, 26000n, 2n, { rectification: { motif: "Premier", remplaceClosureId: z0.id } });
  const z2 = closure("z2", 2, 27000n, 4n, { rectification: { motif: "Second", remplaceClosureId: z1.id } });
  const projected = projectCashDay({ fond: 25000n, revision: 4n, cycle: 2,
    facts: [fact(1n, "REOPEN", "r1", { cycle: 1 }), fact(2n, "CLOSURE", "z1", {}),
      fact(3n, "REOPEN", "r2", { cycle: 2 }), fact(4n, "CLOSURE", "z2", {})], closures: [z0, z1, z2] });
  assert.equal(projected.compte, 27000n);
  assert.deepEqual(projected.zRemplaces.map((z: { id: string; remplacéPar: string }) => [z.id, z.remplacéPar]), [["z0", "z1"], ["z1", "z2"]]);
});

test("les écritures de rectification ne mettent jamais à jour ni ne suppriment Z ou événements existants", () => {
  const paths = [new URL("./cash-days.ts", import.meta.url), new URL("./cash-day-ledger.ts", import.meta.url)];
  const source = paths.map(path => readFileSync(fileURLToPath(path), "utf8")).join("\n");
  assert.doesNotMatch(source, /\bcashDay(?:Closure|Event)\s*\.\s*(?:update|updateMany|delete|deleteMany)\s*\(/i);
  assert.doesNotMatch(source, /\b(?:UPDATE|DELETE\s+FROM)\s+["']?(?:CashDayClosure|CashDayEvent)\b/i);
});


test("rectifyCashDay ecrit uniquement des modes admis et conserve le marqueur et le rejeu", async () => {
  const source = readFileSync(new URL("./cash-days.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function rectifyCashDay("), source.indexOf("export async function reopenCashDay("));
  const written: any[] = [], events: any[] = [];
  const day = { cycle: 0, revision: 0n, currentSession: { status: "CLOSED", posteId: null }, canonicalSession: { openingFloatXpf: 25000n } };
  const tx = {
    cashSession: { create: async ({ data }: any) => { assert.equal(data.status, "CLOSED"); return { id: "session" }; } },
    cashDaySession: { create: async () => ({}) }, cashDay: { update: async () => ({}) },
    cashDayClosure: {
      findFirst: async ({ where }: any) => where.sourceKey ? written.find(c => c.sourceKey === where.sourceKey) : { id: "old-z", cycle: 0 },
      create: async ({ data }: any) => {
        assert.ok(["ONLINE", "OFFLINE", "IMPORT"].includes(data.closureMode));
        const closure = { id: "new-z", ...data }; written.push(closure); return closure;
      },
    },
  };
  const dependencies = { ...projection, uuid: (v: unknown) => v, normalizeActionInput: (v: unknown) => v,
    sourceAuthor: () => ({ actorId: "admin", actorName: "Admin", receivedById: "admin" }),
    text: (v: unknown) => String(v), date: (v: string) => new Date(v), lockDay: async () => day,
    readFacts: async () => [], appendDayFact: async (_tx: unknown, _tenant: unknown, _id: unknown, event: any) => {
      events.push(event); return { sequence: BigInt(events.length) };
    } };
  const rectify = new Function(...Object.keys(dependencies), stripTypeScriptTypes(body.replace("export ", "")) + "; return rectifyCashDay;")(...Object.values(dependencies));
  const request = { tenantId: "tenant", actionId: "action", administration: true, actorId: "admin", countedXpf: "25000",
    motif: "Comptage corrig?", occurredAt: new Date().toISOString(), deviceId: "admin", deviceName: "Administration" };
  const result = await rectify(tx, "day", request);
  assert.equal(result.alreadyApplied, false);
  assert.deepEqual(written[0].legacySnapshot.rectification, { motif: request.motif, remplaceClosureId: "old-z", remplaceCycle: 0 });
  assert.equal(events[0].snapshot.reopenMode, "ADMINISTRATION_RECTIFICATION");
  assert.equal((await rectify(tx, "day", request)).alreadyApplied, true);
  assert.equal(written.length, 1); assert.equal(events.length, 2);
});


test("liste : le marqueur choisit le Z authoritative plutot que le dernier recomptage", async () => {
  const source = readFileSync(new URL("./cash-days.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function listCashDays("), source.indexOf("export async function listLegacyCashDays("));
  const authoritative = { sourceKey: "rectify:action", closureMode: "ONLINE", legacySnapshot: { rectification: { remplaceClosureId: "old" } } };
  const day = { id: "day", currentSession: { status: "CLOSED" }, closures: [authoritative], events: [{ snapshot: { recount: true } }] };
  const report = { closureId: "authoritative" };
  const tx = { cashSettings: { findUnique: async () => ({ toCloseEnabled: false }) },
    cashDay: { findMany: async () => [day] }, cashDayEvent: { findMany: async () => [], findFirst: async ({ where }: any) => {
      assert.equal(where.sourceRef, authoritative.sourceKey); return { snapshot: report };
    } } };
  const list = new Function("uuid", "dayPage", "object", "cashDayView", stripTypeScriptTypes(body.replace("export ", "")) + "; return listCashDays;")(
    (v: unknown) => v, () => ({ limit: 31 }), projection.object, () => ({ id: "day" }));
  assert.deepEqual((await list(tx, "tenant", new URLSearchParams())).days[0].closure, report);
});
