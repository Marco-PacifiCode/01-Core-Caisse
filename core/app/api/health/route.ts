// GET /api/health — healthcheck APPLICATIF (sans secret) : prouve que le service ET sa base répondent
// et que la RLS est bien posée sur les tables tenant (pas seulement que PM2/443 sont up).
//
// Réponse : { ok, db, rlsEnabled, rlsForced, deps: { compta, stock } } — HTTP 200 si ok, 503 sinon.
//   db         : SELECT 1 a répondu.
//   rlsEnabled : pg_class.relrowsecurity sur "Sale" (policy tenant_isolation active).
//   rlsForced  : pg_class.relforcerowsecurity — informatif : le design local = ENABLE + rôle app
//                NON-propriétaire (cf. prisma/rls.sql) ; FORCE=false n'est donc pas un échec ici.
//   deps       : joignabilité des cores consommés (Compta, Stock) — sondes courtes (2 s), INFORMATIVES :
//                une panne de dépendance ne rend pas la Caisse "down" (les encaissements restent pris,
//                la synchro converge ensuite) → n'affecte pas le status HTTP. "mock" en mode mock.
//   ok = db && rlsEnabled.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { coreClientTargets } from "@/lib/clients";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DepState = "up" | "down" | "mock";

/** Joignable = la cible répond en HTTP (peu importe le status : 401/404 prouvent que le service vit). */
async function probe(url: string): Promise<DepState> {
  try {
    await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(2000) });
    return "up";
  } catch {
    return "down";
  }
}

export async function GET() {
  let db = false;
  let rlsEnabled = false;
  let rlsForced = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
    const rows = await prisma.$queryRaw<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"Sale"'::regclass
    `;
    rlsEnabled = rows[0]?.relrowsecurity === true;
    rlsForced = rows[0]?.relforcerowsecurity === true;
  } catch (e) {
    console.error("[api/health] DB KO", e instanceof Error ? e.message : e);
  }

  const targets = coreClientTargets();
  const [compta, stock] = targets.mocked
    ? (["mock", "mock"] as DepState[])
    : await Promise.all([probe(targets.compta), probe(targets.stock)]);

  const ok = db && rlsEnabled;
  return NextResponse.json(
    { ok, db, rlsEnabled, rlsForced, deps: { compta, stock } },
    { status: ok ? 200 : 503 },
  );
}
