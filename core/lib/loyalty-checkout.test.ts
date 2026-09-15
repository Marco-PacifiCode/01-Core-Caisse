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
  offProgram,
  type LoyaltyTx,
  type LoyaltyProgramRow,
} from "./loyalty-db.ts";

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
    if (row[key] !== where[key]) return false;
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
  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-A", occurredAt: new Date("2026-09-15T11:00:00Z") });

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

  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-1", occurredAt: new Date("2026-09-16T09:00:00Z") });

  const rewardAfter = entries.find((e) => e.id === "reward-9")!;
  assert.equal(rewardAfter.redeemedAt, null, "la récompense redevient disponible");
  assert.equal(rewardAfter.redeemedSaleId, null);

  const reversals = entries.filter((e) => e.kind === "REVERSAL");
  assert.equal(reversals.length, 2, "une REVERSAL pour les points, une pour la récompense rendue");
  const unpoints = reversals.find((e) => e.ref === "unpoints:sale:sale-1");
  assert.ok(unpoints);
  assert.equal(unpoints!.points, -30, "les points sont repris (signe inverse)");
  const unredeem = reversals.find((e) => e.ref === "unredeem:sale:sale-1");
  assert.ok(unredeem);
  assert.equal(unredeem!.rewardEntryId, "reward-9");
});

test("reverseSale : vente sans points ni récompense -> aucune écriture", async () => {
  const { tx, entries } = makeFakeTx();
  await reverseSale(tx, { tenantId: TENANT, saleId: "sale-vide", occurredAt: new Date() });
  assert.equal(entries.length, 0);
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
  assert.match(corps, /if \(sale\.status === "PAID"\) \{\s*\n\s*await reverseSaleLoyalty\(tx, \{ tenantId, saleId, occurredAt: new Date\(\) \}\);/);
});

test("annulerVente : commentaire TODO fidélité sur l'avoir Compta (pas de reprise auto dans ce lot)", () => {
  const corps = corpsAnnulerVente();
  assert.match(corps, /TODO fidélité : reprise auto sur avoir Compta/);
  assert.match(corps, /décision Marco 15\/09 : plus tard,\s*\r?\n\s*\/\/ Core-Compta verrouillé/);
});
