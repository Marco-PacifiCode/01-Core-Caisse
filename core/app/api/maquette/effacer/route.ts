import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/tenant";
import { log } from "@/lib/log";
import { checkCleMaquette, codeMaquette, estUuid, estVerrouOccupe, statutRefus, verifierPourEffacer } from "@/lib/maquette";

/**
 * POST /api/maquette/effacer — démo privée : efface ENTIÈREMENT un tenant maquette échu.
 * Clé dédiée MAQUETTE_API_KEY ; Core-Auth doit confirmer une maquette ÉCHUE sur un hôte
 * demo-*.pacificode.nc. L'effacement est porté par la base : effacer_tenant_maquette(uuid)
 * (SECURITY DEFINER, migration 20261111130000), appelée par le rôle applicatif ordinaire.
 * Réponses : 200 { efface: true, compteurs } · 400 · 401 · 403 · 409 (refus MAQUETTE_* ou échéance
 * non passée) · 503 (Core-Auth injoignable, clé non configurée, ou CAISSE_OCCUPEE : un verrou est tenu,
 * l'effacement sera retenté la nuit suivante).
 */
export async function POST(req: NextRequest) {
  const cle = checkCleMaquette(req);
  if (!cle.ok) return NextResponse.json({ error: cle.status === 503 ? "MAQUETTE_CLE_NON_CONFIGUREE" : "Unauthorized" }, { status: cle.status });

  let brut: unknown;
  try {
    brut = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const corps = brut as { tenantId?: unknown } | null;
  if (typeof corps !== "object" || corps === null || Array.isArray(corps) || Object.keys(corps).some((k) => k !== "tenantId") || !estUuid(corps.tenantId)) {
    return NextResponse.json({ error: "corps : { tenantId } (UUID) attendu" }, { status: 400 });
  }
  const tenantId = corps.tenantId.toLowerCase();

  const verdict = await verifierPourEffacer(tenantId);
  if (!verdict.ok) return NextResponse.json({ error: verdict.refus }, { status: statutRefus(verdict.refus, "effacer") });

  try {
    const lignes = await withTenant(tenantId, async (tx) => {
      // Borne l'instruction d'effacement ELLE-MÊME : un statement_timeout posé à l'intérieur de
      // la fonction ne vaut que pour les instructions suivantes, pas pour celle qui l'exécute.
      // Les déclencheurs désactivés tiennent un verrou sur les 4 tables l4 de TOUS les tenants
      // jusqu'à la fin de la transaction : la fenêtre ne doit jamais dépasser quelques secondes.
      await tx.$executeRaw`SELECT set_config('statement_timeout', '10s', true)`;
      return tx.$queryRaw<{ compteurs: Record<string, number> }[]>`SELECT effacer_tenant_maquette(${tenantId}::uuid) AS compteurs`;
    }, { timeout: 15_000, maxWait: 5_000 });
    return NextResponse.json({ efface: true, compteurs: lignes[0]?.compteurs ?? {} });
  } catch (err) {
    const code = codeMaquette(err);
    if (code) return NextResponse.json({ error: code }, { status: 409 });
    if (estVerrouOccupe(err)) return NextResponse.json({ error: "CAISSE_OCCUPEE" }, { status: 503 });
    log.error("maquette.effacer", err, { tenantId });
    return NextResponse.json({ error: "MAQUETTE_EFFACEMENT_ECHEC" }, { status: 500 });
  }
}
