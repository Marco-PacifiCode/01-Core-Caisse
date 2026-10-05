// Registre des postes de caisse + quota de la brique Caisse (nombre de postes).
//
// OÙ EST LE VERROU, ET OÙ IL N'EST PAS
// - Il est à l'ouverture d'une session EN LIGNE (`openSession`), pour un poste que le registre
//   ne connaît pas encore (ou connaît désactivé). C'est le seul endroit où une réponse « non »
//   ne coûte rien : la caisse est connectée, personne n'a encore vendu.
// - Il n'est PAS dans `createSale`, ni dans `importerCloture` : une vente — a fortiori une vente
//   faite hors ligne et remontée après coup — n'est jamais refusée pour une raison de quota.
//   Ces deux fonctions ne lisent même pas ce fichier.
//
// TOUT ÉCHEC DU REGISTRE OUVRE. Table absente (migration pas encore jouée), base en erreur,
// Core-Auth en panne : l'ouverture de session se déroule comme avant ce chantier.

import type { Prisma } from "@prisma/client";
import { withTenant } from "./tenant";
import { log } from "./log";
import { decisionInscription, lireDroit, refusPostes, type DroitQuota, type QuotaAtteint } from "./quota";

const CLE = "CAISSE";

function droitCaisse(tenantId: string): Promise<DroitQuota | null> {
  return lireDroit(tenantId, CLE, { journal: (e) => log.error("quota.lireDroit", e, { tenantId, cle: CLE }) });
}

