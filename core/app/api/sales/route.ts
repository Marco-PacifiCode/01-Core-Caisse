import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { withTenant } from "@/lib/tenant";
import { createSale, type SaleLineInput } from "@/lib/caisse";
import { xpf } from "@/lib/serialize";
import type { LineKind } from "@prisma/client";

const VALID_KINDS: LineKind[] = ["SERVICE", "PRODUCT", "OTHER"];

/**
 * POST /api/sales
 * Crée un TICKET (statut DRAFT) — service-to-service (X-Core-Key). Sert à ouvrir une vente depuis
 * une source externe (ex : RDV honoré) ou un poste de caisse distant. Idempotent sur
 * (sourceType, sourceId) quand fournis.
 *
 * Body : { tenantId, cashierId?, sessionId?, clientName?, sourceType?, sourceId?,
 *          lines: { kind, label, productId?, qty, unitXpf }[] }
 *   unitXpf : XPF entier (number).  productId : requis si kind=PRODUCT.
 *
 * Réponse 200 : { ok, saleId, totalXpf, alreadyExisted }
 */
export async function POST(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    tenantId?: string;
    cashierId?: string;
    sessionId?: string;
    clientName?: string;
    sourceType?: string;
    sourceId?: string;
    lines?: { kind?: string; label?: string; productId?: string; qty?: number; unitXpf?: number }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, lines } = body;
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });
  if (!lines || lines.length === 0) return NextResponse.json({ error: "lines ne peut pas être vide" }, { status: 400 });

  const parsed: SaleLineInput[] = [];
  for (const l of lines) {
    if (!l.kind || !VALID_KINDS.includes(l.kind as LineKind)) {
      return NextResponse.json({ error: `kind invalide (attendu: ${VALID_KINDS.join(", ")})` }, { status: 400 });
    }
    if (!l.label) return NextResponse.json({ error: "label requis sur chaque ligne" }, { status: 400 });
    if (l.qty === undefined || l.unitXpf === undefined) {
      return NextResponse.json({ error: "qty et unitXpf requis sur chaque ligne" }, { status: 400 });
    }
    parsed.push({
      kind: l.kind as LineKind,
      label: l.label,
      productId: l.productId ?? null,
      qty: l.qty,
      unitXpf: BigInt(Math.round(l.unitXpf)),
    });
  }

  const result = await createSale(tenantId, {
    cashierId: body.cashierId,
    sessionId: body.sessionId ?? null,
    clientName: body.clientName ?? null,
    sourceType: body.sourceType ?? null,
    sourceId: body.sourceId ?? null,
    lines: parsed,
  });

  if (!result.ok) {
    const status = result.error === "PRODUCT_LINE_WITHOUT_PRODUCT" || result.error === "INVALID_QTY" ? 400 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}

/**
 * GET /api/sales?tenantId=...&status=...&sessionId=...&from=ISO&to=ISO&limit=...
 * Historique des tickets d'un tenant (S2S, X-Core-Key).
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const status = searchParams.get("status");
  const sessionId = searchParams.get("sessionId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Math.min(Number(searchParams.get("limit")) || 100, 500);

  const sales = await withTenant(tenantId, (tx) =>
    tx.sale.findMany({
      where: {
        tenantId,
        ...(status ? { status: status as never } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(from || to
          ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
          : {}),
      },
      include: { payments: { select: { method: true, amountXpf: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );

  return NextResponse.json({
    sales: sales.map((s) => ({
      id: s.id,
      status: s.status,
      sessionId: s.sessionId,
      clientName: s.clientName,
      totalXpf: xpf(s.totalXpf),
      invoiceId: s.invoiceId,
      invoiceNumber: s.invoiceNumber,
      sourceType: s.sourceType,
      sourceId: s.sourceId,
      paidXpf: xpf(s.payments.reduce((t, p) => t + p.amountXpf, 0n)),
      createdAt: s.createdAt,
      paidAt: s.paidAt,
    })),
  });
}
