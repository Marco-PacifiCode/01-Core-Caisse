import type { NextRequest } from "next/server";
import { cleHistoriqueAcceptee, egalTempsConstant, entrerAppel, identifierCle } from "./cles-service.ts";

/** Authentification S2S nominative ou historique par en-tête X-Core-Key. */
export function hasServiceKey(req: NextRequest): boolean {
  const apiKey = req.headers.get("x-core-key");
  if (!apiKey) return false;
  const appelant = identifierCle(apiKey);
  if (appelant) {
    entrerAppel(req, appelant, apiKey);
    return true;
  }
  const attendue = process.env.CORE_CAISSE_API_KEY;
  if (!attendue || !egalTempsConstant(apiKey, attendue) || !cleHistoriqueAcceptee()) return false;
  entrerAppel(req, null, apiKey);
  return true;
}
