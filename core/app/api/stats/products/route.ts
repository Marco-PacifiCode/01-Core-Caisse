import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { horsPortee } from "@/lib/cles-service";
import { withTenant } from "@/lib/tenant";
import { xpf } from "@/lib/serialize";
import { parsePeriod, topProductsByMonth, totalsByProduct } from "@/lib/stats-products";

/**
 * GET /api/stats/products?tenantId=...&from=YYYY-MM-DD&to=YYYY-MM-DD   (S2S, X-Core-Key)
 * Produits vendus par mois (fuseau Pacific/Noumea, jours from et to inclus), ventes PAID,
 * lignes PRODUCT, vente totalement remboursée exclue, remboursements partiels déduits.
 * Période max 13 mois (400 sinon). Lecture seule, sous RLS. Détail : lib/stats-products.ts.
 *
 * Réponse 200 : { from, to, items: [{ month, productId, label, qty, amountXpf }],
 *                 totals: [{ productId, label, qty, amountXpf }] }
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });
  const refus = horsPortee(req, tenantId); if (refus) return refus;

  const period = parsePeriod(searchParams.get("from"), searchParams.get("to"));
  if ("error" in period) return NextResponse.json({ error: period.error }, { status: 400 });

  const rows = await withTenant(tenantId, (tx) => topProductsByMonth(tx, tenantId, period.startUtc, period.endUtc));
  return NextResponse.json({
    from: period.from,
    to: period.to,
    items: rows.map((r) => ({ month: r.month, productId: r.productId, label: r.label, qty: r.qty, amountXpf: xpf(r.amountXpf) })),
    totals: totalsByProduct(rows).map((r) => ({ productId: r.productId, label: r.label, qty: r.qty, amountXpf: xpf(r.amountXpf) })),
  });
}
