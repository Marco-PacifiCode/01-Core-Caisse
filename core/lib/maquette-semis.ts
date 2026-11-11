// lib/maquette-semis.ts — démo privée : écriture des journées de caisse FICTIVES d'un tenant maquette.
//
// Exécuté DANS la transaction de la route (withTenant, rôle applicatif, RLS active), APRÈS
// l'inscription au registre (inscrire_tenant_maquette). Chaque journée passe par les fonctions
// métier du journal de caisse, comme une journée réelle :
//   openCashDay  → CashSession (openedAt antidaté) + CashDay + CashDaySession + CashDayOpening + fait OPENING
//   ventes       → Sale PAID (createdAt/paidAt antidatés) + lignes + règlement, puis recordSharedSale (fait SALE_PAID)
//   closeCashDay → clôture Z (closeSessionTx), fait CLOSURE + CashDayClosure, compté = attendu
// Les dates MÉTIER (occurredAt, openedAt, createdAt, paidAt) sont antidatées ; les dates d'ÉCRITURE
// ("receivedAt", "createdAt" des CashDaySession) gardent leur valeur par défaut (now()).
//
// AUCUN appel à Core-Paiement, Core-Compta, Core-Stock ni Core-Comms : les ventes ne passent pas par
// checkoutSale. Elles naissent avec comptaSyncedAt ET stockSyncedAt posés (aucune ligne PRODUCT,
// aucune facture) : elles n'entrent jamais dans la file de reprise (repair-policy#pendingSalesWhere,
// index idx_sale_sync_pending) et repairSale les considère convergées — elles ne partent JAMAIS.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { closeCashDay, openCashDay } from "./cash-days";
import { recordSharedSale } from "./cash-day-ledger";
import type { ActionInput } from "./caisse-sync";
import type { JourneePlan } from "./maquette";

type Tx = Prisma.TransactionClient;
export type CompteursSemis = { journees: number; ventes: number; lignes: number; caXpf: number };

const APPAREIL = "demo-maquette";
const NOM_APPAREIL = "Caisse de démonstration";
const VENDEUR = "Démonstration";

export async function semerJournees(tx: Tx, tenantId: string, plan: JourneePlan[]): Promise<CompteursSemis> {
  const compteurs: CompteursSemis = { journees: 0, ventes: 0, lignes: 0, caXpf: 0 };
  const auteur = { actorId: tenantId, actorName: VENDEUR, receivedById: tenantId };
  for (const jour of plan) {
    const ouvert = await openCashDay(tx, {
      tenantId, actionId: randomUUID(), entityKey: "day", deviceId: APPAREIL, deviceName: NOM_APPAREIL, ...auteur,
      occurredAt: jour.ouverture.toISOString(), businessDay: jour.businessDay,
      sourceKey: randomUUID(), localSessionKey: randomUUID(), openingFloatXpf: String(jour.fondXpf),
    } satisfies ActionInput);
    const cashDayId = String((ouvert as { cashDayId: string }).cashDayId);
    const sessionId = String((ouvert as { sessionId: string }).sessionId);
    let especes = 0;
    let rang = 0;
    for (const t of jour.tickets) {
      rang++;
      const total = BigInt(t.totalXpf);
      const vente = await tx.sale.create({
        data: {
          tenantId, sessionId, cashDayId, status: "PAID", subtotalXpf: total, totalXpf: total,
          createdAt: t.a, paidAt: t.a, deviceId: APPAREIL, deviceName: NOM_APPAREIL,
          ticketNumber: `DEMO-${jour.businessDay.replaceAll("-", "")}-${String(rang).padStart(3, "0")}`,
          sellerName: VENDEUR, comptaSyncedAt: new Date(), stockSyncedAt: new Date(),
          lines: { create: t.lignes.map((l) => ({ tenantId, kind: "SERVICE" as const, label: l.nom, qty: l.qty,
            unitXpf: BigInt(l.unitXpf), lineXpf: BigInt(l.unitXpf * l.qty), tgcRatePpm: l.tgcRatePpm, createdAt: t.a })) },
          payments: { create: [{ tenantId, method: t.moyen, amountXpf: total, tenderedXpf: t.moyen === "CASH" ? total : null, createdAt: t.a }] },
        },
        select: { id: true },
      });
      await recordSharedSale(tx, tenantId, vente.id);
      if (t.moyen === "CASH") especes += t.totalXpf;
      compteurs.ventes++;
      compteurs.lignes += t.lignes.length;
      compteurs.caXpf += t.totalXpf;
    }
    const attendu = String(jour.fondXpf + especes);
    await closeCashDay(tx, cashDayId, {
      tenantId, actionId: randomUUID(), entityKey: "day", deviceId: APPAREIL, deviceName: NOM_APPAREIL, ...auteur,
      occurredAt: jour.cloture.toISOString(), businessDay: jour.businessDay, sourceKey: randomUUID(),
      cycle: 0, countedXpf: attendu, localExpectedXpf: attendu, localVarianceXpf: "0", closureMode: "ONLINE",
    } satisfies ActionInput);
    compteurs.journees++;
  }
  return compteurs;
}
