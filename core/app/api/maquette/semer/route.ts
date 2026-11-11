import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/tenant";
import { log } from "@/lib/log";
import { checkCleMaquette, codeMaquette, planifierSemis, statutRefus, validerCorpsSemer, verifierPourSemer } from "@/lib/maquette";
import { semerJournees } from "@/lib/maquette-semis";

/**
 * POST /api/maquette/semer — démo privée : sème de fausses ventes dans un tenant MAQUETTE.
 * Clé dédiée MAQUETTE_API_KEY (X-Core-Key) ; Core-Auth doit confirmer, à l'instant, une maquette non
 * échue sur un hôte demo-*.pacificode.nc. Idempotent : inscrire_tenant_maquette (registre) rend
 * faux si le tenant est déjà inscrit → rien n'est écrit. La base REFUSE d'inscrire un tenant qui a
 * déjà une vente ou un fait de caisse (MAQUETTE_INSCRIPTION_REFUSEE → 409).
 * Aucun appel à Core-Paiement, Core-Compta, Core-Stock ni Core-Comms (cf. lib/maquette-semis.ts).
 * Corps : { tenantId, jeu: { articles: [{ nom, prix, tgc }], ticketsParJour: { min, max }, jours? } }
 * Réponses : 201 { deja: false, compteurs } · 200 { deja: true, compteurs: {} } · 400 · 401 · 403 · 409 · 503
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
  const corps = validerCorpsSemer(brut);
  if (!corps.ok) return NextResponse.json({ error: corps.erreur }, { status: 400 });
  const { tenantId, jeu } = corps.valeur;

  const verdict = await verifierPourSemer(tenantId);
  if (!verdict.ok) return NextResponse.json({ error: verdict.refus }, { status: statutRefus(verdict.refus, "semer") });

  const plan = planifierSemis(jeu, tenantId, new Date());
  try {
    const resultat = await withTenant(tenantId, async (tx) => {
      const [{ inscrit }] = await tx.$queryRaw<{ inscrit: boolean }[]>`SELECT inscrire_tenant_maquette(${tenantId}::uuid) AS inscrit`;
      if (!inscrit) return { deja: true as const };
      return { deja: false as const, compteurs: await semerJournees(tx, tenantId, plan) };
    }, { timeout: 180_000, maxWait: 10_000 });
    if (resultat.deja) return NextResponse.json({ deja: true, compteurs: {} }, { status: 200 });
    return NextResponse.json({ deja: false, compteurs: resultat.compteurs }, { status: 201 });
  } catch (err) {
    const code = codeMaquette(err);
    if (code) return NextResponse.json({ error: code }, { status: 409 });
    log.error("maquette.semer", err, { tenantId });
    return NextResponse.json({ error: "MAQUETTE_SEMIS_ECHEC" }, { status: 500 });
  }
}
