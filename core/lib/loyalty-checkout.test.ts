// Fidélité — moteur d'écriture (lib/loyalty-db.ts, lot C2) et branchement checkoutSale/annulerVente
// (lib/caisse.ts), plan Salon-Reference 2026-09-15.
//
// DEUX STYLES DE TEST DANS CE FICHIER (même schéma que void-route.test.ts et
// gift-card-routes.test.ts) :
//   1. lib/loyalty-db.ts ne parle ni à `prisma` ni à `next/*` — chaque fonction reçoit un `tx` en
//      paramètre. C'est ce qui la rend RÉELLEMENT EXÉCUTABLE ici avec un FAUX `tx` (un magasin en
//      mémoire qui implémente juste `LoyaltyTx`), sans base ni contexte Next.
//   2. `checkoutSale` / `annulerVente` (lib/caisse.ts) importent `next/server`/Prisma réel via
//      `./tenant` : non exécutables par ce runner. Leur contrat est figé par LECTURE DU SOURCE.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lockAccount,
  insertEntry,
  creditVisit,
  creditPoints,
  redeemReward,
  reverseSale,
  adjustLoyalty,
  accountSummary,
  offProgram,
  type LoyaltyTx,
  type LoyaltyProgramRow,
} from "./loyalty-db.ts";
import { nextActivatedAt, isRewardAvailable } from "./loyalty.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";

// ══════════════════════════════════════════════════════════════════════════════════════════
// FAUX `tx` — magasin en mémoire, juste assez pour LoyaltyTx (voir loyalty-db.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════

type FakeAccount = { id: string; tenantId: string; clientFicheId: string; displayName: string };
type FakeEntry = {
  id: string;
  tenantId: string;
  accountId: string;
  kind: string;
  visits: number;
  points: number;
  rewardKind: string | null;
  rewardPercent: number | null;
  rewardAmountXpf: bigint | null;
  rewardBase: string | null;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  redeemedSaleId: string | null;
  rewardEntryId: string | null;
  discountXpf: bigint | null;
  sourceType: string;
  sourceId: string;
  ref: string;
  saleId: string | null;
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
  occurredAt: Date;
  createdAt: Date;
};

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const key of Object.keys(where)) {
    const expected = where[key];
    // Support minimal du filtre `{ gte: Date }` (activatedAt, correctif 2026-09-16) : le seul
    // opérateur Prisma réellement utilisé sur `occurredAt` dans loyalty-db.ts.
    if (expected !== null && typeof expected === "object" && !(expected instanceof Date) && "gte" in (expected as object)) {
      const bound = (expected as { gte: Date }).gte;
      const actual = row[key];
      if (!(actual instanceof Date) || actual.getTime() < bound.getTime()) return false;
      continue;
    }
    if (row[key] !== expected) return false;
  }
  return true;
}

function makeFakeTx(seedEntries: FakeEntry[] = []) {
  let counter = 0;
  const nextId = () => `fake-id-${++counter}`;
  const accounts: FakeAccount[] = [];
  const entries: FakeEntry[] = [...seedEntries];

  const tx: LoyaltyTx = {
    loyaltyProgram: {
      async findFirst() {
        throw new Error("non utilisé — le programme est passé en paramètre dans ces tests");
      },
    },
    loyaltyAccount: {
      async upsert(args: any) {
        const { tenantId, clientFicheId } = args.where.tenantId_clientFicheId;
        let acc = accounts.find((a) => a.tenantId === tenantId && a.clientFicheId === clientFicheId);
        if (acc) {
          acc.displayName = args.update.displayName;
        } else {
          acc = { id: nextId(), tenantId, clientFicheId, displayName: args.create.displayName };
          accounts.push(acc);
        }
        return { id: acc.id };
      },
      async findMany(args: any) {
        const ids: string[] = args.where.clientFicheId.in;
        return accounts
          .filter((a) => a.tenantId === args.where.tenantId && ids.includes(a.clientFicheId))
          .map((a) => ({ id: a.id, clientFicheId: a.clientFicheId, displayName: a.displayName }));
      },
    },
    loyaltyEntry: {
      async create(args: any) {
        const d = args.data;
        if (entries.some((e) => e.tenantId === d.tenantId && e.ref === d.ref)) {
          const err: any = new Error("Unique constraint failed on the fields: (`tenantId`,`ref`)");
          err.code = "P2002";
          throw err;
        }
        const entry: FakeEntry = {
          id: nextId(),
          tenantId: d.tenantId,
          accountId: d.accountId,
          kind: d.kind,
          visits: d.visits ?? 0,
          points: d.points ?? 0,
          rewardKind: d.rewardKind ?? null,
          rewardPercent: d.rewardPercent ?? null,
          rewardAmountXpf: d.rewardAmountXpf ?? null,
          rewardBase: d.rewardBase ?? null,
          expiresAt: d.expiresAt ?? null,
          redeemedAt: d.redeemedAt ?? null,
          redeemedSaleId: d.redeemedSaleId ?? null,
          rewardEntryId: d.rewardEntryId ?? null,
          discountXpf: d.discountXpf ?? null,
          sourceType: d.sourceType,
          sourceId: d.sourceId,
          ref: d.ref,
          saleId: d.saleId ?? null,
          actorId: d.actorId ?? null,
          actorName: d.actorName ?? null,
          reason: d.reason ?? null,
          occurredAt: d.occurredAt,
          createdAt: new Date(),
        };
        entries.push(entry);
        return { id: entry.id };
      },
      async aggregate(args: any) {
        const rows = entries.filter((e) => matchesWhere(e, args.where));
        if (rows.length === 0) return { _sum: { visits: null, points: null } };
        return {
          _sum: {
            visits: rows.reduce((t, e) => t + e.visits, 0),
            points: rows.reduce((t, e) => t + e.points, 0),
          },
        };
      },
      async findFirst(args: any) {
        return entries.find((e) => matchesWhere(e, args.where)) ?? null;
      },
      async findMany(args: any) {
        let rows = entries.filter((e) => matchesWhere(e, args.where));
        if (args.orderBy?.occurredAt === "asc") {
          rows = rows.slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
        } else if (args.orderBy?.occurredAt === "desc") {
          rows = rows.slice().sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
        }
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows;
      },
      async updateMany(args: any) {
        const rows = entries.filter((e) => matchesWhere(e, args.where));
        for (const r of rows) Object.assign(r, args.data);
        return { count: rows.length };
      },
    },
    $queryRaw: async () => [],
  };

  return { tx, accounts, entries };
}

