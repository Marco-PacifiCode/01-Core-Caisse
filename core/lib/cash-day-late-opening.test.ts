import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import * as projection from "./cash-day-projection.ts";
import * as sync from "./caisse-sync.ts";

// Sans dépendance installée ; seuls les ports de persistance sont simulés.
type Row = Record<string, any>;
const tenant = "ab000000-0000-0000-0000-000000000001";
const now = new Date("2026-10-29T01:00:00Z");
class Clock extends Date {
  constructor(value?: string | number) { super(value ?? now.getTime()); }
  static now() { return now.getTime(); }
}
const source = process.env.CASH_DAYS_TEST_BASE
  ? execFileSync("git", ["show", `${process.env.CASH_DAYS_TEST_BASE}:core/lib/cash-days.ts`], { encoding: "utf8" })
  : readFileSync(new URL("cash-days.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source).replace(/^import .*from .*;\r?$/gm, "").replace(/^export /gm, "");
function fixture(existing: Row[] = [], enabled = true) {
  const sessions: Row[] = [], days: Row[] = [...existing], events: Row[] = [], conflicts: Row[] = [];
  const tx: Row = {
    cashSettings: { findUnique: async () => ({ toCloseEnabled: enabled }) },
    cashDay: {
      findUnique: async ({ where: { tenantId_scope_businessDay: w } }: Row) => days.find(d => d.tenantId === w.tenantId && d.scope === w.scope && d.businessDay === w.businessDay) ?? null,
      findFirst: async ({ where: w }: Row) => days.find(d => d.tenantId === w.tenantId && d.scope === w.scope && d.businessDay > w.businessDay.gt) ?? null,
      create: async ({ data }: Row) => { const d = { id: tenant, scope: "rotisserie-caisse", cycle: 0, revision: 0, ...data }; days.push(d); return d; },
    },
    cashSession: {
      findFirst: async () => null,
      create: async ({ data }: Row) => { const s = { id: tenant, ...data }; sessions.push(s); return s; },
    },
    cashDaySession: { create: async () => ({}), findUnique: async () => null },
    cashDayOpening: { findFirst: async () => null, create: async () => ({}) },
  };
  const ports = {
    Date: Clock, Error, URLSearchParams, ...projection, ...sync,
    lockCashTenant: async () => {}, assertNoLegacyOperationInProgress: async () => {},
    openSessionTx: async (_tx: Row, _tenant: string, b: Row) => ({ ok: true, session: await tx.cashSession.create({ data: { ...b, openedAt: b.occurredAt, status: "OPEN" } }) }),
    lockDay: async () => {
      const d = days.at(-1)!;
      return { ...d, canonicalSession: sessions.at(-1), currentSession: sessions.at(-1) };
    },
    appendDayFact: async (_tx: Row, _tenant: string, _id: string, fact: Row) => { events.push(fact); },
    recordCashConflict: async (_tx: Row, conflict: Row) => { conflicts.push(conflict); },
  };
  const { openCashDay } = vm.runInNewContext(`(function(){${js}\nreturn {openCashDay};})()`, ports);
  const open = (offset: number) => {
    const occurredAt = new Date(now.getTime() + offset * 86400000).toISOString();
    return openCashDay(tx, { tenantId: tenant, actionId: "opening", entityKey: "day", deviceId: "synthetic",
      deviceName: "Recette", occurredAt, businessDay: projection.businessDay(new Date(occurredAt)),
      actorId: tenant, actorName: "Recette", receivedById: tenant,
      sourceKey: "opening", localSessionKey: "local", openingFloatXpf: "1000" });
  };
  return { open, sessions, days, events, conflicts };
}
test("retard d'horloge sans journée plus récente : ouverture 4a OPEN, aucun conflit", async () => {
  const f = fixture();
  assert.equal((await f.open(-1)).status, "OPEN");
  assert.equal(f.events.some(e => e.kind === "TO_CLOSE"), false);
  assert.equal(f.conflicts.length, 0);
});
test("TO_CLOSE direct exige un jour strictement plus récent du même commerce et scope", async () => {
  for (const existing of [
    { tenantId: "autre", scope: "rotisserie-caisse", businessDay: "2026-10-29" },
    { tenantId: tenant, scope: "autre", businessDay: "2026-10-29" },
    { tenantId: tenant, scope: "rotisserie-caisse", businessDay: "2026-10-27" },
  ]) {
    const f = fixture([existing]);
    assert.equal((await f.open(-1)).status, "OPEN");
    assert.equal(f.conflicts.length, 0);
  }
});
test("journée plus récente : J-7 TO_CLOSE et conflit OUVERTURE_TARDIVE", async () => {
  const f = fixture([{ tenantId: tenant, scope: "rotisserie-caisse", businessDay: "2026-10-29" }]);
  assert.equal((await f.open(-7)).status, "TO_CLOSE");
  assert.equal(f.events.filter(e => e.kind === "TO_CLOSE").length, 1);
  assert.equal(f.conflicts[0].code, "OUVERTURE_TARDIVE");
});
test("journée plus récente : J-8 refusé avec conflit à persister après rollback", async () => {
  const f = fixture([{ tenantId: tenant, scope: "rotisserie-caisse", businessDay: "2026-10-29" }]);
  await assert.rejects(f.open(-8), (e: any) => e instanceof sync.CashConflictAfterRollback && e.message === "OUVERTURE_TROP_ANCIENNE");
  assert.equal(f.sessions.length, 0);
});
test("interrupteur éteint et jour serveur : aucune création TO_CLOSE", async () => {
  const existing = [{ tenantId: tenant, scope: "rotisserie-caisse", businessDay: "2026-10-30" }];
  assert.equal((await fixture(existing, false).open(-1)).status, "OPEN");
  assert.equal((await fixture(existing).open(0)).status, "OPEN");
});
