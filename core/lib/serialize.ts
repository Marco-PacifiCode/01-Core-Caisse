// Sérialisation des montants XPF (BigInt) pour les réponses JSON.
// Les montants XPF sont des entiers ; ils tiennent largement dans un Number JS
// (Number.MAX_SAFE_INTEGER ≈ 9.0e15 XPF). On expose donc des `number` côté API.

/** Convertit un BigInt|null en number|null pour une réponse JSON. */
export function xpf(v: bigint | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}
