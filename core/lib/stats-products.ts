// Statistiques « produits les plus vendus » par mois — LECTURE seule (GET /api/stats/products).
//
// Source : SaleLine (kind PRODUCT) jointe à Sale PAID, datée par Sale.paidAt, mois en heure de
// Nouméa (Pacific/Noumea, UTC+11 fixe ; paidAt est un timestamp SANS fuseau stocké en UTC, d'où le double AT TIME ZONE, pas d'heure d'été — même convention que le « jour de
// caisse » : `new Date(Date.now() + 11 * 3600000)` dans caisse.ts).
//
// ── REMBOURSEMENTS ───────────────────────────────────────────────────────────────────────
//  · Vente totalement remboursée (`Sale.fullyRefundedAt` non nul) : EXCLUE.
//  · Remboursement partiel : la structure est fiable. `PartialRefund.plan.lines[]` =
//    { lineId, qty, ttcXpf, tgcRatePpm }, écrit par `planPartialRefund` (lib/partial-refund.ts)
//    avec lineId = SaleLine.id. On déduit donc, par ligne, la qty et le ttcXpf des
//    remboursements au statut DONE (avoir émis et finalisé). Un PENDING (réservé, avoir pas
//    encore confirmé) n'est PAS déduit. La déduction est imputée au mois de la vente d'origine
//    (paidAt), pas au mois du remboursement.
//  · Limite connue : `ttcXpf` est le montant NET de la répartition des remises (lignes
//    négatives de la vente) ; `SaleLine.lineXpf` est brut. Sur une vente avec remise, le montant
//    déduit peut donc être légèrement inférieur au brut de la ligne. Sans remise, c'est exact.
//
// Aucune migration. Index qui serait utile (non créé) : Sale (tenantId, paidAt) WHERE status='PAID'.

import type { Prisma } from "@prisma/client";

export const NOUMEA_OFFSET_MS = 11 * 3600000;
export const MAX_PERIOD_MONTHS = 13;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDay(s: string | null): Date | null {
  const m = s ? DAY_RE.exec(s) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s ? d : null;
}

export type Period = { from: string; to: string; startUtc: Date; endUtc: Date };
export type PeriodError = { error: string };

/** from/to = jours Nouméa inclus. startUtc inclus, endUtc exclus (minuit Nouméa du lendemain de `to`). */
export function parsePeriod(from: string | null, to: string | null): Period | PeriodError {
  if (!from || !to) return { error: "from et to requis (YYYY-MM-DD)" };
  const f = parseDay(from), t = parseDay(to);
  if (!f || !t) return { error: "from et to : date YYYY-MM-DD valide attendue" };
  if (t < f) return { error: "to doit être postérieur ou égal à from" };
  const endDay = new Date(t.getTime() + 86400000);
  const limit = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + MAX_PERIOD_MONTHS, f.getUTCDate()));
  if (endDay > limit) return { error: `période limitée à ${MAX_PERIOD_MONTHS} mois` };
  return { from, to, startUtc: new Date(f.getTime() - NOUMEA_OFFSET_MS), endUtc: new Date(endDay.getTime() - NOUMEA_OFFSET_MS) };
}

export type ProductMonthRow = { month: string; productId: string; label: string; qty: number; amountXpf: bigint };
export type ProductTotalRow = { productId: string; label: string; qty: number; amountXpf: bigint };

type RawRow = { month: string; productId: string; label: string; qty: bigint; amountXpf: bigint };

/** Agrégation SQL paramétrée, sous RLS (appeler dans withTenant). Tri : mois, qty décroissante. */
export async function topProductsByMonth(tx: Prisma.TransactionClient, tenantId: string, startUtc: Date, endUtc: Date): Promise<ProductMonthRow[]> {
  const rows = await tx.$queryRaw<RawRow[]>`
    WITH refunded AS (
      SELECT (e->>'lineId')::uuid AS "lineId",
             SUM((e->>'qty')::bigint) AS qty,
             SUM((e->>'ttcXpf')::bigint) AS xpf
      FROM "PartialRefund" pr
      JOIN "Sale" s ON s.id = pr."saleId" AND s."tenantId" = pr."tenantId"
      CROSS JOIN LATERAL jsonb_array_elements(pr.plan->'lines') e
      WHERE pr."tenantId" = ${tenantId}::uuid AND pr.status = 'DONE'
        AND s.status = 'PAID' AND s."fullyRefundedAt" IS NULL
        AND s."paidAt" >= ${startUtc} AND s."paidAt" < ${endUtc}
      GROUP BY 1
    ), net AS (
      SELECT to_char((s."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Pacific/Noumea', 'YYYY-MM') AS month,
             l."productId",
             l.qty - COALESCE(r.qty, 0) AS qty,
             l."lineXpf" - COALESCE(r.xpf, 0) AS xpf
      FROM "SaleLine" l
      JOIN "Sale" s ON s.id = l."saleId" AND s."tenantId" = l."tenantId"
      LEFT JOIN refunded r ON r."lineId" = l.id
      WHERE l."tenantId" = ${tenantId}::uuid AND s.status = 'PAID' AND l.kind = 'PRODUCT'
        AND l."productId" IS NOT NULL AND s."fullyRefundedAt" IS NULL
        AND s."paidAt" >= ${startUtc} AND s."paidAt" < ${endUtc}
    ), agg AS (
      SELECT month, "productId", SUM(qty)::bigint AS qty, SUM(xpf)::bigint AS "amountXpf"
      FROM net GROUP BY month, "productId"
    )
    SELECT a.month, a."productId"::text AS "productId", COALESCE(lab.label, '') AS label, a.qty, a."amountXpf"
    FROM agg a
    LEFT JOIN LATERAL (
      SELECT l2.label FROM "SaleLine" l2
      JOIN "Sale" s2 ON s2.id = l2."saleId" AND s2."tenantId" = l2."tenantId"
      WHERE l2."tenantId" = ${tenantId}::uuid AND l2."productId" = a."productId" AND l2.kind = 'PRODUCT'
        AND s2.status = 'PAID' AND s2."fullyRefundedAt" IS NULL
      ORDER BY s2."paidAt" DESC, l2."createdAt" DESC, l2.id DESC LIMIT 1
    ) lab ON true
    WHERE a.qty > 0
    ORDER BY a.month, a.qty DESC, a."amountXpf" DESC, a."productId"`;
  return rows.map(r => ({ month: r.month, productId: r.productId, label: r.label, qty: Number(r.qty), amountXpf: r.amountXpf }));
}

/** Total par produit sur toute la période (qty décroissante). */
export function totalsByProduct(rows: ProductMonthRow[]): ProductTotalRow[] {
  const m = new Map<string, ProductTotalRow>();
  for (const r of rows) {
    const t = m.get(r.productId);
    if (t) { t.qty += r.qty; t.amountXpf += r.amountXpf; }
    else m.set(r.productId, { productId: r.productId, label: r.label, qty: r.qty, amountXpf: r.amountXpf });
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty || (a.amountXpf < b.amountXpf ? 1 : a.amountXpf > b.amountXpf ? -1 : 0) || a.productId.localeCompare(b.productId));
}
