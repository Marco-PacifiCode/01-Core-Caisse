// Commandes de bons cadeaux en ligne — accès base (même client et même cloisonnement RLS que
// `listGiftCards` / `createGiftCardWithoutSale` de lib/caisse.ts : `withTenant`).

import { Prisma, type GiftCardOrderStatus } from "@prisma/client";
import { withTenant } from "./tenant";
import { generateOrderReference, type GiftCardOrderInput } from "./gift-card-order";

/** Plafond anti-abus : commandes PENDING créées sur 24 h glissantes, par marchand. */
export const MAX_PENDING_PER_24H = 100;

export async function createGiftCardOrder(tenantId: string, input: GiftCardOrderInput) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pending = await withTenant(tenantId, (tx) =>
    tx.giftCardOrder.count({ where: { tenantId, status: "PENDING", createdAt: { gte: since } } }),
  );
  if (pending >= MAX_PENDING_PER_24H) return { ok: false as const, error: "TOO_MANY_PENDING" as const };

  for (let attempt = 1; ; attempt += 1) {
    try {
      const order = await withTenant(tenantId, (tx) =>
        tx.giftCardOrder.create({ data: { tenantId, reference: generateOrderReference(), ...input } }),
      );
      return { ok: true as const, order };
    } catch (e) {
      // P2002 = référence déjà prise chez ce marchand (@@unique(tenantId, reference)) : on retire.
      if (attempt < 3 && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
  }
}

export async function listGiftCardOrders(
  tenantId: string,
  filter: { status?: GiftCardOrderStatus; take?: number } = {},
) {
  const take = Math.min(Math.max(filter.take ?? 100, 1), 200);
  return withTenant(tenantId, (tx) =>
    tx.giftCardOrder.findMany({
      where: { tenantId, ...(filter.status ? { status: filter.status } : {}) },
      orderBy: { createdAt: "desc" },
      take,
    }),
  );
}

export async function getGiftCardOrder(tenantId: string, id: string) {
  return withTenant(tenantId, (tx) => tx.giftCardOrder.findFirst({ where: { id, tenantId } }));
}

/** Annule une commande PENDING. UPDATE conditionnel : jamais de SELECT puis UPDATE. */
export async function cancelGiftCardOrder(
  tenantId: string,
  id: string,
  opts: { reason?: string | null; by?: string | null; byName?: string | null } = {},
) {
  return withTenant(tenantId, async (tx) => {
    const { count } = await tx.giftCardOrder.updateMany({
      where: { id, tenantId, status: "PENDING" },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: opts.reason ?? null,
        cancelledBy: opts.by ?? null,
        cancelledByName: opts.byName ?? null,
      },
    });
    const order = await tx.giftCardOrder.findFirst({ where: { id, tenantId } });
    if (count === 0) {
      return { ok: false as const, error: order ? ("NOT_PENDING" as const) : ("NOT_FOUND" as const) };
    }
    return { ok: true as const, order: order! };
  });
}
