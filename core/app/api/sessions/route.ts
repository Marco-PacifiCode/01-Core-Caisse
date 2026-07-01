import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { withTenant } from "@/lib/tenant";
import { openSession } from "@/lib/caisse";
import { xpf } from "@/lib/serialize";

/**
 * POST /api/sessions
 * Ouvre une session de caisse (S2S, X-Core-Key) avec un fond de caisse (espèces).
 * Une seule session OPEN à la fois par tenant.
 *
 * Body : { tenantId, openedBy, openingFloatXpf?, note? }
 * Réponse 200 : { ok, session } · 409 { ok:false, error:"SESSION_ALREADY_OPEN", sessionId }
 */
export async function POST(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { tenantId?: string; openedBy?: string; openingFloatXpf?: number; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, openedBy } = body;
  if (!tenantId || !openedBy) {
    return NextResponse.json({ error: "tenantId et openedBy sont requis" }, { status: 400 });
  }

  const result = await openSession(tenantId, {
    openedBy,
    openingFloatXpf: BigInt(Math.round(body.openingFloatXpf ?? 0)),
    note: body.note,
  });

  if (!result.ok) return NextResponse.json(result, { status: 409 });

  return NextResponse.json({
    ok: true,
    session: {
      id: result.session.id,
      status: result.session.status,
      openedBy: result.session.openedBy,
      openingFloatXpf: xpf(result.session.openingFloatXpf),
      openedAt: result.session.openedAt,
    },
  });
}

/**
 * GET /api/sessions?tenantId=...&status=...&limit=...
 * Liste des sessions d'un tenant (S2S).
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });
  const status = searchParams.get("status");
  const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);

  const sessions = await withTenant(tenantId, (tx) =>
    tx.cashSession.findMany({
      where: { tenantId, ...(status ? { status: status as never } : {}) },
      orderBy: { openedAt: "desc" },
      take: limit,
    }),
  );

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      status: s.status,
      openedBy: s.openedBy,
      openedAt: s.openedAt,
      openingFloatXpf: xpf(s.openingFloatXpf),
      closedAt: s.closedAt,
      closedBy: s.closedBy,
      closingCountedXpf: xpf(s.closingCountedXpf),
      expectedXpf: xpf(s.expectedXpf),
      varianceXpf: xpf(s.varianceXpf),
    })),
  });
}
