import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { withTenant } from "@/lib/tenant";
import { xpf } from "@/lib/serialize";

export const runtime = "nodejs";

/**
 * GET /api/sales/:id?tenantId=<uuid>
 * Lecture service-à-service du détail d'un ticket (S2S, X-Core-Key).
 * Elle existe pour que l'émission d'un AVOIR côté Core-Compta puisse retrouver les lignes
 * PRODUIT du ticket et leurs `productId`, afin de ré-incrémenter le stock : la facture Compta
 * ne porte pas les `productId`, seule la vente Core-Caisse les connaît (SaleLine.productId).
 * Strictement en lecture, aucun effet de bord.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const { searchParams } = new URL(req.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const sale = await withTenant(tenantId, (tx) =>
    tx.sale.findFirst({
      where: { id, tenantId },
      include: { lines: { orderBy: { createdAt: "asc" } }, payments: true },
    }),
  );

  if (!sale) return NextResponse.json({ error: "Vente introuvable" }, { status: 404 });

  return NextResponse.json({
    id: sale.id,
    tenantId: sale.tenantId,
    sessionId: sale.sessionId,
    status: sale.status,
    cashierId: sale.cashierId,
    clientName: sale.clientName,
    subtotalXpf: xpf(sale.subtotalXpf),
    totalXpf: xpf(sale.totalXpf),
    sourceType: sale.sourceType,
    sourceId: sale.sourceId,
    invoiceId: sale.invoiceId,
    invoiceNumber: sale.invoiceNumber,
    paidAt: sale.paidAt,
    comptaSyncedAt: sale.comptaSyncedAt,
    stockSyncedAt: sale.stockSyncedAt,
    createdAt: sale.createdAt,
    lines: sale.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      label: l.label,
      productId: l.productId,
      qty: l.qty,
      unitXpf: xpf(l.unitXpf),
      lineXpf: xpf(l.lineXpf),
    })),
    payments: sale.payments.map((p) => ({
      id: p.id,
      amountXpf: xpf(p.amountXpf),
      method: p.method,
      createdAt: p.createdAt,
    })),
  });
}