function visitsProgram(overrides: Partial<LoyaltyProgramRow> = {}): LoyaltyProgramRow {
  return {
    ...offProgram(TENANT),
    mode: "VISITS",
    visitsPerReward: 5,
    rewardKind: "PERCENT",
    rewardPercent: 10,
    rewardBase: "SERVICES",
    rewardValidityMonths: null,
    activatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function pointsProgram(overrides: Partial<LoyaltyProgramRow> = {}): LoyaltyProgramRow {
  return {
    ...offProgram(TENANT),
    mode: "POINTS",
    pointsPerHundredXpf: 1,
    pointsPerReward: 100,
    pointsBase: "SERVICES",
    rewardKind: "AMOUNT",
    rewardAmountXpf: 500n,
    rewardBase: "SERVICES",
    activatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// lockAccount / insertEntry
// ══════════════════════════════════════════════════════════════════════════════════════════

test("lockAccount : trouve-ou-crée, idempotent sur (tenantId, clientFicheId)", async () => {
  const { tx, accounts } = makeFakeTx();
  const a1 = await lockAccount(tx, TENANT, "fiche-1", "Mélanie");
  const a2 = await lockAccount(tx, TENANT, "fiche-1", "Mélanie D.");
  assert.equal(a1.id, a2.id, "même fiche -> même compte");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].displayName, "Mélanie D.", "le nom affiché se rafraîchit");
});

test("insertEntry : un doublon sur (tenantId, ref) rend {duplicate:true} SANS lever", async () => {
  const { tx } = makeFakeTx();
  const account = await lockAccount(tx, TENANT, "fiche-1", "Mélanie");
  const data = {
    tenantId: TENANT,
    accountId: account.id,
    kind: "VISIT" as const,
    visits: 1,
    sourceType: "rdv",
    sourceId: "rdv-1",
    ref: "visit:rdv:rdv-1",
    occurredAt: new Date(),
  };
  const first = await insertEntry(tx, data);
  const second = await insertEntry(tx, data);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// creditVisit
// ══════════════════════════════════════════════════════════════════════════════════════════

test("creditVisit : programme OFF -> rien n'est écrit", async () => {
  const { tx, entries } = makeFakeTx();
  const out = await creditVisit(tx, {
    tenantId: TENANT,
    program: offProgram(TENANT),
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    appointmentId: "rdv-1",
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  assert.deepEqual(out, { credited: false, rewardsCreated: 0 });
  assert.equal(entries.length, 0);
});

test("creditVisit : RDV antérieur à activatedAt -> rien n'est écrit", async () => {
  const { tx, entries } = makeFakeTx();
  const program = visitsProgram({ activatedAt: new Date("2026-09-15T00:00:00Z") });
  const out = await creditVisit(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    appointmentId: "rdv-1",
    occurredAt: new Date("2026-09-01T10:00:00Z"), // avant activatedAt
  });
  assert.deepEqual(out, { credited: false, rewardsCreated: 0 });
  assert.equal(entries.length, 0);
});

test("creditVisit : rejeu de la même visite (même appointmentId) -> credited:false, aucune double écriture", async () => {
  const { tx, entries } = makeFakeTx();
  const program = visitsProgram();
  const args = {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    appointmentId: "rdv-1",
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  };
  const first = await creditVisit(tx, args);
  const second = await creditVisit(tx, args);
  assert.equal(first.credited, true);
  assert.equal(second.credited, false, "rejeu du même RDV honoré : idempotent");
  assert.equal(entries.filter((e) => e.kind === "VISIT").length, 1);
});

test("creditVisit : mode VISITS, 5 visites -> 1 récompense créée exactement à la 5e (jamais avant, jamais deux fois)", async () => {
  const { tx, entries } = makeFakeTx();
  const program = visitsProgram({ visitsPerReward: 5 });
  for (let i = 1; i <= 4; i++) {
    const out = await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-1",
      displayName: "Mélanie",
      appointmentId: `rdv-${i}`,
      occurredAt: new Date("2026-09-15T10:00:00Z"),
    });
    assert.equal(out.rewardsCreated, 0, `visite ${i}/5 : pas encore de récompense`);
  }
  const fifth = await creditVisit(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    appointmentId: "rdv-5",
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  assert.equal(fifth.rewardsCreated, 1, "la 5e visite franchit le seuil");
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1);

  // 🔴 LE TEST QUI COMPTE : les visites 6 à 9 ne créent PAS de 2e récompense sous un ref
  // différent — le net retombe à 0 après la récompense de la 5e visite (5 + REWARD(-5) = 0),
  // et `issueRewardsWhileNetReached` (lib/loyalty-db.ts) n'émet QUE tant que le net atteint le
  // seuil : 1, 2, 3, 4 ne le franchissent jamais.
  for (let i = 6; i <= 9; i++) {
    const out = await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-1",
      displayName: "Mélanie",
      appointmentId: `rdv-${i}`,
      occurredAt: new Date("2026-09-15T10:00:00Z"),
    });
    assert.equal(out.rewardsCreated, 0, `visite ${i} : aucun nouveau seuil franchi`);
  }
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1, "toujours UNE seule récompense après 9 visites");
});

test("creditVisit : mode COUNTER compte les visites SANS jamais créer de récompense", async () => {
  const { tx, entries } = makeFakeTx();
  const program = { ...visitsProgram(), mode: "COUNTER" };
  for (let i = 1; i <= 10; i++) {
    await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-1",
      displayName: "Mélanie",
      appointmentId: `rdv-${i}`,
      occurredAt: new Date("2026-09-15T10:00:00Z"),
    });
  }
  assert.equal(entries.filter((e) => e.kind === "VISIT").length, 10);
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// creditPoints
// ══════════════════════════════════════════════════════════════════════════════════════════

test("creditPoints : hors mode POINTS -> rien n'est écrit", async () => {
  const { tx, entries } = makeFakeTx();
  const out = await creditPoints(tx, {
    tenantId: TENANT,
    program: visitsProgram(), // mode VISITS, pas POINTS
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-1",
    points: 30,
    occurredAt: new Date(),
  });
  assert.deepEqual(out, { credited: false, rewardsCreated: 0 });
  assert.equal(entries.length, 0);
});

test("creditPoints : rejeu du même saleId -> credited:false (idempotent)", async () => {
  const { tx, entries } = makeFakeTx();
  const program = pointsProgram();
  const args = {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-1",
    points: 30,
    occurredAt: new Date(),
  };
  const first = await creditPoints(tx, args);
  const second = await creditPoints(tx, args);
  assert.equal(first.credited, true);
  assert.equal(second.credited, false);
  assert.equal(entries.filter((e) => e.kind === "POINTS").length, 1);
});

