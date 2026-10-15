/**
 * Le montant de récompense est un bigint en base (XPF) : JSON.stringify ne sait pas l'écrire et
 * GET/PUT /api/loyalty/program partaient en 500 (PC-0212). Les surfaces attendent `number | null`.
 */
export function serializeProgram<T extends object>(program: T): T | (Omit<T, "rewardAmountXpf"> & { rewardAmountXpf: number | null }) {
  if (!("rewardAmountXpf" in program)) return program;
  const amount = (program as { rewardAmountXpf: bigint | number | null }).rewardAmountXpf;
  return { ...program, rewardAmountXpf: amount === null ? null : Number(amount) };
}
