import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { listerPostes, modifierPoste } from "@/lib/postes";

export const dynamic = "force-dynamic";

/**
 * GET /api/postes?tenantId=...
 * Consommation du quota de postes + registre.
 * → { cle: "CAISSE", quoi, niveau, plafond, utilise, postes: [{ posteId, libelle, actif, horsQuota, creeLe }] }
 * `plafond` null = pas de plafond (aucun droit dans Core-Auth, ou Core-Auth injoignable).
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const tenantId = new URL(req.url).searchParams.get("tenantId")?.trim();
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });
  return NextResponse.json(await listerPostes(tenantId));
}

/**
 * PATCH /api/postes
 * Body : { tenantId, posteId, libelle?, actif? }
 * Désactiver un poste libère une place ; le rallumer repasse par le plafond (409 quota_atteint).
 * 409 SESSION_OUVERTE : on ne désactive pas un poste en train d'encaisser. 404 POSTE_INCONNU.
 */
export async function PATCH(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const posteId = typeof body.posteId === "string" ? body.posteId.trim() : "";
  if (!tenantId || !posteId) return NextResponse.json({ error: "tenantId et posteId sont requis" }, { status: 400 });
  if (body.libelle !== undefined && body.libelle !== null && typeof body.libelle !== "string") {
    return NextResponse.json({ error: "libelle invalide" }, { status: 400 });
  }
  if (body.actif !== undefined && typeof body.actif !== "boolean") {
    return NextResponse.json({ error: "actif invalide" }, { status: 400 });
  }
  const result = await modifierPoste(tenantId, posteId, {
    ...(body.libelle !== undefined ? { libelle: body.libelle as string | null } : {}),
    ...(body.actif !== undefined ? { actif: body.actif as boolean } : {}),
  });
  if (!result.ok) return NextResponse.json(result, { status: result.error === "POSTE_INCONNU" ? 404 : 409 });
  return NextResponse.json(result);
}
