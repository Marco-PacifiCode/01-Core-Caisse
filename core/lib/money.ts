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

/** Total d'une ligne = prix unitaire × quantité (quantité entière). */
export function lineTotalXpf(unitXpf: bigint, qty: number): bigint {
  return unitXpf * BigInt(Math.trunc(qty));
}
