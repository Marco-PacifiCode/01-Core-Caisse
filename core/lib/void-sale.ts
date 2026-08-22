// lib/void-sale.ts — MOTEUR D'ANNULATION D'UNE VENTE (pur, sans DB) — même schéma que lib/sync.ts :
// dépendances injectées (client Compta + persistance) → testable sans DB ni HTTP (cf. void-route.test.ts).
// caisse.ts le branche sur Prisma/withTenant et le vrai client Compta.
//
// RÈGLES (dans cet ordre) :
//   VOID  → idempotent : rejouer ne doit JAMAIS échouer (alreadyVoid:true, rien d'autre ne bouge).
//   DRAFT → passe VOID directement, aucun appel externe (rien n'a jamais été encaissé ni facturé).
//   PAID  → REFUS si du stock a été décrémenté (ligne PRODUCT + stockSyncedAt) : remettre du stock est
//           un geste distinct qu'on ne devine pas ici (moteur mutualisé entre marchands) → on échoue
//           fermé plutôt que de laisser un stock faux.
//         → sinon, si une facture existe (invoiceId), on émet un AVOIR côté Compta AVANT de passer
//           VOID. Si l'avoir échoue, la vente NE PASSE PAS à VOID : une caisse qui dit « annulé »
//           pendant que la compta encaisse encore serait le pire des deux états.
//         → si aucune facture n'a jamais été créée, on passe directement à VOID.

import type { ComptaClient } from "./clients";

export type VoidSaleLine = {
  kind: string; // SERVICE | PRODUCT | OTHER
  productId: string | null;
};

/** Photo de la vente nécessaire à l'annulation (chargée sous withTenant par l'appelant). */
export type VoidSaleSnapshot = {
  id: string;
  status: string; // SaleStatus : DRAFT | PAID | VOID
  invoiceId: string | null;
  stockSyncedAt: Date | null;
  lines: VoidSaleLine[];
};

/** Effets de persistance (implémentés via withTenant/Prisma par caisse.ts, en mémoire par les tests). */
export type VoidPersist = {
  /** Passe la vente à VOID. */
  markVoid(): Promise<void>;
};

export type VoidOutcome =
  | { ok: true; alreadyVoid: true }
  | { ok: true; alreadyVoid: false; creditNoteId: string | null }
  | { ok: false; error: "STOCK_DECREMENTED" }
  | { ok: false; error: "CREDIT_NOTE_FAILED"; detail: string };

/**
 * Annule une vente déjà chargée. N'échoue JAMAIS sur une vente déjà VOID (idempotence).
 * `reason` est transmis tel quel à l'avoir Compta (facultatif).
 */
export async function runVoidSale(
  sale: VoidSaleSnapshot,
  tenantId: string,
  compta: ComptaClient,
  persist: VoidPersist,
  opts?: { reason?: string },
): Promise<VoidOutcome> {
  if (sale.status === "VOID") return { ok: true, alreadyVoid: true };

  if (sale.status === "DRAFT") {
    await persist.markVoid();
    return { ok: true, alreadyVoid: false, creditNoteId: null };
  }

  // status === "PAID" (seule valeur restante de SaleStatus)
  const stockDecremented = sale.lines.some((l) => l.kind === "PRODUCT" && l.productId) && Boolean(sale.stockSyncedAt);
  if (stockDecremented) {
    return { ok: false, error: "STOCK_DECREMENTED" };
  }

  if (!sale.invoiceId) {
    await persist.markVoid();
    return { ok: true, alreadyVoid: false, creditNoteId: null };
  }

  let creditNoteId: string;
  try {
    const r = await compta.creditNote({ tenantId, invoiceId: sale.invoiceId, reason: opts?.reason });
    creditNoteId = r.creditNoteId;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "CREDIT_NOTE_FAILED", detail };
  }

  // L'avoir est acquis côté Compta AVANT qu'on ne touche à la vente : si `markVoid` échoue
  // ensuite (erreur DB inattendue), elle remonte telle quelle — pas de faux `ok`.
  await persist.markVoid();
  return { ok: true, alreadyVoid: false, creditNoteId };
}
