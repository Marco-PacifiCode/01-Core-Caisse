// Quota de la brique Caisse (nombre de POSTES) — partie PURE + lecture des droits dans Core-Auth.
//
// Les droits (plafond) vivent dans Core-Auth, pas ici : `GET /api/s2s/tenants/{id}/droits`.
// Ce fichier n'importe RIEN (ni Prisma, ni `./log`) pour rester testable par `node --test`.
//
// RÈGLE D'OUVERTURE — à ne jamais inverser : ligne absente, plafond null, Core-Auth
// injoignable, délai dépassé, réponse invalide, clé non provisionnée → PAS de verrou.
// Une panne de Core-Auth ne doit jamais empêcher un marchand d'ouvrir sa caisse.
//
// Et quoi qu'il arrive : AUCUN quota ne touche une vente (`createSale`), ni l'import d'une
// session faite hors ligne. Le verrou ne porte que sur l'ENREGISTREMENT d'un nouveau poste,
// au moment où il ouvre une session EN LIGNE.

export type DroitQuota = { niveau: number | null; plafond: number | null; quoi: string | null };

export type QuotaAtteint = {
  code: "quota_atteint";
  error: string;
  cle: string;
  plafond: number;
  utilise: number;
  quoi: string;
  message: string;
};

export type DecisionInscription = { action: "rien" } | { action: "inscrire"; horsQuota: boolean } | { action: "refuser" };

/**
 * Que faire d'un poste qui ouvre une session en ligne ?
 * - déjà enregistré et actif → rien, même si le tenant est au-dessus de son plafond ;
 * - inconnu du registre mais AYANT DÉJÀ TRAVAILLÉ (sessions ou ventes à son nom) → c'est un poste
 *   existant, antérieur au registre ou venu du hors-ligne : on l'inscrit SANS contrôle, marqué
 *   hors quota s'il dépasse — un poste qui vendait hier doit pouvoir ouvrir aujourd'hui ;
 * - vraiment nouveau, ou désactivé puis rallumé → contrôle du plafond.
 */
export function decisionInscription(a: {
  poste: { actif: boolean } | null;
  aHistorique: boolean;
  plafond: number | null;
  actifs: number;
}): DecisionInscription {
  if (a.poste?.actif) return { action: "rien" };
  const plein = a.plafond !== null && a.actifs >= a.plafond;
  if (!a.poste && a.aHistorique) return { action: "inscrire", horsQuota: plein };
  return plein ? { action: "refuser" } : { action: "inscrire", horsQuota: false };
}

export function refusPostes(cle: string, plafond: number, utilise: number, quoi: string | null): QuotaAtteint {
  const couvre = plafond === 1 ? "1 poste de caisse" : `${plafond} postes de caisse`;
  const message = `Votre formule couvre ${couvre}. Pour en ajouter un, passez au niveau supérieur ou désactivez un poste.`;
  return { code: "quota_atteint", error: "quota_atteint", cle, plafond, utilise, quoi: quoi || "postes de caisse", message };
}

const DUREE_CACHE_MS = 60_000; // un plafond relevé s'applique en une minute
const DUREE_CACHE_PANNE_MS = 15_000; // pendant une panne, on ne paie pas 2 s d'attente à chaque création
const DELAI_MS = 2_000;

const cache = new Map<string, { expire: number; droit: DroitQuota | null }>();

/** Tests uniquement. */
export function viderCacheQuota(): void {
  cache.clear();
}

/** Extrait le droit `cle` d'une réponse Core-Auth ; lève si la réponse n'a pas la forme attendue. */
export function droitDepuisReponse(payload: unknown, tenantId: string, cle: string): DroitQuota | null {
  const p = payload as { tenantId?: unknown; droits?: unknown } | null;
  if (!p || typeof p !== "object" || p.tenantId !== tenantId || !Array.isArray(p.droits)) {
    throw new Error("Réponse Core-Auth invalide");
  }
  const ligne = p.droits.find((d) => d && typeof d === "object" && (d as { cle?: unknown }).cle === cle) as
    | { niveau?: unknown; plafond?: unknown; quoi?: unknown }
    | undefined;
  if (!ligne) return null;
  const { plafond, niveau, quoi } = ligne;
  if (plafond !== null && plafond !== undefined && (!Number.isSafeInteger(plafond) || (plafond as number) < 0)) {
    throw new Error("Plafond Core-Auth invalide");
  }
  // Une ligne à moitié lisible n'est pas appliquée : mieux vaut pas de verrou qu'un plafond douteux.
  if (!Number.isSafeInteger(niveau) || (niveau as number) < 1) throw new Error("Niveau Core-Auth invalide");
  return {
    niveau: niveau as number,
    plafond: typeof plafond === "number" ? plafond : null,
    quoi: typeof quoi === "string" && quoi ? quoi : null,
  };
}

/**
 * Droit du tenant pour une brique, ou null (= pas de plafond). Ne lève jamais.
 * `journal` reçoit l'erreur en cas d'échec (branché sur `log.error` par l'appelant).
 */
export async function lireDroit(
  tenantId: string,
  cle: string,
  opts: { journal?: (erreur: unknown) => void } = {},
): Promise<DroitQuota | null> {
  const k = `${tenantId}:${cle}`;
  const enCache = cache.get(k);
  if (enCache && enCache.expire > Date.now()) return enCache.droit;
  // Clé non provisionnée = verrou non branché sur cet environnement : silencieux, pas une anomalie.
  const cleService = process.env.CORE_AUTH_API_KEY;
  if (!cleService) return null;
  try {
    const base = process.env.CORE_AUTH_URL || "http://localhost:3102";
    const r = await fetch(`${base}/api/s2s/tenants/${encodeURIComponent(tenantId)}/droits`, {
      headers: { "X-Core-Key": cleService },
      cache: "no-store",
      signal: AbortSignal.timeout(DELAI_MS),
    });
    if (!r.ok) throw new Error(`Core-Auth HTTP ${r.status}`);
    const droit = droitDepuisReponse(await r.json(), tenantId, cle);
    cache.set(k, { expire: Date.now() + DUREE_CACHE_MS, droit });
    return droit;
  } catch (e) {
    try {
      opts.journal?.(e);
    } catch {
      // journaliser ne doit jamais transformer une ouverture en panne
    }
    cache.set(k, { expire: Date.now() + DUREE_CACHE_PANNE_MS, droit: null });
    return null;
  }
}
