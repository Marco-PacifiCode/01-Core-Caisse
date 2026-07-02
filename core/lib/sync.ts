// lib/sync.ts — MOTEUR DE SYNCHRONISATION post-encaissement (chantier fiabilité 2026-07).
//
// PROBLÈME : un encaissement = 3 appels S2S (facture Compta → settle → décrément Stock). Une panne
// partielle APRÈS que l'argent est pris laissait l'inventaire/la compta désynchronisés sans reprise.
//
// MODÈLE : la vente passe PAID dès que le paiement est validé (l'argent est dans le tiroir), puis la
// synchro converge — inline au checkout, ou plus tard via repair/cron. L'état vit sur Sale :
//   comptaSyncedAt  : facture créée ET tous les paiements soldés côté Core-Compta
//   stockSyncedAt   : tous les décréments SALE passés côté Core-Stock (posé même sans ligne PRODUCT)
//   syncError       : dernière erreur (trace exploitable : "core:op kind status detail")
//   syncAttempts    : nombre de tentatives de synchro
// Vente « à réparer » ⇔ status=PAID ET (comptaSyncedAt IS NULL OU stockSyncedAt IS NULL).
//
// Le moteur est PUR : dépendances injectées (clients cores + persistance) → testable sans DB ni HTTP
// (cf. lib/sync.test.ts). caisse.ts le branche sur Prisma/withTenant et les vrais clients.
// La reprise est IDEMPOTENTE À DEUX ÉTAGES : (1) les étapes déjà marquées faites sont sautées ici ;
// (2) les cibles dédupliquent de toute façon (facture par sourceId, settle par paymentRef, mouvement
// stock par sourceId) → rejouer une étape douteuse est toujours sûr.

// import type uniquement : aucun import runtime → chargeable par `node --test` sans bundler.
import type { ComptaClient, StockClient, CoreFailureKind } from "./clients";

export const CAISSE_SOURCE_TYPE = "caisse";

export type SyncLine = {
  id: string;
  kind: string; // SERVICE | PRODUCT | OTHER
  label: string;
  productId: string | null;
  qty: number;
  unitXpf: bigint;
};

export type SyncPayment = {
  id: string;
  method: string;
  amountXpf: bigint;
  settleRef: string | null;
};

/** Photo de la vente nécessaire à la synchro (chargée sous withTenant par l'appelant). */
export type SyncSaleSnapshot = {
  id: string;
  tenantId: string;
  clientName: string | null;
  cashierId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  comptaSyncedAt: Date | null;
  stockSyncedAt: Date | null;
  lines: SyncLine[];
  payments: SyncPayment[];
};

/** Effets de persistance (implémentés via withTenant/Prisma par caisse.ts, en mémoire par les tests). */
export type SyncPersist = {
  /** Persiste la référence facture DÈS création (un rejeu réutilise la même facture). */
  saveInvoiceRef(invoiceId: string, invoiceNumber: string | null): Promise<void>;
  markComptaSynced(): Promise<void>;
  markStockSynced(): Promise<void>;
  /** Trace l'échec (syncError + syncAttempts++) — la vente reste PAID, le cron la ramassera. */
  recordFailure(detail: string): Promise<void>;
  /** Synchro complète : efface syncError. */
  clearError(): Promise<void>;
};

export type CoreFailure = {
  core: "compta" | "stock";
  op: string;
  status: number;
  kind: CoreFailureKind;
  detail: string;
};

export type SyncOutcome = {
  synced: boolean;
  invoiceId: string | null;
  invoiceNumber: string | null;
  stockDecremented: number; // lignes PRODUCT effectivement couvertes (déjà faites incluses)
  failure: CoreFailure | null;
};

/** Duck-typing (pas d'instanceof : le moteur n'importe aucune classe runtime). */
function asCoreFailure(e: unknown): CoreFailure | null {
  if (!e || typeof e !== "object") return null;
  const c = e as Record<string, unknown>;
  if ((c.core === "compta" || c.core === "stock") && typeof c.op === "string" && typeof c.status === "number") {
    return {
      core: c.core,
      op: c.op,
      status: c.status,
      kind: (c.kind === "timeout" || c.kind === "network" ? c.kind : "http") as CoreFailureKind,
      detail: typeof c.detail === "string" ? c.detail : String(c.detail ?? ""),
    };
  }
  return null;
}

export function formatFailure(f: CoreFailure): string {
  return `${f.core}:${f.op} ${f.kind} ${f.status} ${f.detail}`.slice(0, 800);
}

/**
 * Rejoue UNIQUEMENT les étapes manquantes de la synchro d'une vente PAID.
 *   compta manquante → créer la facture si pas d'invoiceId (persistée aussitôt), puis settle chaque
 *   paiement (paymentRef déterministe) → markComptaSynced.
 *   stock manquant → décrément SALE par ligne PRODUCT (sourceId "<saleId>:<lineId>") → markStockSynced.
 * Échec d'appel core → recordFailure + retour { synced:false, failure } (l'erreur ne remonte PAS :
 * l'encaissement est déjà acté ; la convergence est différée). Toute autre erreur remonte.
 */
export async function runSaleSync(
  sale: SyncSaleSnapshot,
  compta: ComptaClient,
  stock: StockClient,
  persist: SyncPersist,
): Promise<SyncOutcome> {
  let invoiceId = sale.invoiceId;
  let invoiceNumber = sale.invoiceNumber;
  const productLines = sale.lines.filter((l) => l.kind === "PRODUCT" && l.productId);
  let stockDecremented = sale.stockSyncedAt ? productLines.length : 0;

  try {
    // ÉTAPE COMPTA (facture + settles) — sautée si déjà marquée faite.
    if (!sale.comptaSyncedAt) {
      if (!invoiceId) {
        const inv = await compta.createInvoice({
          tenantId: sale.tenantId,
          sourceType: CAISSE_SOURCE_TYPE,
          sourceId: sale.id,
          clientName: sale.clientName,
          lines: sale.lines.map((l) => ({ label: l.label, qty: l.qty, unitXpf: Number(l.unitXpf) })),
        });
        invoiceId = inv.invoiceId;
        invoiceNumber = inv.number;
        await persist.saveInvoiceRef(invoiceId, invoiceNumber);
      }
      for (const p of sale.payments) {
        await compta.settle({
          tenantId: sale.tenantId,
          invoiceId,
          amountXpf: Number(p.amountXpf),
          method: p.method,
          paymentRef: p.settleRef ?? `${CAISSE_SOURCE_TYPE}:${sale.id}:${p.id}`,
        });
      }
      await persist.markComptaSynced();
    }

    // ÉTAPE STOCK (décréments) — sautée si déjà marquée faite. Posée même sans ligne PRODUCT
    // (une vente 100 % service est « synchronisée stock » par vacuité).
    if (!sale.stockSyncedAt) {
      for (const l of productLines) {
        await stock.recordSale({
          tenantId: sale.tenantId,
          productId: l.productId!,
          qty: l.qty,
          sourceType: CAISSE_SOURCE_TYPE,
          sourceId: `${sale.id}:${l.id}`,
          actorId: sale.cashierId ?? undefined,
        });
        stockDecremented++;
      }
      await persist.markStockSynced();
    }

    await persist.clearError();
    return { synced: true, invoiceId, invoiceNumber, stockDecremented, failure: null };
  } catch (e) {
    const failure = asCoreFailure(e);
    if (failure) {
      await persist.recordFailure(formatFailure(failure));
      return { synced: false, invoiceId, invoiceNumber, stockDecremented, failure };
    }
    throw e; // erreur inattendue (bug, DB) → remonte
  }
}
