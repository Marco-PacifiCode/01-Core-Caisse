import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { withTenant } from "@/lib/tenant";
import { createSale, type SaleLineInput } from "@/lib/caisse";
import { xpf } from "@/lib/serialize";
import type { LineKind } from "@prisma/client";

const VALID_KINDS: LineKind[] = ["SERVICE", "PRODUCT", "OTHER"];

/**
 * POST /api/sales
 * Crée un TICKET (statut DRAFT) — service-to-service (X-Core-Key). Sert à ouvrir une vente depuis
 * une source externe (ex : RDV honoré) ou un poste de caisse distant. Idempotent sur
 * (sourceType, sourceId) quand fournis.
 *
 * Body : { tenantId, cashierId?, sessionId?, clientName?, sourceType?, sourceId?,
 *          posteId?, occurredAt?,
 *          lines: { kind, label, productId?, qty, unitXpf, tgcRatePpm? }[] }
 *   unitXpf : XPF entier (number).  productId : requis si kind=PRODUCT.
 *   posteId : caisse physique émettrice. Omis = marchand mono-caisse.
 *   occurredAt : date ISO de la vente RÉELLE, pour une remontée différée
 *     (caisse hors ligne). Omis = maintenant. Une date future donne 400
 *     FUTURE_DATE — elle ne peut venir que d'une tablette mal réglée.
 *   tgcRatePpm (par ligne) : taux de TGC, entier ppm dans [0, 1000000], optionnel.
 *     Omis = comportement inchangé (traverse jusqu'à Compta, jamais recalculé ici).
 *
 * Réponse 200 : { ok, saleId, totalXpf, alreadyExisted }
 */
export async function POST(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    tenantId?: string;
    cashierId?: string;
    sessionId?: string;
    clientName?: string;
    sourceType?: string;
    sourceId?: string;
    posteId?: string;
    occurredAt?: string;
    lines?: { kind?: string; label?: string; productId?: string; qty?: number; unitXpf?: number; tgcRatePpm?: number }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, lines } = body;
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });
  if (!lines || lines.length === 0) return NextResponse.json({ error: "lines ne peut pas être vide" }, { status: 400 });

  const parsed: SaleLineInput[] = [];
  for (const l of lines) {
    if (!l.kind || !VALID_KINDS.includes(l.kind as LineKind)) {
      return NextResponse.json({ error: `kind invalide (attendu: ${VALID_KINDS.join(", ")})` }, { status: 400 });
    }
    if (!l.label) return NextResponse.json({ error: "label requis sur chaque ligne" }, { status: 400 });
    if (l.qty === undefined || l.unitXpf === undefined) {
      return NextResponse.json({ error: "qty et unitXpf requis sur chaque ligne" }, { status: 400 });
    }
    // tgcRatePpm : optionnel, entier XPF-ppm dans [0, 1_000_000]. Absent = comportement inchangé
    // (transmis undefined, jamais 0 — cf. lib/sync.ts).
    if (l.tgcRatePpm !== undefined) {
      if (!Number.isInteger(l.tgcRatePpm) || l.tgcRatePpm < 0 || l.tgcRatePpm > 1_000_000) {
        return NextResponse.json({ error: "lines[].tgcRatePpm : entier entre 0 et 1000000" }, { status: 400 });
      }
    }
    parsed.push({
      kind: l.kind as LineKind,
      label: l.label,
      productId: l.productId ?? null,
      qty: l.qty,
      unitXpf: BigInt(Math.round(l.unitXpf)),
      tgcRatePpm: l.tgcRatePpm ?? null,
    });
  }

  // Date fournie : on refuse ce qui n'est pas une date lisible plutôt que de
  // laisser passer un `Invalid Date` qui deviendrait silencieusement « maintenant ».
  let occurredAt: Date | null = null;
  if (body.occurredAt) {
    const d = new Date(body.occurredAt);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "occurredAt : date ISO invalide" }, { status: 400 });
    }
    occurredAt = d;
  }

  const result = await createSale(tenantId, {
    cashierId: body.cashierId,
    sessionId: body.sessionId ?? null,
    clientName: body.clientName ?? null,
    sourceType: body.sourceType ?? null,
    sourceId: body.sourceId ?? null,
    posteId: body.posteId?.trim() || null,
    occurredAt,
    lines: parsed,
  });

  if (!result.ok) {
    const status = result.error === "PRODUCT_LINE_WITHOUT_PRODUCT" || result.error === "INVALID_QTY" ? 400 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}

