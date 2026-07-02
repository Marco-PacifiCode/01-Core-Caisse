// POST /api/cron/repair-sales — balayage de REPRISE des ventes en attente de synchro Compta/Stock.
//
// Pas de scheduler intégré à Next : cette route est destinée à être appelée par un cron système sur
// le VPS (Contabo), typiquement toutes les ~15 min. Protégée par une clé de service DÉDIÉE
// (header X-Cron-Key = env CRON_KEY), distincte de la clé S2S (X-Core-Key) pour cloisonner les
// surfaces d'accès — même pattern que Core-RDV /api/cron/reminders.
//
// Idempotent : chaque passage ne rejoue que les étapes manquantes des ventes PAID non convergées,
// et toutes les cibles dédupliquent (cf. lib/sync.ts) → rejouer ne double jamais rien.
//
// Ligne crontab recommandée (heure serveur, toutes les 15 min) — NE PAS installer ici,
// c'est de l'infra Contabo (cf. README) :
//   */15 * * * * curl -fsS -X POST http://localhost:3106/api/cron/repair-sales \
//     -H "X-Cron-Key: $CRON_KEY" >> /var/log/core-caisse-repair.log 2>&1

import { NextRequest, NextResponse } from "next/server";
import { sweepPendingSales } from "@/lib/repair-sweep";

// Job cross-tenant à effets réseau → jamais mis en cache / prérendu.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_KEY;
  if (!expected) {
    console.error("[api/cron/repair-sales] CRON_KEY non configuré — refus de toute requête");
    return NextResponse.json({ error: "Service non configuré" }, { status: 503 });
  }

  const provided = req.headers.get("x-cron-key");
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  try {
    const report = await sweepPendingSales();
    if (report.stillPending > 0) {
      console.warn(`[api/cron/repair-sales] ${report.stillPending} vente(s) toujours en attente`, report.failures);
    }
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    console.error("[api/cron/repair-sales] erreur inattendue", e);
    return NextResponse.json({ ok: false, error: "Erreur interne" }, { status: 500 });
  }
}
