import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { importerCloture } from "@/lib/caisse";

/**
 * POST /api/sessions/import
 * IMPORTE une clôture Z déjà faite hors ligne (S2S, X-Core-Key) — ROUTE SÉPARÉE du chemin vivant
 * POST /api/sessions + POST /api/sessions/:id/close, INTOUCHÉ, qui sert les 3 marchands en temps
 * réel. Réservée aux caisses sans réseau (ex. Rôtisserie de Pouembout) dont la tablette encaisse
 * hors ligne et archive son Z EN LOCAL : ce Z est une PIÈCE DÉJÀ ÉTABLIE, importée telle quelle —
 * aucun rattachement de ventes, aucun recalcul du Z côté serveur. La session est créée
 * directement CLOSED.
 *
 * Body : { tenantId, sourceType, sourceId, posteId?, openedBy, openedByName?,
 *          openedAt, closedAt, openingFloatXpf, closingCountedXpf, expectedXpf, note? }
 *   sourceType/sourceId : origine de l'import — portent l'idempotence (une même journée
 *     réémise ne crée pas de doublon, cf. uniq_session_external_source).
 *   openedAt/closedAt : ISO 8601, closedAt >= openedAt, pas plus de 60 s dans le futur.
 *   openingFloatXpf/closingCountedXpf/expectedXpf : XPF entiers. `varianceXpf` n'est PAS un
 *     champ d'entrée : il est TOUJOURS recalculé serveur (closingCountedXpf - expectedXpf).
 *
 * Réponse 200 : { ok:true, sessionId, alreadyExisted, varianceXpf }
 * Erreurs 400 : SOURCE_REQUISE · DATES_INVALIDES · MONTANT_INVALIDE · tenantId/openedBy manquants.
 */
export async function POST(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    tenantId?: string;
    sourceType?: string;
    sourceId?: string;
    posteId?: string;
    openedBy?: string;
    openedByName?: string;
    openedAt?: string;
    closedAt?: string;
    openingFloatXpf?: number;
    closingCountedXpf?: number;
    expectedXpf?: number;
    note?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, openedBy } = body;
  if (!tenantId || !openedBy) {
    return NextResponse.json({ error: "tenantId et openedBy sont requis" }, { status: 400 });
  }

  const result = await importerCloture(tenantId, {
    sourceType: body.sourceType ?? null,
    sourceId: body.sourceId ?? null,
    posteId: body.posteId?.trim() || null,
    openedBy,
    openedByName: body.openedByName?.trim() || undefined,
    openedAt: body.openedAt ?? null,
    closedAt: body.closedAt ?? null,
    openingFloatXpf: body.openingFloatXpf ?? null,
    closingCountedXpf: body.closingCountedXpf ?? null,
    expectedXpf: body.expectedXpf ?? null,
    note: body.note ?? null,
  });

  if (!result.ok) return NextResponse.json(result, { status: 400 });

  return NextResponse.json({
    ok: true,
    sessionId: result.sessionId,
    alreadyExisted: result.alreadyExisted,
    varianceXpf: result.varianceXpf,
  });
}
