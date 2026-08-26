// =============================================================================
// VERROU DE LIGNE SUR LA VENTE — la sérialisation de la correction de moyen de paiement
// =============================================================================
// POURQUOI CE FICHIER EXISTE
// `insertCorrectionPayments` (lib/caisse.ts) fait un `count(settleRef)` puis deux `create`.
// `SalePayment` n'a AUCUNE contrainte d'unicité sur `settleRef` (contrairement à
// `CashMovement.ref`, et contrairement au `Payment` de Core-Compta qui a l'index unique
// `(invoiceId, ref)`) — on ne peut pas en ajouter une ici, ce serait une migration. En
// READ COMMITTED, deux transactions simultanées lisent le même `count = 0` et écrivent
// CHACUNE son couple : le ticket porte alors DEUX fois la correction, et le Z de caisse
// affiche un écart fantôme. Le `count` seul ne ferme pas la course — il lit un instantané
// qui devient périmé dès que l'autre transaction écrit ; seule la base peut arbitrer.
//
// Ce que ferme le verrou : la LECTURE elle-même. `SELECT … FOR UPDATE` sur la ligne
// `Sale` fait attendre la seconde transaction jusqu'au COMMIT de la première — elle
// relit donc un `count` à jour (déjà à 2) au lieu d'un instantané périmé (encore à 0).
// C'est la seule façon de sérialiser un chemin qui n'a pas de clé d'unicité à offrir à
// la base — même raisonnement que `lib/invoice-lock.ts` (Core-Compta), copié ici pour
// la ligne `Sale`.
//
// LE VERROU EST PRIS SUR "Sale", PAS SUR "SalePayment" : la ligne à verrouiller doit
// exister AVANT la course. Les `SalePayment` concurrents, eux, n'existent pas encore —
// il n'y a rien à y verrouiller.
//
// Prisma n'expose aucune API pour `FOR UPDATE` → `$queryRaw`. Ce fichier est le SEUL
// endroit qui connaît ce SQL.
//
// ⚠️ IL DOIT ÊTRE APPELÉ DANS `withTenant`. Sous `FORCE ROW LEVEL SECURITY`, hors
// contexte tenant la policy `tenant_isolation` ne laisse voir AUCUNE ligne : le verrou
// ne porterait sur rien et la fonction rendrait « introuvable » sur une vente existante.
// Le filtre `"tenantId" = $2` est en plus de la RLS, pas à sa place.
//
// 🛑 CE VERROU NE DOIT JAMAIS ÊTRE TENU PENDANT L'APPEL RÉSEAU À CORE-COMPTA.
// `runPaymentCorrection` (lib/payment-correction.ts) appelle la comptabilité AVANT
// d'appeler `insertCorrectionPayments` — c'est CETTE transaction d'écriture, et elle
// seule, qui prend le verrou. Un verrou tenu pendant un aller-retour réseau bloquerait
// toute autre opération sur le ticket (et finirait par épuiser le pool) pour la durée
// d'un appel HTTP, ce qui serait pire que le défaut qu'on corrige.
// =============================================================================

import type { Prisma } from "@prisma/client";

/**
 * Plafond d'attente sur le verrou. Une caisse qui attend indéfiniment est PIRE qu'une
 * caisse qui refuse : la connexion reste prise, le pool s'épuise, et c'est tout le
 * moteur qui tombe — pas seulement ce ticket.
 * 3 s est choisi SOUS le timeout par défaut d'une transaction interactive Prisma (5 s) :
 * sans ça, le vrai plafond serait celui de Prisma et l'erreur rendue serait un `P2028`
 * illisible au lieu d'un message actionnable.
 * Le verrou n'est tenu que le temps du `count` + des deux `create`, sans aucun appel
 * réseau : en régime normal l'attente se compte en millisecondes.
 */
export const SALE_LOCK_TIMEOUT = "3s";

/** UUID strict. Dupliqué (et non importé de lib/tenant.ts) pour que ce module ne tire
 *  pas `next/headers` : il doit rester appelable hors contexte requête. */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Erreur d'ATTENTE (pas de panne) : une autre correction est déjà en cours sur ce ticket. */
export class SaleLockTimeoutError extends Error {
  constructor() {
    super("Une correction est déjà en cours sur ce ticket. Réessayez dans un instant.");
    this.name = "SaleLockTimeoutError";
  }
}

/** `lock_timeout` dépassé — Prisma emballe l'erreur Postgres dans `meta.code`. */
function isLockTimeout(err: unknown): boolean {
  const meta = (err as { meta?: { code?: unknown } })?.meta;
  if (meta && meta.code === "55P03") return true;
  return /lock timeout/i.test(String((err as { message?: unknown })?.message ?? ""));
}

/**
 * Verrouille la ligne `Sale` pour la durée de la transaction courante.
 * @returns `true` si la vente existe (et appartient au tenant), `false` sinon —
 *          le `false` doit être traité EXACTEMENT comme « vente introuvable » par
 *          l'appelant, c'est le même cas qu'un `findFirst` vide.
 * @throws  {SaleLockTimeoutError} si une autre transaction la tient trop longtemps.
 */
export async function lockSaleRow(
  tx: Prisma.TransactionClient,
  saleId: string,
  tenantId: string,
): Promise<boolean> {
  // Un id non-UUID ferait lever 22P02 au cast `::uuid` — donc un 500 là où le code
  // rendait 404. On rend « introuvable », ce qui est la vérité.
  if (!UUID_RE.test(saleId) || !UUID_RE.test(tenantId)) return false;

  try {
    // SET LOCAL, mais PARAMÉTRÉ (même geste que app.current_tenant) : `SET` n'accepte
    // pas de paramètre de requête, `set_config(…, true)` si.
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${SALE_LOCK_TIMEOUT}, true)`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Sale"
       WHERE id = ${saleId}::uuid AND "tenantId" = ${tenantId}::uuid
       FOR UPDATE`;
    return rows.length > 0;
  } catch (err) {
    if (isLockTimeout(err)) throw new SaleLockTimeoutError();
    throw err;
  }
}