test("creditPoints : franchit le seuil pointsPerReward une seule fois, pas à chaque vente suivante", async () => {
  const { tx, entries } = makeFakeTx();
  const program = pointsProgram({ pointsPerReward: 100 });
  await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-1",
    points: 90,
    occurredAt: new Date(),
  });
  const crossing = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-2",
    points: 20, // 90 + 20 = 110 : franchit 100
    occurredAt: new Date(),
  });
  assert.equal(crossing.rewardsCreated, 1);
  const after = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-3",
    points: 5, // 110 + 5 = 115 : aucun nouveau seuil
    occurredAt: new Date(),
  });
  assert.equal(after.rewardsCreated, 0);
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// SOLDE NET NÉGATIF — correctif QA (2026-09-16)
//
// DÉFAUT PROUVÉ sur l'ancienne version (`issueRewardsForDelta`, retirée) : le solde net inclut
// les REWARD (-N), les REVERSAL et les ADJUST négatifs. `Math.floor` arrondit vers -∞ sur un
// solde négatif, donc `rewardsToCreate(sumAvant,N)` mentait dès que le compte était repassé sous
// zéro (récompense déjà émise puis vente annulée, ou correction ADMIN négative) — une récompense
// renaissait sur un `ref` neuf sans que la cliente ait regagné le seuil. `issueRewardsWhileNetReached`
// (lib/loyalty-db.ts) ne divise plus : il consomme le NET par tranches tant qu'il atteint le
// seuil, jamais en dessous.
// ══════════════════════════════════════════════════════════════════════════════════════════

test("🔴 (a) vente 600 pts (1 récompense, net 100) ; annulation (net -500) ; vente de 500 pts -> AUCUNE 2e récompense, net final 0", async () => {
  const { tx, entries } = makeFakeTx();
  const program = pointsProgram({ pointsPerReward: 500 });

  const saleA = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-A",
    points: 600,
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  assert.equal(saleA.rewardsCreated, 1, "600 pts franchit le seuil de 500 une fois : net 100 ensuite");

  // Annulation de la vente A (même écriture que `annulerVente` en réel) : reprend les 600 pts.
  // Net après reprise : 600 (POINTS) - 500 (REWARD) - 600 (REVERSAL) = -500.
  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-A" });

  const saleB = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-B",
    points: 500,
    occurredAt: new Date("2026-09-15T12:00:00Z"),
  });
  // 🔴 LE DÉFAUT PROUVÉ : l'ancien calcul comparait rewardsToCreate(-500,500)=Math.floor(-1)=-1 à
  // rewardsToCreate(0,500)=0, et la boucle `for i=-1; i<0; i++` créait UNE récompense fantôme —
  // alors que le net n'était REVENU qu'à 0, jamais remonté au seuil de 500.
  assert.equal(saleB.rewardsCreated, 0, "le net n'atteint que 0, jamais le seuil de 500 : aucune récompense");

  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1, "1 seule récompense au total");
  const account = entries.find((e) => e.kind === "POINTS")!.accountId;
  const netFinal = entries.filter((e) => e.accountId === account).reduce((t, e) => t + e.points, 0);
  assert.equal(netFinal, 0, "net final : 600 + 500 - 500 (reward) - 600 (reversal) = 0");
});

test("🔴 (b) 5 visites (1 récompense, net 0) ; ADJUST -3 (net -3) ; 6 visites -> AUCUNE 2e récompense, net final 3", async () => {
  const { tx, entries } = makeFakeTx();
  const program = visitsProgram({ visitsPerReward: 5 });

  for (let i = 1; i <= 5; i++) {
    await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-1",
      displayName: "Mélanie",
      appointmentId: `rdv-${i}`,
      occurredAt: new Date("2026-09-15T10:00:00Z"),
    });
  }
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1, "1 récompense après les 5 premières visites (net 0)");

  const adjust = await adjustLoyalty(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    visits: -3,
    points: 0,
    reason: "correction carnet papier",
    ref: "adjust:22222222-2222-4222-8222-222222222222",
    occurredAt: new Date("2026-09-16T09:00:00Z"),
  });
  assert.equal(adjust.ok, true);
  if (adjust.ok) assert.equal(adjust.rewardsCreated, 0, "un ADJUST négatif ne crée jamais de récompense");

  // 🔴 LE DÉFAUT PROUVÉ : le net est retombé à -3. SIX visites supplémentaires (une par une) le
  // ramènent à 3 (-3, -2, -1, 0, 1, 2, 3) — jamais au seuil de 5. L'ancien calcul par quotient
  // aurait pourtant créé une récompense fantôme dès la première visite qui suit l'ADJUST négatif
  // (`rewardsToCreate(-3,5)=Math.floor(-3/5)=-1`, `rewardsToCreate(-2,5)=Math.floor(-2/5)=-1`…
  // jusqu'à ce que le quotient remonte à 0, ce qui se produit AVANT que le net atteigne 5).
  for (let i = 6; i <= 11; i++) {
    const out = await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-1",
      displayName: "Mélanie",
      appointmentId: `rdv-${i}`,
      occurredAt: new Date("2026-09-16T10:00:00Z"),
    });
    assert.equal(out.rewardsCreated, 0, `visite ${i} : le seuil de 5 n'est pas encore franchi`);
  }

  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1, "toujours UNE seule récompense au total");
  const account = entries.find((e) => e.kind === "VISIT")!.accountId;
  const netFinal = entries.filter((e) => e.accountId === account).reduce((t, e) => t + e.visits, 0);
  assert.equal(netFinal, 3, "net final : 5 - 5 (reward) - 3 (adjust) + 6 (visites) = 3");
});

test("11 visites, seuil 5 -> 2 récompenses (à la 5e et à la 10e), net final 1", async () => {
  const { tx, entries } = makeFakeTx();
  const program = visitsProgram({ visitsPerReward: 5 });
  const rewardsAt: number[] = [];
  for (let i = 1; i <= 11; i++) {
    const out = await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-1",
      displayName: "Mélanie",
      appointmentId: `rdv-${i}`,
      occurredAt: new Date("2026-09-15T10:00:00Z"),
    });
    if (out.rewardsCreated > 0) rewardsAt.push(i);
  }
  assert.deepEqual(rewardsAt, [5, 10]);
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 2);
  const account = entries.find((e) => e.kind === "VISIT")!.accountId;
  const netFinal = entries.filter((e) => e.accountId === account).reduce((t, e) => t + e.visits, 0);
  assert.equal(netFinal, 1, "11 - 5 - 5 = 1");
});

test("ventes 300 / 300 / 600, seuil 500 -> 2 récompenses au total, net final 200", async () => {
  const { tx, entries } = makeFakeTx();
  const program = pointsProgram({ pointsPerReward: 500 });

  const r1 = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-1",
    points: 300,
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  assert.equal(r1.rewardsCreated, 0, "net 300 : sous le seuil");

  const r2 = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-2",
    points: 300,
    occurredAt: new Date("2026-09-15T11:00:00Z"),
  });
  assert.equal(r2.rewardsCreated, 1, "net 600 : franchit 500, retombe à 100");

  const r3 = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-3",
    points: 600,
    occurredAt: new Date("2026-09-15T12:00:00Z"),
  });
  assert.equal(r3.rewardsCreated, 1, "net 700 : franchit 500 une 2e fois, retombe à 200");

  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 2);
  const account = entries.find((e) => e.kind === "POINTS")!.accountId;
  const netFinal = entries.filter((e) => e.accountId === account).reduce((t, e) => t + e.points, 0);
  assert.equal(netFinal, 200, "300 + 300 + 600 - 500 - 500 = 200");
});

