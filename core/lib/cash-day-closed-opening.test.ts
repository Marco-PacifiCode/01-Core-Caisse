import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import * as projection from "./cash-day-projection.ts";
import * as sync from "./caisse-sync.ts";

// Q5 : ouverture sur une journée close. Persistance simulée (style de cash-day-late-opening.test.ts).
type Row = Record<string, any>;
const tenant = "ab000000-0000-0000-0000-000000000002", dayId = "ab000000-0000-0000-0000-0000000000d1";
const now = new Date("2026-10-29T01:00:00Z");
class Clock extends Date {
  constructor(value?: string | number) { super(value ?? now.getTime()); }
  static now() { return now.getTime(); }
}
const js = stripTypeScriptTypes(readFileSync(new URL("cash-days.ts", import.meta.url), "utf8")).replace(/^import .*from .*;\r?$/gm, "").replace(/^export /gm, "");
const occurredAt = now.toISOString(), business = projection.businessDay(now);
function fixture(status: string, openings: Row[] = []) {
  const session = { id: "ab000000-0000-0000-0000-0000000000a1", status, openingFloatXpf: 1000n, openedBy: tenant, openedByName: "Recette",
    openedAt: now, closedBy: null, closedByName: null, closedAt: status === "CLOSED" ? now : null };
  const day = { id: dayId, tenantId: tenant, scope: "rotisserie-caisse", businessDay: business, cycle: 0, revision: 0, canonicalSessionId: session.id, currentSessionId: session.id };
  const events: Row[] = [], conflicts = new Map<string, Row>(), created: Row[] = [];
  const tx: Row = {
    cashSettings: { findUnique: async () => ({ toCloseEnabled: true }) },
    cashDay: { findUnique: async () => day },
    cashDayOpening: { findFirst: async ({ where }: Row) => openings.find(o => o.sourceKey === where.sourceKey) ?? null,
      create: async ({ data }: Row) => { created.push(data); openings.push(data); } },
  };
  const ports = { Date: Clock, Error, URLSearchParams, ...projection, ...sync,
    lockCashTenant: async () => {}, assertNoLegacyOperationInProgress: async () => {},
    lockDay: async () => ({ ...day, canonicalSession: session, currentSession: session }),
    appendDayFact: async (_tx: Row, _t: string, _id: string, fact: Row) => { events.push(fact); },
    recordCashConflict: async (_tx: Row, c: Row) => { if (!conflicts.has(c.actionName)) conflicts.set(c.actionName, c); } };
  const { openCashDay } = vm.runInNewContext(`(function(){${js}\nreturn {openCashDay};})()`, ports);
  const open = (sourceKey = "opening") => openCashDay(tx, { tenantId: tenant, actionId: "opening", entityKey: "day", deviceId: "synthetic",
    deviceName: "Recette", occurredAt, businessDay: business, actorId: tenant, actorName: "Recette", receivedById: tenant,
    sourceKey, localSessionKey: "local", openingFloatXpf: "1000" });
  return { open, events, conflicts, created, openings };
}
test("journée CLOSED : réponse normale, 0 OPENING, 0 CashDayOpening, 1 conflit même rejouée 3 fois", async () => {
  const f = fixture("CLOSED");
  for (let i = 0; i < 3; i++) {
    const r = await f.open();
    assert.equal(r.status, "CLOSED"); assert.equal(r.fondRetenu, "1000"); assert.equal(r.fondNonRetenu, false);
  }
  assert.equal(f.events.length, 0); assert.equal(f.created.length, 0);
  assert.deepEqual([...f.conflicts.keys()], [`${dayId}:0:OUVERTURE_JOUR_CLOS`]);
  assert.equal([...f.conflicts.values()][0].code, "OUVERTURE_JOUR_CLOS");
});
test("journée OPEN inchangée : CashDayOpening + OPENING, aucun conflit", async () => {
  const f = fixture("OPEN"), r = await f.open();
  assert.equal(r.status, "OPEN"); assert.equal(f.created.length, 1);
  assert.equal(f.events.filter(e => e.kind === "OPENING").length, 1); assert.equal(f.conflicts.size, 0);
});
test("rejeu d'une ouverture déjà appliquée avant le Z : branche prior inchangée, aucun conflit", async () => {
  const prior = { tenantId: tenant, cashDayId: dayId, sourceKey: "opening", localSessionKey: "local", deviceId: "synthetic", deviceName: "Recette",
    actorId: tenant, actorName: "Recette", occurredAt: now, openingFloatXpf: 1000n };
  const f = fixture("CLOSED", [prior]), r = await f.open();
  assert.equal(r.status, "CLOSED"); assert.equal(r.fondRetenu, "1000");
  assert.equal(f.events.length, 0); assert.equal(f.created.length, 0); assert.equal(f.conflicts.size, 0);
});
