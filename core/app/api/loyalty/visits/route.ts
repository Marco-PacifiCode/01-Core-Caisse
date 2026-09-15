import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { creditLoyaltyVisit } from "@/lib/caisse";

export const runtime = "nodejs";

/**
 * POST /api/loyalty/visits — crédite une visite honorée (S2S, X-Core-Key).
 *
 * Appelée par la surface juste après un passage à COMPLETED côté Core-RDV (lot R1) — BEST-EFFORT
 * côté APPELANT : un échec ici doit être logué sans jamais casser l'encaissement (plan §2.3).
 * Ce Core, lui, reste strict et silencieux : programme `OFF`, RDV antérieur à `activatedAt`, ou
 * visite déjà créditée (rejeu) → `credited:false`, jamais une erreur HTTP.
 *
 * Body : { tenantId, clientFicheId, displayName, appointmentId, occurredAt?, by?, byName? }
 * Réponse 200 : { ok:true, credited: boolean }
 */
export async function POST(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const clientFicheId = typeof body.clientFicheId === "string" ? body.clientFicheId.trim() : "";
  if (!clientFicheId) return NextResponse.json({ error: "clientFicheId requis" }, { status: 400 });

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) return NextResponse.json({ error: "displayName requis" }, { status: 400 });

  const appointmentId = typeof body.appointmentId === "string" ? body.appointmentId.trim() : "";
  if (!appointmentId) return NextResponse.json({ error: "appointmentId requis" }, { status: 400 });

  let occurredAt: Date | undefined;
  if (typeof body.occurredAt === "string" && body.occurredAt) {
    const d = new Date(body.occurredAt);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "occurredAt : date ISO invalide" }, { status: 400 });
    }
    occurredAt = d;
  }

  const result = await creditLoyaltyVisit(tenantId, {
    clientFicheId,
    displayName,
    appointmentId,
    occurredAt,
    by: typeof body.by === "string" ? body.by : null,
    byName: typeof body.byName === "string" ? body.byName : null,
  });
  return NextResponse.json(result);
}