/** Sérialise les inscriptions d'un même tenant jusqu'à la fin de la transaction. */
async function verrouRegistre(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"quota-postes:" + tenantId}, 0))`;
}

/** Ce poste a-t-il déjà travaillé (session ou vente à son nom) ? */
async function aDejaTravaille(tx: Prisma.TransactionClient, tenantId: string, posteId: string): Promise<boolean> {
  if (await tx.cashSession.findFirst({ where: { tenantId, posteId }, select: { id: true } })) return true;
  return !!(await tx.sale.findFirst({ where: { tenantId, posteId }, select: { id: true } }));
}

/**
 * Appelé par `openSession` quand un `posteId` est fourni. Rend `ok: true` dans tous les cas
 * sauf UN : un poste nouveau (ou rallumé) alors que le plafond est atteint. Ne lève jamais.
 */
export async function inscrirePosteEnLigne(
  tenantId: string,
  posteId: string,
): Promise<{ ok: true } | { ok: false; quota: QuotaAtteint }> {
  try {
    const droit = await droitCaisse(tenantId); // avant la transaction : pas d'appel réseau sous verrou
    const plafond = droit?.plafond ?? null;
    return await withTenant(tenantId, async (tx) => {
      const cle = { tenantId_posteId: { tenantId, posteId } };
      // Chemin de tous les jours : poste connu et actif → une lecture, aucun verrou.
      const connu = await tx.poste.findUnique({ where: cle, select: { actif: true } });
      if (connu?.actif) return { ok: true as const };

      await verrouRegistre(tx, tenantId);
      const poste = await tx.poste.findUnique({ where: cle, select: { actif: true } });
      const aHistorique = poste ? false : await aDejaTravaille(tx, tenantId, posteId);
      const actifs = await tx.poste.count({ where: { tenantId, actif: true } });
      const decision = decisionInscription({ poste, aHistorique, plafond, actifs });
      if (decision.action === "refuser") {
        return { ok: false as const, quota: refusPostes(CLE, plafond as number, actifs, droit?.quoi ?? null) };
      }
      if (decision.action === "inscrire") {
        await tx.poste.upsert({
          where: cle,
          create: { tenantId, posteId, horsQuota: decision.horsQuota },
          update: { actif: true, horsQuota: decision.horsQuota },
        });
      }
      return { ok: true as const };
    });
  } catch (e) {
    log.error("quota.inscrirePoste", e, { tenantId, posteId });
    return { ok: true };
  }
}

/**
 * Après l'import RÉUSSI d'une session faite hors ligne : on note le poste s'il est inconnu,
 * sans aucun contrôle (marqué hors quota s'il dépasse). Ne lève jamais, ne refuse jamais.
 */
export async function noterPosteHorsLigne(tenantId: string, posteId: string): Promise<void> {
  try {
    const droit = await droitCaisse(tenantId);
    const plafond = droit?.plafond ?? null;
    await withTenant(tenantId, async (tx) => {
      const cle = { tenantId_posteId: { tenantId, posteId } };
      if (await tx.poste.findUnique({ where: cle, select: { id: true } })) return;
      await verrouRegistre(tx, tenantId);
      const actifs = await tx.poste.count({ where: { tenantId, actif: true } });
      const horsQuota = plafond !== null && actifs >= plafond;
      await tx.poste.upsert({ where: cle, create: { tenantId, posteId, horsQuota }, update: {} });
    });
  } catch (e) {
    log.error("quota.noterPosteHorsLigne", e, { tenantId, posteId });
  }
}

/** Consommation + liste des postes, pour l'écran marchand et l'admin PacifiCode. */
export async function listerPostes(tenantId: string) {
  const [droit, registre] = await Promise.all([
    droitCaisse(tenantId),
    withTenant(tenantId, async (tx) => ({
      utilise: await tx.poste.count({ where: { tenantId, actif: true } }),
      postes: await tx.poste.findMany({
        where: { tenantId },
        orderBy: { creeLe: "asc" },
        select: { posteId: true, libelle: true, actif: true, horsQuota: true, creeLe: true },
      }),
    })),
  ]);
  return {
    cle: CLE,
    quoi: droit?.quoi ?? "postes de caisse",
    niveau: droit?.niveau ?? null,
    plafond: droit?.plafond ?? null,
    ...registre,
  };
}

export type ModifierPosteResult =
  | { ok: true; poste: { posteId: string; libelle: string | null; actif: boolean; horsQuota: boolean } }
  | { ok: false; error: "POSTE_INCONNU" | "SESSION_OUVERTE" }
  | ({ ok: false } & QuotaAtteint);

/**
 * Renommer, désactiver (libère une place) ou rallumer un poste (repasse par le plafond).
 * On ne désactive pas un poste dont une session est ouverte : il est en train d'encaisser.
 */
export async function modifierPoste(
  tenantId: string,
  posteId: string,
  input: { libelle?: string | null; actif?: boolean },
): Promise<ModifierPosteResult> {
  const droit = input.actif === true ? await droitCaisse(tenantId) : null;
  const plafond = droit?.plafond ?? null;
  return withTenant(tenantId, async (tx) => {
    await verrouRegistre(tx, tenantId);
    const cle = { tenantId_posteId: { tenantId, posteId } };
    const poste = await tx.poste.findUnique({ where: cle, select: { actif: true } });
    if (!poste) return { ok: false as const, error: "POSTE_INCONNU" as const };
    if (input.actif === false && poste.actif) {
      const ouverte = await tx.cashSession.findFirst({ where: { tenantId, posteId, status: "OPEN" }, select: { id: true } });
      if (ouverte) return { ok: false as const, error: "SESSION_OUVERTE" as const };
    }
    if (input.actif === true && !poste.actif) {
      const actifs = await tx.poste.count({ where: { tenantId, actif: true } });
      if (plafond !== null && actifs >= plafond) {
        return { ok: false as const, ...refusPostes(CLE, plafond, actifs, droit?.quoi ?? null) };
      }
    }
    const changeEtat = input.actif !== undefined && input.actif !== poste.actif;
    const maj = await tx.poste.update({
      where: cle,
      data: {
        ...(input.libelle !== undefined ? { libelle: input.libelle?.trim() || null } : {}),
        ...(changeEtat ? { actif: input.actif, horsQuota: false } : {}),
      },
      select: { posteId: true, libelle: true, actif: true, horsQuota: true },
    });
    return { ok: true as const, poste: maj };
  });
}
