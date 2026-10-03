import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { UUID_RE } from "@/lib/gift-card";
import { serializeGiftCardOrder, validateGiftCardOrder } from "@/lib/gift-card-order";
import { createGiftCardOrder, listGiftCardOrders } from "@/lib/gift-card-orders-db";

export const runtime = "nodejs";

const STATUSES = ["PENDING", "PAID", "CANCELLED"] as const;
type Status = (typeof STATUSES)[number];

/**
 * GET /api/gift-card-orders — les commandes de bons en ligne d'un marchand (S2S, X-Core-Key).
 *
 * Query : ?tenantId=… [&status=PENDING|PAID|CANCELLED] [&take=…] (take : défaut 100, borné à 200)
 *
 * Réponses : 200 { ok:true, orders:[…] } · 400 tenantId manquant/invalide · 401 clé absente.
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tenantId = (url.searchParams.get("tenantId") ?? "").trim();
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return NextResponse.json({ ok: false, error: "tenantId requis" }, { status: 400 });
  }

  const rawStatus = url.searchParams.get("status");
  const status = STATUSES.includes(rawStatus as Status) ? (rawStatus as Status) : undefined;
  const rawTake = Number(url.searchParams.get("take") ?? "");
  const take = Number.isInteger(rawTake) && rawTake > 0 ? Math.min(rawTake, 200) : undefined;

  const rows = await listGiftCardOrders(tenantId, { status, take });
  return NextResponse.json({ ok: true, orders: rows.map(serializeGiftCardOrder) });
}

/**
 * POST /api/gift-card-orders — la vitrine dépose une COMMANDE de bon « à encaisser » (S2S).
 *
 * ⚠️ AUCUN BON N'EST CRÉÉ ICI, AUCUN ARGENT N'EST PRIS. Le bon naît à l'encaissement, dans la
 * transaction de `POST /api/sales/:id/checkout` (`giftCards[].orderId`), qui passe la commande
 * à PAID. Phase 2 (paiement carte) : paymentProvider / paymentRef, vides pour l'instant.
 *
 * Body : { tenantId, amountXpf, serviceId?, serviceLabel?, buyerName, buyerPhone?, buyerEmail?,
 *          beneficiaryName, beneficiaryPhone?, beneficiaryEmail?, message? }
 *
 * Réponses :
 *   201 { ok:true, order }
 *   400 { ok:false, error:<refus nommé> }
 *   401 clé de service absente
 *   429 { ok:false, error:"TOO_MANY_PENDING" } — plus de 100 commandes en attente sur 24 h
 */
export async function POST(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return NextResponse.json({ ok: false, error: "tenantId requis" }, { status: 400 });
  }

  const validated = validateGiftCardOrder(body);
  if (!validated.ok) return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });

  const result = await createGiftCardOrder(tenantId, validated.data);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 429 });
  return NextResponse.json({ ok: true, order: serializeGiftCardOrder(result.order) }, { status: 201 });
}
