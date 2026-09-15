import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { adjustLoyaltyAccount } from "@/lib/caisse";

export const runtime = "nodejs";

/**
 * POST /api/loyalty/adjust — correction manuelle d'un compte fidélité (S2S, X-Core-Key).
 *
 * 🔒 DROIT : ADMIN seule (plan §2.1) — garde posée côté SURFACE, jamais ici (décision Marco,
 *    2026-09-15, même principe que PUT /api/loyalty/program).
 *
 * Body : { tenantId, clientFicheId, displayName, visits?, points?, reason, ref, by?, byName? }
 *   `reason` : 3 caractères au moins. `ref` : doit commencer par "adjust:" (idempotence côté
 *   appelant — l'écran fournit un identifiant unique).
 * Réponse 200 : { ok:true, rewardsCreated } · 400 { error:REASON_TOO_SHORT|NO_CHANGE|REF_INVALID }
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

  const visits = typeof body.visits === "number" && Number.isFinite(body.visits) ? Math.trunc(body.visits) : 0;
  const points = typeof body.points === "number" && Number.isFinite(body.points) ? Math.trunc(body.points) : 0;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const ref = typeof body.ref === "string" ? body.ref.trim() : "";

  const result = await adjustLoyaltyAccount(tenantId, {
    clientFicheId,
    displayName,
    visits,
    points,
    reason,
    ref,
    by: typeof body.by === "string" ? body.by : null,
    byName: typeof body.byName === "string" ? body.byName : null,
  });

  if (!result.ok) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
