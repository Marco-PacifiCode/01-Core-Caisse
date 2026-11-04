// Preuves Core de la 2e relecture (copie de _backup/relecture-2a-finale/core-preuves.test.ts, adaptée au worktree et aux décisions K1-K4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { claimDeposits, depositActions, depositStatuses, recordDepositResult } from "./cash-deposits.ts";
function fixture() {
  const rows = new Map<string, any>(); let lease: any = null;
  // Filtres Prisma simulés : égalité, in, gt, not, notIn (sémantique SQL : NULL exclu de notIn), OR.
  const cond = (x: any, v: any): boolean => !(v && typeof v === "object" && !(v instanceof Date)) ? (x ?? null) === v
    : Object.entries(v).every(([op, o]: any) => op === "in" ? o.includes(x) : op === "gt" ? x > o : op === "not" ? (x ?? null) !== o
      : op === "notIn" ? x != null && !o.includes(x) : false);
  const match = (row: any, w: any): boolean => Object.entries(w).every(([k, v]: any) => k === "OR" ? v.some((o: any) => match(row, o)) : cond(row[k], v));
  const cmp = (a: any, b: any) => (a ?? Infinity) < (b ?? Infinity) ? -1 : (a ?? Infinity) > (b ?? Infinity) ? 1 : 0;
  const tx: any = {
    $queryRaw: async () => [],
    cashDeposit: {
      findUnique: async ({ where }: any) => rows.get(where.tenantId_actionId.actionId) ?? null,
      create: async ({ data }: any) => { rows.set(data.actionId, { formatVersion: 1, attempts: 0, lastResultCode: null, resultJson: null,
        actorId: null, actorName: null, receivedById: null, sequence: null, ...data, status: "PENDING", conflictCount: 0 }); },
      update: async ({ where, data }: any) => {
        const row = rows.get(where.tenantId_actionId.actionId), next = { ...row };
        for (const [k, v] of Object.entries<any>(data)) next[k] = v && typeof v === "object" && "increment" in v ? (row[k] ?? 0) + v.increment : v;
        rows.set(row.actionId, next);
      },
      updateMany: async ({ where, data }: any) => { let count = 0;
        for (const [id, row] of rows) if (match(row, where)) { rows.set(id, { ...row, ...data }); count++; } return { count }; },
      findMany: async ({ where, take }: any) => [...rows.values()].filter(r => match(r, where))
        .sort((a, b) => cmp(a.deviceId, b.deviceId) || cmp(a.sequence, b.sequence) || cmp(a.clientCreatedAt, b.clientCreatedAt) || cmp(a.actionId, b.actionId))
        .slice(0, take ?? 1000),
    },
    cashDepositLease: {
      findUnique: async () => lease,
      upsert: async ({ create, update }: any) => { lease = lease ? { ...lease, ...update } : { ...create }; return lease; },
      updateMany: async ({ where, data }: any) => { if (lease && lease.token === where.token && lease.until > where.until.gt) { lease = { ...lease, ...data }; return { count: 1 }; } return { count: 0 }; },
    },
  };
  return { tx, rows, getLease: () => lease, setLease: (l: any) => { lease = l; } };
}
const tenantId = randomUUID();
const v2 = (sequence: number, extra: any = {}) => ({ actionId: randomUUID(), deviceId: "tab-a", kind: "vente", payload: { n: sequence },
  formatVersion: 2, sequence, actorId: "u1", actorName: "Alice", receivedById: "u1", dependsOn: [], ...extra });
const claim = (f: any, holder = "srv") => claimDeposits(f.tx, { tenantId, holder, limit: 100 });
const result = (f: any, token: string, actionId: string, outcome: string, extra: any = {}) =>
  recordDepositResult(f.tx, { tenantId, token, actionId, outcome, ...extra });

// F5 — Format 1 (ligne déposée sans enveloppe : annulation en mode caisse, ligne déposée avant la mise à jour…) :
// un accusé {actionId, resultJson} venu d'un AUTRE appareil (lot deviceId "tab-x") pose APPLIED + ce resultJson,
// et /status le rend tel quel. La tablette (A7, 15-outbox.js outboxAccuserDepot) l'accuse et retire la ligne.
test("F5 format 1 : un accusé forgé d'un autre appareil ne doit pas rendre APPLIED + resultJson par /status", async () => {
  const f = fixture(), a = { actionId: randomUUID(), deviceId: "tab-a", kind: "vente", payload: { id: "t1" } };
  await depositActions(f.tx, { tenantId, actions: [a] });
  await claim(f); // REJEU_TABLETTE posé (format 1), status PENDING
  const forge = { v: 1, kind: "vente", status: 200, body: { ok: true, envoyes: ["t1"], saleIds: { t1: "faux" } } };
  const r = await depositActions(f.tx, { tenantId, deviceId: "tab-x", actions: [], applied: [{ actionId: a.actionId, resultJson: forge }] });
  const s = await depositStatuses(f.tx, { tenantId, actionIds: [a.actionId] });
  console.log("F5 appliedIgnores=" + JSON.stringify(r.appliedIgnores) + " status=" + JSON.stringify(s.items[0]));
  assert.ok(!(s.items[0].status === "APPLIED" && (s.items[0] as any).resultJson?.body?.saleIds?.t1 === "faux"),
    "format 1 : resultJson forgé par l'appareil tab-x servi à la tablette tab-a par /status");
});

