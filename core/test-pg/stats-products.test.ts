// Recette PostgreSQL réelle de l'agrégation GET /api/stats/products (lib/stats-products.ts).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { parsePeriod, topProductsByMonth } from "../lib/stats-products.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL est obligatoire pour test:pg");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });

const inTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async tx => { await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`; return fn(tx); });

async function vente(tenantId: string, paidAt: string, lines: { productId: string; label: string; qty: number; unit: number; kind?: "PRODUCT" | "SERVICE" }[],
  opts: { status?: "PAID" | "VOID" | "DRAFT"; fully?: boolean } = {}) {
  const saleId = randomUUID();
  const ids: string[] = [];
  await inTenant(tenantId, async tx => {
    await tx.sale.create({ data: { id: saleId, tenantId, status: opts.status ?? "PAID", paidAt: new Date(paidAt),
      totalXpf: BigInt(lines.reduce((s, l) => s + l.qty * l.unit, 0)), ...(opts.fully ? { fullyRefundedAt: new Date() } : {}) } });
    for (const l of lines) {
      const id = randomUUID(); ids.push(id);
      await tx.saleLine.create({ data: { id, tenantId, saleId, kind: l.kind ?? "PRODUCT", label: l.label, productId: l.productId,
        qty: l.qty, unitXpf: BigInt(l.unit), lineXpf: BigInt(l.qty * l.unit) } });
    }
  });
  return { saleId, ids };
}
const lire = (tenantId: string, from: string, to: string) => {
  const p = parsePeriod(from, to); assert.ok(!("error" in p));
  return inTenant(tenantId, tx => topProductsByMonth(tx, tenantId, p.startUtc, p.endUtc));
};

test("stats produits : cumul, exclusions, remboursement partiel, isolation, frontières de mois Nouméa", async () => {
  const t1 = randomUUID(), t2 = randomUUID();
  const A = randomUUID(), B = randomUUID();
  // Cumul de 2 ventes du même produit (libellé le plus récent gardé).
  await vente(t1, "2026-03-10T00:00:00Z", [{ productId: A, label: "Ancien nom", qty: 2, unit: 1000 }]);
  const v2 = await vente(t1, "2026-03-11T00:00:00Z", [{ productId: A, label: "Nouveau nom", qty: 3, unit: 1000 }, { productId: B, label: "B", qty: 10, unit: 500 }]);
  // Exclues : annulée, brouillon, totalement remboursée, ligne service.
  await vente(t1, "2026-03-12T00:00:00Z", [{ productId: A, label: "x", qty: 50, unit: 1 }], { status: "VOID" });
  await vente(t1, "2026-03-12T00:00:00Z", [{ productId: A, label: "x", qty: 50, unit: 1 }], { status: "DRAFT" });
  await vente(t1, "2026-03-12T00:00:00Z", [{ productId: A, label: "x", qty: 50, unit: 1 }], { fully: true });
  await vente(t1, "2026-03-12T00:00:00Z", [{ productId: A, label: "x", qty: 50, unit: 1, kind: "SERVICE" }]);
  // Frontières : 2026-03-31T12:59Z = 23:59 le 31/03 à Nouméa (mars) ; 13:00Z = 00:00 le 01/04 (avril).
  await vente(t1, "2026-03-31T12:59:00Z", [{ productId: B, label: "B", qty: 1, unit: 500 }]);
  await vente(t1, "2026-03-31T13:00:00Z", [{ productId: B, label: "B", qty: 7, unit: 500 }]);
  // Autre tenant : invisible.
  await vente(t2, "2026-03-10T00:00:00Z", [{ productId: A, label: "Autre", qty: 99, unit: 1 }]);
  // Remboursement partiel DONE de 1 unité de A (ligne de v2), PENDING ignoré.
  await inTenant(t1, async tx => {
    await tx.partialRefund.create({ data: { tenantId: t1, actionId: randomUUID(), saleId: v2.saleId, status: "DONE", input: {},
      plan: { invoiceId: "i", amountXpf: 1000, fullyRefunded: false, parTaux: [], lines: [{ lineId: v2.ids[0], qty: 1, ttcXpf: 1000, tgcRatePpm: 0 }] } } });
    await tx.partialRefund.create({ data: { tenantId: t1, actionId: randomUUID(), saleId: v2.saleId, status: "PENDING", input: {},
      plan: { invoiceId: "i", amountXpf: 1000, fullyRefunded: false, parTaux: [], lines: [{ lineId: v2.ids[0], qty: 1, ttcXpf: 1000, tgcRatePpm: 0 }] } } });
  });

  const r = await lire(t1, "2026-03-01", "2026-04-30");
  const vue = r.map(x => [x.month, x.productId === A ? "A" : "B", x.label, x.qty, Number(x.amountXpf)]);
  assert.deepEqual(vue, [
    ["2026-03", "B", "B", 11, 5500],            // 10 + 1 (23:59 le 31/03)
    ["2026-03", "A", "Nouveau nom", 4, 4000],   // 2 + 3 - 1 remboursé
    ["2026-04", "B", "B", 7, 3500],             // 00:00 le 01/04 Nouméa
  ]);
  // Isolation : t2 ne voit que son produit, et t1 ne voit rien de t2.
  const r2 = await lire(t2, "2026-03-01", "2026-04-30");
  assert.deepEqual(r2.map(x => [x.qty, x.label]), [[99, "Autre"]]);
  // RLS : sous t2, une requête sur le tenant t1 ne rend rien.
  const p = parsePeriod("2026-03-01", "2026-04-30"); assert.ok(!("error" in p));
  assert.deepEqual(await inTenant(t2, tx => topProductsByMonth(tx, t1, p.startUtc, p.endUtc)), []);
});
