// Détail facultatif d'un paiement par chèque (n° + banque) — demande V-Cut 20/11. MÊMES règles que
// 01-Core-Compta core/lib/cheque-detail.ts (qui le renormalise à la réception du settle).
// Module pur : ne bloque JAMAIS un paiement. Valeur absente, vide, non-chaîne → null ;
// trop longue → tronquée. Hors méthode CHEQUE → toujours null/null.

export const CHEQUE_NUMERO_MAX = 40;
export const CHEQUE_BANQUE_MAX = 80;

function normaliser(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/ {2,}/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

export function detailCheque(
  method: string | null | undefined,
  numero: unknown,
  banque: unknown,
): { chequeNumber: string | null; chequeBank: string | null } {
  if ((method ?? "").trim().toUpperCase() !== "CHEQUE") return { chequeNumber: null, chequeBank: null };
  return { chequeNumber: normaliser(numero, CHEQUE_NUMERO_MAX), chequeBank: normaliser(banque, CHEQUE_BANQUE_MAX) };
}