// F1 (moitié Core) — Dépendance renoncée puis accusée par la tablette = APPLIED SANS resultJson ; le dépendant,
// marqué EN_ATTENTE par le serveur, voit son accusé (même appareil) ignoré et revient au claim indéfiniment.
test("F1 dépendant d'une pièce APPLIED par accusé de la tablette (ancien comportement) : accusé ignoré, rendu au claim pour toujours sans resultJson de dépendance", async () => {
  const f = fixture(), r = v2(1, { kind: "reouverture" }), v = v2(2, { dependsOn: [] });
  v.dependsOn = [r.actionId];
  await depositActions(f.tx, { tenantId, actions: [r, v] });
  let c = await claim(f);
  await result(f, c.token, r.actionId, "REFUSED", { code: "REJEU_TABLETTE" });
  await result(f, c.token, v.actionId, "WAITING", { code: "EN_ATTENTE" });
  // La tablette rejoue la réouverture et l'accuse (même appareil) : APPLIED par accusé de la tablette (ancien comportement), resultJson null.
  await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [{ actionId: r.actionId, resultJson: { v: 1 } }] });
  // La tablette rejoue la vente et l'accuse : ignorée (EN_ATTENTE).
  await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [{ actionId: v.actionId, resultJson: { v: 1 } }] });
  let encore = 0;
  for (let i = 0; i < 3; i++) {
    c = await claim(f);
    const it = c.items.find((x: any) => x.actionId === v.actionId);
    if (it) { encore++; console.log("F1 claim " + i + " : vente rendue, dépendance=" + JSON.stringify(it.dependencies[r.actionId]) + " lastResultCode=" + it.lastResultCode); }
    await result(f, c.token, v.actionId, "WAITING", { code: "EN_ATTENTE" });
  }
  console.log("F1 réouverture=" + f.rows.get(r.actionId).status + "/" + f.rows.get(r.actionId).lastResultCode + " vente=" + f.rows.get(v.actionId).status);
  // Relecture 2 : la cascade est côté surface ; le Core doit lui EXPOSER la dépendance renoncée (K3) et ne jamais la passer APPLIED (K1).
  assert.equal(f.rows.get(r.actionId).status, "PENDING", "la tablette ne fait jamais passer une ligne de format 2 à APPLIED");
  c = await claim(f);
  const it = c.items.find((x: any) => x.actionId === v.actionId);
  assert.ok(it, "la vente reste visible de l'applicateur");
  assert.deepEqual({ ...it.dependencies[r.actionId] }, { status: "PENDING", resultJson: null, lastResultCode: "REJEU_TABLETTE", formatVersion: 2 },
    "dépendance renoncée visible de l'applicateur (lastResultCode + formatVersion)");
});

// F4 (moitié Core) — C4 déclaré : un lot qui DÉCLARE deviceId "tab-a" (session d'un autre employé) fait passer une
// vente renoncée de tab-a APPLIED par accusé de la tablette (ancien comportement) alors qu'elle n'a jamais atteint le Core.
test("F4 C4 déclaré : APPLIED par accusé de la tablette (ancien comportement) posé par un lot qui se déclare tab-a", async () => {
  const f = fixture(), v = v2(1);
  await depositActions(f.tx, { tenantId, actions: [{ ...v, clientState: "error" }] });
  const c = await claim(f);
  await result(f, c.token, v.actionId, "REFUSED", { code: "NON_APPLICABLE_ERROR" });
  await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [v.actionId] });
  console.log("F4 vente : " + f.rows.get(v.actionId).status + "/" + f.rows.get(v.actionId).lastResultCode);
  // K1 : la vente n'a jamais atteint le Core, elle ne doit jamais passer APPLIED sur la seule parole d'une session.
  assert.equal(f.rows.get(v.actionId).status, "PENDING"); assert.equal(f.rows.get(v.actionId).lastResultCode, "NON_APPLICABLE_ERROR");
});

// F6 (moitié Core) — accusé de la tablette arrivé quand la marque est null : ignoré (C1) mais renvoyé dans `applied`
// (la tablette efface alors son accusé, 15-outbox.js) ; le serveur renonce ensuite : PENDING pour toujours.
test("F6 accusé ignoré renvoyé dans applied ; renoncement ultérieur : PENDING pour toujours", async () => {
  const f = fixture(), v = v2(1);
  await depositActions(f.tx, { tenantId, actions: [v] });
  const r = await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [{ actionId: v.actionId, resultJson: { v: 1 } }] });
  const c = await claim(f);
  await result(f, c.token, v.actionId, "REFUSED", { code: "REJEU_TABLETTE" });
  const c2 = await claim(f, "srv");
  console.log("F6 applied renvoyé=" + JSON.stringify(r.applied) + " ignores=" + JSON.stringify(r.appliedIgnores) + " ligne=" + f.rows.get(v.actionId).status + "/" + f.rows.get(v.actionId).lastResultCode + " reclaim=" + c2.items.length);
  // Réécrit (relecture 2) : l'attendu d'origine supposait l'ancien C1 ; sous K1 une ligne renoncée reste PENDING et revient au
  // rejeu de la tablette (décision Opus), le tort réel à prouver est donc : aucun resultJson de tablette servi, jamais APPLIED par la tablette.
  await depositActions(f.tx, { tenantId, deviceId: "tab-a", actions: [], applied: [{ actionId: v.actionId, resultJson: { v: 2 } }] });
  const s = await depositStatuses(f.tx, { tenantId, actionIds: [v.actionId] });
  assert.equal(f.rows.get(v.actionId).status, "PENDING"); assert.equal(f.rows.get(v.actionId).resultJson, null);
  assert.deepEqual(JSON.parse(JSON.stringify(s.items)), [{ actionId: v.actionId, status: "PENDING" }]);
});
