// lib/repair-sweep.ts — BALAYAGE de reprise des ventes en attente de synchro (cron).
//
// MULTI-TENANT / RLS : le balayage est cross-tenant (il liste les ventes PAID non convergées de TOUS
// les tenants). Il lit donc Sale SANS withTenant — pattern identique au cron de Core-RDV
// (lib/reminders.ts) : un client Prisma DÉDIÉ sur `CRON_DATABASE_URL` (rôle PROPRIÉTAIRE → bypass RLS,
// tables non FORCE) ; en dev (rôle mono/owner) fallback sur `DATABASE_URL`.
// Le listing ne lit que (id, tenantId) ; CHAQUE réparation repasse ensuite par repairSale → withTenant
// (rôle applicatif, RLS active) : le client élargi ne sert qu'à découvrir le travail, jamais à écrire.

import { PrismaClient } from "@prisma/client";
import { repairSale } from "./caisse";

const cronDbUrl = process.env.CRON_DATABASE_URL ?? process.env.DATABASE_URL;
const globalForCron = globalThis as unknown as { cronPrisma?: PrismaClient };
const cronPrisma =
  globalForCron.cronPrisma ??
  new PrismaClient({
    log: ["error"],
    datasources: cronDbUrl ? { db: { url: cronDbUrl } } : undefined,
  });
if (process.env.NODE_ENV !== "production") globalForCron.cronPrisma = cronPrisma;

export type RepairSweepReport = {
  scanned: number; // ventes en attente trouvées (bornées à `take`)
  repaired: number; // convergées pendant ce passage
  stillPending: number; // toujours en échec après ce passage
  failures: { saleId: string; tenantId: string; error: string }[]; // détail des échecs (bornés)
};

/**
 * Rejoue la synchro de TOUTES les ventes PAID non convergées (les plus anciennes d'abord).
 * Idempotent : chaque reprise ne rejoue que les étapes manquantes, et toutes les cibles dédupliquent.
 * `limit` borne un passage (défaut 200) — le passage suivant reprend le reste.
 */
export async function sweepPendingSales(limit = 200): Promise<RepairSweepReport> {
  const pending = await cronPrisma.sale.findMany({
    where: { status: "PAID", OR: [{ comptaSyncedAt: null }, { stockSyncedAt: null }] },
    select: { id: true, tenantId: true },
    orderBy: { paidAt: "asc" },
    take: limit,
  });

  const report: RepairSweepReport = { scanned: pending.length, repaired: 0, stillPending: 0, failures: [] };

  for (const s of pending) {
    try {
      const res = await repairSale(s.tenantId, s.id);
      if (res.ok && res.synced) {
        report.repaired++;
      } else {
        report.stillPending++;
        const err = res.ok ? res.syncError ?? "échec de synchro" : res.error;
        if (report.failures.length < 20) report.failures.push({ saleId: s.id, tenantId: s.tenantId, error: err });
      }
    } catch (e) {
      // Erreur inattendue sur UNE vente → ne bloque pas le reste du passage.
      report.stillPending++;
      const msg = e instanceof Error ? e.message : String(e);
      if (report.failures.length < 20) report.failures.push({ saleId: s.id, tenantId: s.tenantId, error: msg });
      console.error(`[caisse] repair-sweep erreur inattendue sale=${s.id} tenant=${s.tenantId}:`, e);
    }
  }

  return report;
}
