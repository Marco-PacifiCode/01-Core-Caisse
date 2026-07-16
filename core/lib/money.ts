// lib/money.ts — helpers monétaires PURS (XPF BigInt), sans dépendance Prisma/DB.
// Isolés ici pour être testables sans charger le client Prisma (cf. lib/caisse.test.ts).

export type PayMethodLike = "CASH" | "CARD" | "TRANSFER" | "CHEQUE" | "OTHER";

export type PaymentLike = {
  method: PayMethodLike;
  amountXpf: bigint; // montant imputé à la vente
  tenderedXpf?: bigint; // remis par le client (espèces) → sert au rendu monnaie
};

/**
 * Rendu monnaie : Σ(tendered) - Σ(amount imputé), borné à ≥ 0.
 * tendered absent = pas de sur-remise (on prend amount). Seule l'espèce remise en trop est rendue.
 */
export function computeChange(payments: PaymentLike[]): bigint {
  let tendered = 0n;
  let amount = 0n;
  for (const p of payments) {
    amount += p.amountXpf;
    tendered += p.tenderedXpf ?? p.amountXpf;
  }
  const change = tendered - amount;
  return change > 0n ? change : 0n;
}

/** Méthodes sur lesquelles on peut RENDRE la monnaie. Sur une carte, rien ne se rend. */
const CHANGE_METHODS: ReadonlySet<PayMethodLike> = new Set<PayMethodLike>(["CASH"]);

export type NormalizeResult =
  | { ok: true; payments: PaymentLike[]; changeXpf: bigint }
  | { ok: false; error: "OVERPAID"; method: PayMethodLike; excessXpf: bigint };

/**
 * « J'encaisse, puis je rends » — le geste UNIVERSEL du comptoir, porté ICI (moteur) et
 * pas dans chaque surface marchande : tout marchand le fera, et chacun se tromperait
 * pareil (bug vécu V'Cut 2026-07-16).
 *
 * Le piège : l'appelant déclare `amountXpf` (imputé) ET `tenderedXpf` (remis). Rien
 * n'empêchait `amountXpf` > total → la vente était SOLDÉE en trop en Compta (constaté :
 * FAC-2026-0002/0003, paidXpf 3000 pour totalXpf 2500) et le trop-perçu comptabilisé en
 * recette au lieu d'être rendu.
 *
 * Ici on ne fait plus confiance à l'imputation de l'appelant : on prend ce qu'il déclare
 * avoir REÇU (`max(amountXpf, tenderedXpf)`) et on IMPUTE nous-mêmes `min(reçu, dû)`.
 * L'excédent devient du rendu — mais seulement sur les méthodes qui le permettent :
 * un excédent en carte/virement/chèque est une SAISIE FAUSSE (rien à rendre), donc refusé.
 *
 * Idempotent et sûr pour les appelants corrects : `{amount:2500, tendered:3000}` sur un
 * ticket à 2500 ressort inchangé (imputé 2500, rendu 500).
 */
export function normalizePayments(totalXpf: bigint, payments: PaymentLike[]): NormalizeResult {
  const out: PaymentLike[] = [];
  let applied = 0n;
  let change = 0n;

  for (const p of payments) {
    const amount = p.amountXpf > 0n ? p.amountXpf : 0n;
    const tendered = p.tenderedXpf && p.tenderedXpf > 0n ? p.tenderedXpf : 0n;
    // Ce que le client a réellement remis dans cette méthode.
    const received = amount > tendered ? amount : tendered;
    const due = totalXpf - applied > 0n ? totalXpf - applied : 0n;
    const take = received < due ? received : due; // imputé = min(reçu, dû)

    if (received > take && !CHANGE_METHODS.has(p.method)) {
      return { ok: false, error: "OVERPAID", method: p.method, excessXpf: received - take };
    }

    applied += take;
    change += received - take;
    out.push({
      method: p.method,
      amountXpf: take,
      // On garde la trace du remis (utile au reçu) uniquement s'il diffère de l'imputé.
      tenderedXpf: received > take ? received : undefined,
    });
  }

  return { ok: true, payments: out, changeXpf: change };
}

/** Total d'une ligne = prix unitaire × quantité (quantité entière). */
export function lineTotalXpf(unitXpf: bigint, qty: number): bigint {
  return unitXpf * BigInt(Math.trunc(qty));
}