test("vente unique de 1200 pts, seuil 500 -> 2 récompenses dans la MÊME fournée (:0 et :1), net final 200", async () => {
  const { tx, entries } = makeFakeTx();
  const program = pointsProgram({ pointsPerReward: 500 });

  const out = await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    saleId: "sale-big",
    points: 1200,
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  assert.equal(out.rewardsCreated, 2, "1200 franchit 500 deux fois d'un coup (net 700 puis 200)");

  const rewards = entries.filter((e) => e.kind === "REWARD");
  assert.equal(rewards.length, 2);
  assert.ok(rewards.some((r) => r.ref === "reward:points:sale:sale-big:0"), "1re récompense de la fournée : index 0");
  assert.ok(rewards.some((r) => r.ref === "reward:points:sale:sale-big:1"), "2e récompense de la MÊME fournée : index 1");

  const account = entries.find((e) => e.kind === "POINTS")!.accountId;
  const netFinal = entries.filter((e) => e.accountId === account).reduce((t, e) => t + e.points, 0);
  assert.equal(netFinal, 200, "1200 - 500 - 500 = 200");
});

test("rejeu du même appointmentId au moment du franchissement du seuil -> AUCUNE récompense de plus", async () => {
  const { tx, entries } = makeFakeTx();
  const program = visitsProgram({ visitsPerReward: 5 });
  for (let i = 1; i <= 4; i++) {
    await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-1",
      displayName: "Mélanie",
      appointmentId: `rdv-${i}`,
      occurredAt: new Date("2026-09-15T10:00:00Z"),
    });
  }
  const fifth = {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    appointmentId: "rdv-5",
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  };
  const first = await creditVisit(tx, fifth);
  assert.equal(first.rewardsCreated, 1);

  // Rejeu du MÊME appointmentId (webhook réessayé, requête doublée…) : la ligne VISIT est un
  // doublon sur (tenantId, ref) -> court-circuit AVANT tout calcul de récompense.
  const replay = await creditVisit(tx, fifth);
  assert.equal(replay.credited, false);
  assert.equal(replay.rewardsCreated, 0);

  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1, "aucune récompense de plus au rejeu");
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// redeemReward — LE TEST QUI COMPTE : la course entre deux comptoirs
// ══════════════════════════════════════════════════════════════════════════════════════════

