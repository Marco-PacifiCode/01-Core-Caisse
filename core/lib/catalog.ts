// lib/catalog.ts — récupère le catalogue produits d'un tenant depuis Core-Stock (lecture S2S).
// La caisse a besoin du catalogue pour composer un ticket avec des lignes PRODUCT (productId + prix).
// En mode mock (CORE_CLIENTS_MOCK) ou si Stock est injoignable, renvoie [] (l'écran caisse permet
// alors la saisie de lignes libres SERVICE/OTHER).

import { clientsAreMocked } from "./clients";

export type CatalogProduct = {
  id: string;
  name: string;
  sku: string | null;
  priceXpf: number;
  qtyOnHand: number;
};

/**
 * Liste les produits actifs d'un tenant via Core-Stock.
 * Utilise GET /api/stock/levels?tenantId=… (niveaux + produits). Tolérant : [] en cas d'échec.
 */
export async function fetchCatalog(tenantId: string): Promise<CatalogProduct[]> {
  if (clientsAreMocked()) return [];
  const url = process.env.CORE_STOCK_URL || "http://localhost:3105";
  const key = process.env.CORE_STOCK_API_KEY || "";
  try {
    const res = await fetch(`${url}/api/stock/levels?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: { "X-Core-Key": key },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      levels?: { productId?: string; id?: string; name?: string; sku?: string | null; priceXpf?: number; qtyOnHand?: number }[];
      products?: { id?: string; name?: string; sku?: string | null; priceXpf?: number; qtyOnHand?: number }[];
    };
    const rows = data.levels ?? data.products ?? [];
    return rows
      .map((r) => ({
        id: (r as { productId?: string; id?: string }).productId ?? (r as { id?: string }).id ?? "",
        name: r.name ?? "",
        sku: r.sku ?? null,
        priceXpf: Number(r.priceXpf ?? 0),
        qtyOnHand: Number(r.qtyOnHand ?? 0),
      }))
      .filter((p) => p.id && p.name);
  } catch {
    return [];
  }
}