/**
 * GET /api/sales?tenantId=...&status=...&sessionId=...&from=ISO&to=ISO&limit=...
 *              [&sourceType=rdv&sourceId=<uuid>]
 * Historique des tickets d'un tenant (S2S, X-Core-Key).
 *
 * ── `sourceType` / `sourceId` : répondre « ce ticket existe-t-il ? » ────────────────
 * Ajoutés le 2026-08-31. Une vente créée depuis un rendez-vous porte
 * `(sourceType, sourceId) = ("rdv", appointmentId)` — c'est sa clé d'idempotence, celle
 * de l'index unique `uniq_sale_external_source`.
 *
 * Une surface qui veut savoir si un rendez-vous a déjà son ticket n'avait, sans ce
 * filtre, qu'un seul moyen : tirer les 500 dernières ventes et chercher dedans. C'est
 * cher pour une question booléenne, et surtout **c'est faux** — une vente plus ancienne
 * que la fenêtre passe à travers, et on conclut « pas de ticket » sur un rendez-vous
 * déjà encaissé. Or `createSale` rend la vente EXISTANTE sans mettre ses lignes à jour :
 * une réponse fausse ici fait encaisser un panier périmé. C'est de l'argent, donc on ne
 * répond pas de façon probabiliste.
 *
 * Les deux paramètres n'ont d'effet qu'ENSEMBLE (un `sourceType` seul filtrerait toute
 * une famille de ventes, ce que personne ne demande aujourd'hui). Absents, la réponse est
 * STRICTEMENT celle d'avant : aucun appelant existant ne change de comportement.
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const tenantId = searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const status = searchParams.get("status");
  const sessionId = searchParams.get("sessionId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Math.min(Number(searchParams.get("limit")) || 100, 500);
  // Les deux ensemble, ou rien : cf. le bloc de doc ci-dessus.
  const sourceType = searchParams.get("sourceType");
  const sourceId = searchParams.get("sourceId");
  const sourceFilter = sourceType && sourceId ? { sourceType, sourceId } : {};

  const sales = await withTenant(tenantId, (tx) =>
    tx.sale.findMany({
      where: {
        tenantId,
        ...(status ? { status: status as never } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...sourceFilter,
        ...(from || to
          ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
          : {}),
      },
      include: { payments: { select: { method: true, amountXpf: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  );

  return NextResponse.json({
    sales: sales.map((s) => ({
      id: s.id,
      status: s.status,
      sessionId: s.sessionId,
      clientName: s.clientName,
      totalXpf: xpf(s.totalXpf),
      invoiceId: s.invoiceId,
      invoiceNumber: s.invoiceNumber,
      sourceType: s.sourceType,
      sourceId: s.sourceId,
      paidXpf: xpf(s.payments.reduce((t, p) => t + p.amountXpf, 0n)),
      // VENTILATION PAR MOYEN DE PAIEMENT — ajoutée le 2026-08-10 (demande Marco).
      //
      // Les paiements étaient DÉJÀ chargés par l'`include` ci-dessus, et leur `method`
      // était lu puis JETÉ : seule leur somme (`paidXpf`) sortait. Un journal de caisse
      // ne pouvait donc pas dire « combien en espèces, combien en carte » — et la seule
      // façon de le savoir était une requête SQL à la main sur le serveur.
      //
      // Cet ajout est PUREMENT ADDITIF : aucune requête de plus (pas de N+1), aucun
      // champ existant modifié, aucun appelant cassé. Une surface qui ignore `payments`
      // continue de marcher à l'identique.
      //
      // ⚠️ Une vente peut porter PLUSIEURS paiements (paiement mixte : une part carte,
      // une part espèces). On rend donc la LISTE, pas un moyen unique — réduire à « le »
      // moyen de paiement obligerait à en choisir un arbitrairement et ferait mentir le
      // total. C'est à l'appelant d'agréger.
      // ⚠️ `xpf()` est OBLIGATOIRE sur `amountXpf` : un BigInt laissé brut fait LEVER
      // `NextResponse.json` (« Do not know how to serialize a BigInt ») et la route rend
      // 500 — le journal de caisse deviendrait vide, sans message.
      payments: s.payments.map((p) => ({ method: p.method, amountXpf: xpf(p.amountXpf) })),
      createdAt: s.createdAt,
      paidAt: s.paidAt,
    })),
  });
}