function seedReward(overrides: Partial<FakeEntry> = {}): FakeEntry {
  return {
    id: "reward-1",
    tenantId: TENANT,
    accountId: "account-1",
    kind: "REWARD",
    visits: -5,
    points: 0,
    rewardKind: "PERCENT",
    rewardPercent: 10,
    rewardAmountXpf: null,
    rewardBase: "SERVICES",
    expiresAt: null,
    redeemedAt: null,
    redeemedSaleId: null,
    rewardEntryId: null,
    discountXpf: null,
    sourceType: "rdv",
    sourceId: "rdv-5",
    ref: "reward:visit:rdv:rdv-5:0",
    saleId: null,
    actorId: null,
    actorName: null,
    reason: null,
    occurredAt: new Date("2026-09-01T00:00:00Z"),
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

test("redeemReward : consomme une récompense disponible et écrit la ligne REDEEM", async () => {
  const { tx, entries } = makeFakeTx([seedReward()]);
  const out = await redeemReward(tx, {
    tenantId: TENANT,
    rewardEntryId: "reward-1",
    saleId: "sale-1",
    discountXpf: 450n,
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  assert.deepEqual(out, { ok: true });
  const reward = entries.find((e) => e.id === "reward-1")!;
  assert.ok(reward.redeemedAt, "la récompense est marquée consommée");
  assert.equal(reward.redeemedSaleId, "sale-1");
  const redeem = entries.find((e) => e.kind === "REDEEM");
  assert.ok(redeem, "une ligne REDEEM a été écrite");
  assert.equal(redeem!.ref, "redeem:sale:sale-1");
  assert.equal(redeem!.discountXpf, 450n);
});

test("🔴 redeemReward : deuxième consommation de la MÊME récompense -> RACE, jamais deux fois brûlée", async () => {
  const { tx, entries } = makeFakeTx([seedReward()]);
  const first = await redeemReward(tx, {
    tenantId: TENANT,
    rewardEntryId: "reward-1",
    saleId: "sale-1",
    discountXpf: 450n,
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  const second = await redeemReward(tx, {
    tenantId: TENANT,
    rewardEntryId: "reward-1",
    saleId: "sale-2", // un autre comptoir, un autre ticket
    discountXpf: 450n,
    occurredAt: new Date("2026-09-15T10:00:05Z"),
  });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "RACE" });
  assert.equal(entries.filter((e) => e.kind === "REDEEM").length, 1, "une seule consommation a réellement eu lieu");
});

test("redeemReward : récompense déjà consommée dès le départ -> RACE immédiat", async () => {
  const { tx } = makeFakeTx([seedReward({ redeemedAt: new Date("2026-09-10T00:00:00Z"), redeemedSaleId: "sale-0" })]);
  const out = await redeemReward(tx, {
    tenantId: TENANT,
    rewardEntryId: "reward-1",
    saleId: "sale-1",
    discountXpf: 450n,
    occurredAt: new Date(),
  });
  assert.deepEqual(out, { ok: false, reason: "RACE" });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// reverseSale — annulation d'une vente PAID
// ══════════════════════════════════════════════════════════════════════════════════════════

test("reverseSale : reprend les points ET remet la récompense consommée disponible", async () => {
  const pointsEntry: FakeEntry = {
    ...seedReward({
      id: "points-1",
      kind: "POINTS",
      visits: 0,
      points: 30,
      ref: "points:sale:sale-1",
      saleId: "sale-1",
      sourceType: "sale",
      sourceId: "sale-1",
      rewardKind: null,
      rewardPercent: null,
      rewardBase: null,
    }),
  };
  const reward = seedReward({ id: "reward-9", accountId: "account-1" });
  const redeemEntry: FakeEntry = seedReward({
    id: "redeem-1",
    kind: "REDEEM",
    visits: 0,
    points: 0,
    ref: "redeem:sale:sale-1",
    saleId: "sale-1",
    sourceType: "sale",
    sourceId: "sale-1",
    rewardEntryId: "reward-9",
    discountXpf: 450n,
    rewardKind: null,
    rewardPercent: null,
    rewardBase: null,
  });
  reward.redeemedAt = new Date("2026-09-15T10:00:00Z");
  reward.redeemedSaleId = "sale-1";

  const { tx, entries } = makeFakeTx([pointsEntry, reward, redeemEntry]);

  // 🔴 CORRECTIF (2026-09-16) : plus d'`occurredAt` en paramètre — la REVERSAL prend celui de la
  // ligne qu'elle annule (ici 2026-09-01, cf. `seedReward`), jamais l'instant de l'appel.
  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-1" });

  const rewardAfter = entries.find((e) => e.id === "reward-9")!;
  assert.equal(rewardAfter.redeemedAt, null, "la récompense redevient disponible");
  assert.equal(rewardAfter.redeemedSaleId, null);

  const reversals = entries.filter((e) => e.kind === "REVERSAL");
  assert.equal(reversals.length, 2, "une REVERSAL pour les points, une pour la récompense rendue");
  const unpoints = reversals.find((e) => e.ref === "unpoints:sale:sale-1");
  assert.ok(unpoints);
  assert.equal(unpoints!.points, -30, "les points sont repris (signe inverse)");
  assert.equal(
    unpoints!.occurredAt.getTime(),
    pointsEntry.occurredAt.getTime(),
    "la reprise appartient au CYCLE du crédit annulé, pas à l'instant de l'annulation",
  );
  const unredeem = reversals.find((e) => e.ref === "unredeem:sale:sale-1");
  assert.ok(unredeem);
  assert.equal(unredeem!.rewardEntryId, "reward-9");
  assert.equal(
    unredeem!.occurredAt.getTime(),
    redeemEntry.occurredAt.getTime(),
    "la reprise de consommation appartient au CYCLE de la consommation annulée",
  );
});

test("reverseSale : vente sans points ni récompense -> aucune écriture", async () => {
  const { tx, entries } = makeFakeTx();
  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-vide" });
  assert.equal(entries.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// reverseSale — UNE REPRISE APPARTIENT AU CYCLE DU CRÉDIT QU'ELLE ANNULE — contre-QA sur 9a98e32
//
// DÉFAUT PROUVÉ (QA ciblée) : la REVERSAL prenait `occurredAt: new Date()` (l'instant de
// l'annulation). Un ticket du cycle 1 (+300 pts) annulé APRÈS une réactivation voit ses +300
// déjà exclus du net du cycle 2 (`sumPoints` filtre sur `occurredAt >= activatedAt`), mais sa
// reprise (-300), datée d'AUJOURD'HUI, ENTRAIT dans le cycle 2 : le net du cycle 2 passait de
// 100 à -200. ARBITRAGE : la REVERSAL prend l'`occurredAt` de la ligne qu'elle annule.
// ══════════════════════════════════════════════════════════════════════════════════════════

test("🔴 scénario QA : cycle 1 (300 pts) ; réactivation ; cycle 2 (100 pts) ; annulation du ticket du cycle 1 -> net du cycle 2 reste 100", async () => {
  const { tx } = makeFakeTx();
  const date1 = new Date("2026-01-01T00:00:00Z");
  const program1 = pointsProgram({ activatedAt: date1, pointsPerReward: 1_000_000 }); // seuil hors d'atteinte, pas de REWARD ici

  const cycle1 = await creditPoints(tx, {
    tenantId: TENANT,
    program: program1,
    clientFicheId: "fiche-cycles",
    displayName: "Cliente Cycles",
    saleId: "sale-cycle1",
    points: 300,
    occurredAt: new Date("2026-01-05T10:00:00Z"),
  });
  assert.equal(cycle1.credited, true);

  // Réactivation : changement de forme (POINTS -> VISITS -> POINTS aurait pareillement posé
  // `now`) — ici on simule directement le nouveau pivot via nextActivatedAt, comme les autres
  // tests « décision Marco 15/09 » de ce fichier.
  const dateReactivation = new Date("2026-06-01T00:00:00Z");
  const activatedAt2 = nextActivatedAt(date1, "POINTS", "VISITS", dateReactivation);
  const activatedAt3 = nextActivatedAt(activatedAt2, "VISITS", "POINTS", new Date("2026-06-02T00:00:00Z"))!;

  const program2 = pointsProgram({ activatedAt: activatedAt3, pointsPerReward: 1_000_000 });
  const cycle2 = await creditPoints(tx, {
    tenantId: TENANT,
    program: program2,
    clientFicheId: "fiche-cycles",
    displayName: "Cliente Cycles",
    saleId: "sale-cycle2",
    points: 100,
    occurredAt: new Date("2026-06-05T10:00:00Z"),
  });
  assert.equal(cycle2.credited, true);

  // Annulation du ticket du CYCLE 1, APRÈS la réactivation.
  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-cycle1" });

  tx.loyaltyProgram.findFirst = async () => program2;
  const summary = await accountSummary(tx, TENANT, ["fiche-cycles"]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].points, 100, "le net du cycle 2 n'est PAS affecté par la reprise d'un crédit du cycle 1");
});

test("reverseSale : un ticket du CYCLE COURANT annulé fait bien diminuer le net (la reprise compte dans SON cycle)", async () => {
  const { tx } = makeFakeTx();
  const date1 = new Date("2026-01-01T00:00:00Z");
  const program = pointsProgram({ activatedAt: date1, pointsPerReward: 1_000_000 });

  await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-courant",
    displayName: "Cliente Courant",
    saleId: "sale-a",
    points: 300,
    occurredAt: new Date("2026-01-05T10:00:00Z"),
  });
  await creditPoints(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-courant",
    displayName: "Cliente Courant",
    saleId: "sale-b",
    points: 100,
    occurredAt: new Date("2026-01-06T10:00:00Z"),
  });

  tx.loyaltyProgram.findFirst = async () => program;
  const before = await accountSummary(tx, TENANT, ["fiche-courant"]);
  assert.equal(before[0].points, 400);

  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-a" });

  const after = await accountSummary(tx, TENANT, ["fiche-courant"]);
  assert.equal(after[0].points, 100, "l'annulation d'un ticket du cycle COURANT diminue bien le net du même cycle");
});

test("reverseSale : la récompense rendue par unredeem est de nouveau disponible, quel que soit le cycle de sa consommation d'origine", async () => {
  const reward = seedReward({ id: "reward-cycle", accountId: "account-cycle", occurredAt: new Date("2026-01-01T00:00:00Z") });
  reward.redeemedAt = new Date("2026-01-10T00:00:00Z");
  reward.redeemedSaleId = "sale-old-cycle";
  const redeemEntry: FakeEntry = seedReward({
    id: "redeem-cycle",
    accountId: "account-cycle",
    kind: "REDEEM",
    visits: 0,
    points: 0,
    ref: "redeem:sale:sale-old-cycle",
    saleId: "sale-old-cycle",
    sourceType: "sale",
    sourceId: "sale-old-cycle",
    rewardEntryId: "reward-cycle",
    discountXpf: 300n,
    rewardKind: null,
    rewardPercent: null,
    rewardBase: null,
    // Consommée dans un cycle ANCIEN — largement avant l'activatedAt du programme courant.
    occurredAt: new Date("2026-01-10T00:00:00Z"),
  });
  const { tx, entries } = makeFakeTx([reward, redeemEntry]);

  // Annulation APRÈS une réactivation (activatedAt courant très postérieur à la consommation).
  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-old-cycle" });

  const rewardAfter = entries.find((e) => e.id === "reward-cycle")!;
  assert.equal(rewardAfter.redeemedAt, null, "de nouveau disponible, malgré le changement de cycle");
  assert.equal(rewardAfter.redeemedSaleId, null);
  assert.equal(
    isRewardAvailable({ redeemedAt: rewardAfter.redeemedAt, expiresAt: rewardAfter.expiresAt }),
    true,
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// adjustLoyalty — correction manuelle ADMIN
// ══════════════════════════════════════════════════════════════════════════════════════════

test("adjustLoyalty : motif trop court -> REASON_TOO_SHORT", async () => {
  const { tx } = makeFakeTx();
  const out = await adjustLoyalty(tx, {
    tenantId: TENANT,
    program: visitsProgram(),
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    visits: 1,
    points: 0,
    reason: "ok",
    ref: "adjust:abc",
    occurredAt: new Date(),
  });
  assert.deepEqual(out, { ok: false, error: "REASON_TOO_SHORT" });
});

test("adjustLoyalty : visits et points à 0 -> NO_CHANGE", async () => {
  const { tx } = makeFakeTx();
  const out = await adjustLoyalty(tx, {
    tenantId: TENANT,
    program: visitsProgram(),
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    visits: 0,
    points: 0,
    reason: "carnet papier perdu",
    ref: "adjust:abc",
    occurredAt: new Date(),
  });
  assert.deepEqual(out, { ok: false, error: "NO_CHANGE" });
});

test("adjustLoyalty : ref qui ne commence pas par adjust: -> REF_INVALID", async () => {
  const { tx } = makeFakeTx();
  const out = await adjustLoyalty(tx, {
    tenantId: TENANT,
    program: visitsProgram(),
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    visits: 1,
    points: 0,
    reason: "carnet papier perdu",
    ref: "not-adjust:abc",
    occurredAt: new Date(),
  });
  assert.deepEqual(out, { ok: false, error: "REF_INVALID" });
});

test("adjustLoyalty : correction valide écrit ADJUST et peut créer une récompense", async () => {
  const { tx, entries } = makeFakeTx();
  const program = visitsProgram({ visitsPerReward: 5 });
  const out = await adjustLoyalty(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-1",
    displayName: "Mélanie",
    visits: 5,
    points: 0,
    reason: "reprise historique carnet papier",
    ref: "adjust:11111111-1111-4111-8111-111111111111",
    occurredAt: new Date("2026-09-15T10:00:00Z"),
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.rewardsCreated, 1);
  assert.equal(entries.filter((e) => e.kind === "ADJUST").length, 1);
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 1);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// PLAFOND SANS EXCEPTION — correctif contre-QA (2026-09-16)
//
// DÉFAUT PROUVÉ : `issueRewardsWhileNetReached` pouvait LEVER au-delà de 1000 récompenses en un
// seul événement — atteignable avec un réglage extrême (1 point pour une récompense, un ticket
// de 1 000 F à 100 pts/100F ⇒ 100 000 pts d'un coup). La boucle tournant DANS la transaction de
// `checkoutSale` APRÈS l'insertion des paiements, l'exception aurait fait échouer un encaissement
// déjà persisté. Décision : ne plus jamais lever — s'arrêter à 1000 récompenses par événement, le
// net excédentaire (encore ≥ perReward) reste dans le journal et est repris par le PROCHAIN
// événement, sans rien perdre.
// ══════════════════════════════════════════════════════════════════════════════════════════

test("plafond : ADJUST de +100 000 points au seuil 1 -> exactement 1000 récompenses, PAS d'exception, net 99 000 ; l'événement suivant en crée 1000 de plus", async () => {
  const { tx, entries } = makeFakeTx();
  const program = pointsProgram({ pointsPerReward: 1 });

  const out1 = await adjustLoyalty(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-plafond",
    displayName: "Cliente Plafond",
    visits: 0,
    points: 100_000,
    reason: "correction exceptionnelle — reprise historique",
    ref: "adjust:99999999-9999-4999-8999-999999999991",
    occurredAt: new Date("2026-09-16T10:00:00Z"),
  });
  assert.equal(out1.ok, true);
  if (out1.ok) assert.equal(out1.rewardsCreated, 1000);

  const rewardsAfter1 = entries.filter((e) => e.kind === "REWARD");
  assert.equal(rewardsAfter1.length, 1000);
  const netAfter1 = entries
    .filter((e) => e.accountId === rewardsAfter1[0].accountId)
    .reduce((t, e) => t + e.points, 0);
  assert.equal(netAfter1, 99_000);

  // Événement suivant : le net excédentaire (>= perReward) n'a pas été perdu — il est repris et
  // continue de produire des récompenses, plafonnées à 1000 de plus par événement.
  const out2 = await adjustLoyalty(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-plafond",
    displayName: "Cliente Plafond",
    visits: 0,
    points: 1,
    reason: "petit ajustement suivant",
    ref: "adjust:99999999-9999-4999-8999-999999999992",
    occurredAt: new Date("2026-09-16T11:00:00Z"),
  });
  assert.equal(out2.ok, true);
  if (out2.ok) assert.equal(out2.rewardsCreated, 1000);

  const rewardsAfter2 = entries.filter((e) => e.kind === "REWARD");
  assert.equal(rewardsAfter2.length, 2000);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// DÉCISION MARCO (15/09) : « À chaque changement de forme ou réactivation, le compteur et les
// points repartent de zéro, comme au premier jour. Les récompenses déjà gagnées restent dues. »
//
// Pivot : `activatedAt` (lib/loyalty.ts#nextActivatedAt). `sumVisits`/`sumPoints` (moteur net,
// lib/loyalty-db.ts) n'agrègent QUE les lignes `occurredAt >= activatedAt`, quel que soit leur
// `kind` — un ADJUST ou un REWARD antérieur ne pèse pas plus qu'un VISIT antérieur. La
// disponibilité d'une récompense (`isRewardAvailable`), elle, n'en dépend PAS.
//
// ⚠️ SABOTAGE : retirer `if (!activatedAt) return 0;` ET le filtre `occurredAt: { gte:
// activatedAt }` de `sumVisits`/`sumPoints` (lib/loyalty-db.ts) fait ROUGIR le premier test
// ci-dessous (« changement de forme active repart de zéro »). Le rétablir le fait revert au vert.
// ══════════════════════════════════════════════════════════════════════════════════════════

test("décision Marco 15/09 : changement de FORME active repart de zéro — 3 visites VISITS N=5 -> POINTS -> VISITS -> 2 visites -> 0 récompense, net 2", async () => {
  const { tx, entries } = makeFakeTx();
  const date1 = new Date("2026-01-01T00:00:00Z");
  let program = visitsProgram({ activatedAt: date1, visitsPerReward: 5 });

  for (let i = 1; i <= 3; i++) {
    const out = await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-forme",
      displayName: "Cliente Forme",
      appointmentId: `rdv-forme-${i}`,
      occurredAt: new Date(`2026-01-0${i + 1}T10:00:00Z`),
    });
    assert.equal(out.rewardsCreated, 0);
  }
  assert.equal(entries.filter((e) => e.kind === "VISIT").length, 3);

  // VISITS -> POINTS : changement de forme, nouveau pivot.
  const date2 = new Date("2026-03-01T00:00:00Z");
  const activatedAt2 = nextActivatedAt(date1, "VISITS", "POINTS", date2);
  assert.equal(activatedAt2?.getTime(), date2.getTime());

  // POINTS -> VISITS : nouveau changement de forme, nouveau pivot (indépendant du précédent).
  const date3 = new Date("2026-06-01T00:00:00Z");
  const activatedAt3 = nextActivatedAt(activatedAt2, "POINTS", "VISITS", date3);
  assert.equal(activatedAt3?.getTime(), date3.getTime());

  program = visitsProgram({ activatedAt: activatedAt3, visitsPerReward: 5 });
  let lastOut: { credited: boolean; rewardsCreated: number } | undefined;
  for (let i = 1; i <= 2; i++) {
    lastOut = await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-forme",
      displayName: "Cliente Forme",
      appointmentId: `rdv-forme-new-${i}`,
      occurredAt: new Date(`2026-06-0${i + 1}T10:00:00Z`),
    });
  }
  assert.equal(lastOut?.rewardsCreated, 0);
  assert.equal(entries.filter((e) => e.kind === "REWARD").length, 0);

  tx.loyaltyProgram.findFirst = async () => program;
  const summary = await accountSummary(tx, TENANT, ["fiche-forme"]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].visits, 2); // les 3 anciennes visites (avant activatedAt3) ne comptent plus
  assert.equal(summary[0].activatedAt?.getTime(), activatedAt3.getTime());
});

test("décision Marco 15/09 : récompense gagnée, puis OFF, puis réactivation -> récompense toujours disponible, compteur à 0", async () => {
  const { tx, entries } = makeFakeTx();
  const date1 = new Date("2026-01-01T00:00:00Z");
  const program1 = visitsProgram({ activatedAt: date1, visitsPerReward: 5 });

  for (let i = 1; i <= 5; i++) {
    await creditVisit(tx, {
      tenantId: TENANT,
      program: program1,
      clientFicheId: "fiche-off",
      displayName: "Cliente OFF",
      appointmentId: `rdv-off-${i}`,
      occurredAt: new Date(`2026-01-0${i}T10:00:00Z`),
    });
  }
  const reward = entries.find((e) => e.kind === "REWARD");
  assert.ok(reward);
  assert.equal(isRewardAvailable({ redeemedAt: reward!.redeemedAt, expiresAt: reward!.expiresAt }), true);

  // OFF : couper le programme ne remet RIEN à zéro (activatedAt reste date1).
  const dateOff = new Date("2026-02-01T00:00:00Z");
  const activatedAtOff = nextActivatedAt(date1, "VISITS", "OFF", dateOff);
  assert.equal(activatedAtOff?.getTime(), date1.getTime());

  // Réactivation : OFF -> VISITS, nouveau pivot.
  const dateReactivation = new Date("2026-03-01T00:00:00Z");
  const activatedAt2 = nextActivatedAt(activatedAtOff, "OFF", "VISITS", dateReactivation);
  assert.equal(activatedAt2?.getTime(), dateReactivation.getTime());

  const program2 = visitsProgram({ activatedAt: activatedAt2, visitsPerReward: 5 });
  tx.loyaltyProgram.findFirst = async () => program2;
  const summary = await accountSummary(tx, TENANT, ["fiche-off"]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].visits, 0);
  assert.equal(summary[0].activatedAt?.getTime(), activatedAt2.getTime());

  const rewardView = summary[0].rewards.find((r) => r.id === reward!.id);
  assert.ok(rewardView);
  assert.equal(rewardView!.redeemedAt, null);
  assert.equal(isRewardAvailable(rewardView!), true);
});

test("décision Marco 15/09 : changement de N SANS changement de forme -> net conservé (activatedAt inchangé)", async () => {
  const { tx } = makeFakeTx();
  const date1 = new Date("2026-01-01T00:00:00Z");
  let program = visitsProgram({ activatedAt: date1, visitsPerReward: 10 });

  for (let i = 1; i <= 3; i++) {
    await creditVisit(tx, {
      tenantId: TENANT,
      program,
      clientFicheId: "fiche-n",
      displayName: "Cliente N",
      appointmentId: `rdv-n-${i}`,
      occurredAt: new Date(`2026-01-0${i}T10:00:00Z`),
    });
  }

  // Changement de RÉGLAGE (N: 10 -> 5), MÊME forme (VISITS -> VISITS) : activatedAt inchangé.
  const dateChange = new Date("2026-02-01T00:00:00Z");
  const activatedAtAfter = nextActivatedAt(date1, "VISITS", "VISITS", dateChange);
  assert.equal(activatedAtAfter?.getTime(), date1.getTime());

  program = visitsProgram({ activatedAt: activatedAtAfter, visitsPerReward: 5 });
  const out1 = await creditVisit(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-n",
    displayName: "Cliente N",
    appointmentId: "rdv-n-4",
    occurredAt: new Date("2026-02-02T10:00:00Z"),
  });
  // net = 3 (conservées) + 1 = 4, sous le NOUVEAU seuil de 5 -> pas encore de récompense.
  assert.equal(out1.rewardsCreated, 0);

  const out2 = await creditVisit(tx, {
    tenantId: TENANT,
    program,
    clientFicheId: "fiche-n",
    displayName: "Cliente N",
    appointmentId: "rdv-n-5",
    occurredAt: new Date("2026-02-03T10:00:00Z"),
  });
  // net = 5 -> franchit le nouveau seuil : preuve que les 3 anciennes visites ont bien compté.
  assert.equal(out2.rewardsCreated, 1);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// checkoutSale / annulerVente (lib/caisse.ts) — contrat figé par lecture de source
// (mêmes limites que checkout-route.test.ts / void-route.test.ts : `./tenant` importe le
// vrai client Prisma + `next/headers`, non exécutable par ce runner)
// ══════════════════════════════════════════════════════════════════════════════════════════

const libDir = path.dirname(fileURLToPath(import.meta.url));
const caisseFile = path.join(libDir, "caisse.ts");

function caisseSrc(): string {
  assert.ok(existsSync(caisseFile), `introuvable : ${caisseFile}`);
  return readFileSync(caisseFile, "utf8");
}

function exportBody(src: string, name: string): string {
  const debut = src.indexOf(`export async function ${name}`);
  assert.ok(debut > -1, `${name} introuvable`);
  const reste = src.slice(debut);
  const finRelative = reste.indexOf("\nexport ", 1);
  return finRelative > -1 ? reste.slice(0, finRelative) : reste;
}

function corpsCheckoutSale(): string {
  return exportBody(caisseSrc(), "checkoutSale");
}

function corpsAnnulerVente(): string {
  return exportBody(caisseSrc(), "annulerVente");
}

test("checkoutSale : montant de la ligne fidélité différent de l'attendu -> LOYALTY_AMOUNT_MISMATCH, AVANT tout paiement persisté", () => {
  const corps = corpsCheckoutSale();
  assert.match(corps, /LOYALTY_AMOUNT_MISMATCH/);
  // Le contrôle est fait AVANT le bloc de persistance des paiements ("J'encaisse, puis je rends").
  const iMismatch = corps.indexOf("LOYALTY_AMOUNT_MISMATCH");
  const iPersist = corps.indexOf('« J\'encaisse, puis je rends »');
  assert.ok(iMismatch > -1 && iPersist > -1 && iMismatch < iPersist, "le contrôle fidélité doit précéder la persistance des paiements");
});

test("checkoutSale : récompense expirée -> LOYALTY_NOT_REDEEMABLE reason EXPIRED, via isRewardAvailable", () => {
  const corps = corpsCheckoutSale();
  assert.match(corps, /LOYALTY_NOT_REDEEMABLE.*EXPIRED/s);
  assert.match(corps, /isRewardAvailable\(/);
});

test("🔴 checkoutSale : deuxième consommation dans la transaction -> LOYALTY_RACE, traitée comme GIFT_CARD_RACE", () => {
  const corps = corpsCheckoutSale();
  assert.match(corps, /throw new Error\("LOYALTY_RACE"\)/);
  assert.match(corps, /loyaltyRace\.hit = true/);
  // Le refus final vers l'appelant reprend le MÊME vocabulaire que GIFT_CARD_NOT_REDEEMABLE.
  assert.match(corps, /if \(loyaltyRace\.hit\) \{\s*\n\s*return \{ ok: false, error: "LOYALTY_NOT_REDEEMABLE", reason: "ALREADY_REDEEMED" \};/);
});

test("checkoutSale : sans options.loyalty, aucun crédit de points n'est tenté (bloc gardé)", () => {
  const corps = corpsCheckoutSale();
  assert.match(corps, /if \(options\?\.loyalty\) \{/);
});

test("checkoutSale : sans options.redeemLoyalty, aucune consommation n'est tentée (bloc gardé)", () => {
  const corps = corpsCheckoutSale();
  assert.match(corps, /if \(options\?\.redeemLoyalty\) \{/);
  assert.match(corps, /let loyaltyRedeem: \{ rewardEntryId: string; discountXpf: bigint \} \| null = null;/);
});

test("checkoutSale : loyalty et redeemLoyalty sont des champs OPTIONNELS de CheckoutOptions", () => {
  const corps = caisseSrc();
  const debut = corps.indexOf("export type CheckoutOptions");
  const fin = corps.indexOf("\n};", debut);
  const bloc = corps.slice(debut, fin);
  assert.match(bloc, /loyalty\?:/);
  assert.match(bloc, /redeemLoyalty\?:/);
});

test("🔴 checkoutSale : le crédit de points est calculé avec pointsForSale et le paramètre giftCardSalesXpf (décision Marco : un bon ne rapporte jamais de points)", () => {
  const corps = corpsCheckoutSale();
  assert.match(corps, /giftCardSalesXpf = giftCardsToIssue\.reduce/);
  assert.match(corps, /pointsForSale\(\s*\n?\s*linesForPoints,\s*\n?\s*sale\.totalXpf,\s*\n?\s*paidTotal,\s*\n?\s*program\.pointsBase[^,]*,\s*\n?\s*program\.pointsPerHundredXpf,\s*\n?\s*giftCardSalesXpf,/);
});

test("checkoutSale : rejeu idempotent d'une vente déjà PAID -> retour anticipé AVANT tout code fidélité", () => {
  const corps = corpsCheckoutSale();
  const iAlreadyPaid = corps.indexOf('alreadyPaid: true');
  const iLoyaltyRedeem = corps.indexOf("options?.redeemLoyalty");
  const iLoyaltyCredit = corps.indexOf("options?.loyalty");
  assert.ok(iAlreadyPaid > -1, "retour anticipé sur vente déjà PAID introuvable");
  assert.ok(iAlreadyPaid < iLoyaltyRedeem, "le retour anticipé doit précéder le contrôle de consommation fidélité");
  assert.ok(iAlreadyPaid < iLoyaltyCredit, "le retour anticipé doit précéder le crédit de points fidélité");
});

test("annulerVente : reprise fidélité UNIQUEMENT si la vente était PAID, dans la MÊME transaction que markVoid", () => {
  const corps = corpsAnnulerVente();
  const iGuard = corps.indexOf('if (sale.status === "PAID") {');
  const iCall = corps.indexOf("await reverseSaleLoyalty(tx, { tenantId, saleId });");
  assert.ok(iGuard > -1, "garde `sale.status === PAID` introuvable");
  assert.ok(iCall > -1, "appel à reverseSaleLoyalty introuvable, ou porte encore un occurredAt");
  assert.ok(iGuard < iCall && iCall - iGuard < 700, "l'appel doit être DANS la garde PAID, pas ailleurs");
});

test("annulerVente : reverseSaleLoyalty n'est plus appelée avec un occurredAt — la reprise prend celui du crédit annulé (correctif 2026-09-16)", () => {
  const corps = corpsAnnulerVente();
  assert.doesNotMatch(corps, /reverseSaleLoyalty\(tx, \{[^}]*occurredAt/);
});

test("annulerVente : commentaire TODO fidélité sur l'avoir Compta (pas de reprise auto dans ce lot)", () => {
  const corps = corpsAnnulerVente();
  assert.match(corps, /TODO fidélité : reprise auto sur avoir Compta/);
  assert.match(corps, /décision Marco 15\/09 : plus tard,\s*\r?\n\s*\/\/ Core-Compta verrouillé/);
});
