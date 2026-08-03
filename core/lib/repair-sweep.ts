// lib/repair-sweep.ts — BALAYAGE de reprise des ventes en attente de synchro (cron).
//
// MULTI-TENANT / RLS : le balayage est cross-tenant (il liste les ventes PAID non convergées de TOUS
// les tenants). Il lit donc Sale SANS withTenant — pattern identique au cron de Core-RDV
// (lib/reminders.ts) : un client Prisma DÉDIÉ sur `CRON_DATABASE_URL`. ⚠️ Depuis FORCE ROW LEVEL
// SECURITY (2026-07, prisma/manual/2026-07_securite_rls.sql), un rôle owner « nu » NE bypasse PLUS
// la RLS : le rôle de CRON_DATABASE_URL doit être BYPASSRLS, sinon ce balayage voit 0 vente EN
// SILENCE et la reprise meurt. En dev (RLS non forcée ou rôle unique) fallback sur `DATABASE_URL`.
// Le listing ne lit que (id, tenantId) ; CHAQUE réparation repasse ensuite par repairSale → withTenant
// (rôle applicatif, RLS active) : le client élargi ne sert qu'à découvrir le travail, jamais à écrire.

//
// ─── ANTI-FAMINE (2026-08-03, tâche t-20260803T2030-caissesweep) ─────────────────────────────────
// La RÈGLE de sélection (qui reprendre, dans quel ordre, à quelle cadence) vit dans lib/repair-policy.ts
// — pure et testée sans base. Ce module n'en est que l'EXÉCUTANT. Résumé : le tri `syncAttempts asc`
// empêche les ventes insolubles de confisquer la fenêtre de 200, et un backoff borne le martèlement
// des cores. Aucune vente n'est jamais abandonnée ; les enlisées sont COMPTÉES (`stuck`) et remontées
// au watchdog. Le sort COMPTABLE d'une vente qui ne convergera jamais reste un arbitrage de Marco.

import { PrismaClient } from "@prisma/client";
import { repairSale } from "./caisse";
import { log } from "./log";
import {
  PENDING_SALES_ORDER,
  backoffAfterAttempts,
  backoffMinutes,
  pendingSalesWhere,
  stuckSalesWhere,
} from "./repair-policy";

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
  /** Ventes en attente ayant dépassé le seuil de tentatives — CANDIDATES À ARBITRAGE (cf. en-tête). */
  stuck: number;
};

/**
 * Rejoue la synchro des ventes PAID non convergées : les MOINS retentées d'abord, puis les plus
 * anciennes. Idempotent : chaque reprise ne rejoue que les étapes manquantes, et toutes les cibles
 * dédupliquent. `limit` borne un passage (défaut 200) — le passage suivant reprend le reste.
 */
export async function sweepPendingSales(limit = 200): Promise<RepairSweepReport> {
  const pending = await cronPrisma.sale.findMany({
    where: pendingSalesWhere(),
    select: { id: true, tenantId: true },
    orderBy: PENDING_SALES_ORDER,
    take: limit,
  });

  // Comptage SÉPARÉ des ventes qui s'enlisent (indépendant de la fenêtre et du backoff) : sans ça,
  // une vente insoluble redevient invisible dès qu'elle est écartée de la fenêtre — on remplacerait
  // une famine bruyante par un enlisement silencieux.
  const stuck = await cronPrisma.sale.count({ where: stuckSalesWhere() });

  const report: RepairSweepReport = { scanned: pending.length, repaired: 0, stillPending: 0, failures: [], stuck };

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
      // Socle observabilité : erreur inattendue du balayage de reprise → watchdog.
      log.error("caisse.repairSweep", e, { saleId: s.id, tenantId: s.tenantId });
      console.error(`[caisse] repair-sweep erreur inattendue sale=${s.id} tenant=${s.tenantId}:`, e);
    }
  }

  // Une vente encaissée qui ne converge plus est un ÉCART D'INVENTAIRE en puissance : elle doit
  // remonter au watchdog, pas pourrir en silence. (Le sort à lui réserver est un arbitrage Marco.)
  if (stuck > 0) {
    log.error("caisse.repairStuck", new Error(`${stuck} vente(s) PAID non convergées au-delà de ${backoffAfterAttempts()} tentatives`), {
      stuck,
      thresholdAttempts: backoffAfterAttempts(),
      backoffMinutes: backoffMinutes(),
    });
  }

  return report;
}
