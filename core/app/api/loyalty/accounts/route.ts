import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { listLoyaltyAccounts } from "@/lib/caisse";

export const runtime = "nodejs";

/** UUID strict — dupliqué (comme lib/sale-lock.ts) pour ne rien tirer de plus que Next ici. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * GET /api/loyalty/accounts?tenantId=…&clientFicheId=a,b,… — soldes fidélité de N fiches (S2S).
 * 50 identifiants au plus, chacun un UUID valide (sinon 400).
 *
 * 🔒 AUCUNE FICHE N'EST CRÉÉE À LA LECTURE (plan §6 piège n°4) : une fiche sans compte fidélité
 *    est simplement ABSENTE du tableau — `accountSummary` (lib/loyalty-db.ts) ne fait QUE lire.
 *
 * Réponse 200 : { ok:true, accounts:[{clientFicheId, displayName, visits, points, rewards, lastEntries}] }
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tenantId = (url.searchParams.get("tenantId") ?? "").trim();
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const raw = (url.searchParams.get("clientFicheId") ?? "").trim();
  if (!raw) return NextResponse.json({ error: "clientFicheId requis" }, { status: 400 });

  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ error: "clientFicheId requis" }, { status: 400 });
  if (ids.length > 50) return NextResponse.json({ error: "50 identifiants au plus" }, { status: 400 });
  for (const id of ids) {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: `clientFicheId invalide : ${id}` }, { status: 400 });
  }

  const accounts = await listLoyaltyAccounts(tenantId, ids);
  return NextResponse.json({ ok: true, accounts });
}
