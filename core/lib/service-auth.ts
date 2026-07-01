import { NextRequest } from "next/server";

/**
 * Authentification service-to-service : header X-Core-Key == CORE_CAISSE_API_KEY.
 * Renvoie true si la clé est valide. Même contrat que Core-Compta (COMPTA_API_KEY)
 * et Core-Stock (CORE_STOCK_API_KEY).
 */
export function hasServiceKey(req: NextRequest): boolean {
  const apiKey = req.headers.get("x-core-key");
  return !!apiKey && apiKey === process.env.CORE_CAISSE_API_KEY;
}
