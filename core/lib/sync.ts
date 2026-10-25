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

export const SYNC_EN_COURS_MARKER = "SYNC_EN_COURS";
// Marge après la durée maximale cumulée des appels pour couvrir la libération de la revendication.
export const SYNC_CLAIM_MARGIN_MS = 5000;
export const SYNC_A_REPRENDRE_MARKER = "SYNC_A_REPRENDRE";
export function syncClaimFor(calls: number, now: Date, timeoutMs: number, claimId: string): string {
  const until = new Date(now.getTime() + calls * timeoutMs + SYNC_CLAIM_MARGIN_MS).toISOString();
  return `${SYNC_EN_COURS_MARKER} jusqu'au ${until} #${claimId}`;
}
export function claimState(syncError: string | null | undefined, now: Date): "none" | "live" | "stale" {
  if (syncError?.startsWith(SYNC_A_REPRENDRE_MARKER)) return "stale";
  if (!syncError?.startsWith(SYNC_EN_COURS_MARKER)) return "none";
  const match = syncError.match(/^SYNC_EN_COURS jusqu'au (\S+)(?: #[^\s]+)?$/);
  const until = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(until) && until > now.getTime() ? "live" : "stale";
}
export function syncBlocksVoid(sale: Pick<SyncSaleSnapshot, "status" | "syncError" | "comptaSyncedAt" | "stockSyncedAt"> & {
  lines: { kind: string; productId: string | null }[];
}, now: Date): boolean {
  return sale.status === "PAID" &&
    (claimState(sale.syncError, now) === "live" ||
      (!!(sale.syncError?.startsWith(SYNC_EN_COURS_MARKER) || sale.syncError?.startsWith(SYNC_A_REPRENDRE_MARKER)) &&
        (!sale.comptaSyncedAt || (!sale.stockSyncedAt && sale.lines.some(l => l.kind === "PRODUCT" && l.productId)))));
}
export function checkoutStatusAfterSync(outcome: SyncOutcome | null | undefined): "PAID" | "VOID" {
  return outcome?.stopped === "VOID" || outcome?.settledOnVoidingSale || outcome?.stockOnVoidingSale ? "VOID" : "PAID";
}

export const CAISSE_SOURCE_TYPE = "caisse";

export type SyncLine = {
  id: string;
  kind: string; // SERVICE | PRODUCT | OTHER
  label: string;
  productId: string | null;
  qty: number;
  unitXpf: bigint;
  /** Taux de TGC PROPRE à cette ligne (ppm), 2026-08-23. Optionnel : `null`/absent → NE PAS
   *  transmettre le champ à Compta (cf. l.135 plus bas) — jamais 0, qui signifierait « hors
   *  champ TGC » côté Compta et n'est pas la même chose que « non renseigné ». */
  tgcRatePpm?: number | null;
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
  /** Reference externe de la vente — pour une vente de comptoir, l'identifiant
   *  du ticket tire par la tablette. Transmis a Compta pour l'attribution. */
  sourceId: string | null;
  clientName: string | null;
  cashierId: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  comptaSyncedAt: Date | null;
  stockSyncedAt: Date | null;
  /** Vente À CRÉDIT (lot A, 2026-09-15) : ISO 8601 à MIDI UTC de la dernière échéance, transmis
   *  TEL QUEL à `compta.createInvoice`. `null`/absent = facture sans échéance, comportement
   *  inchangé. Relu par l'appelant (`lib/caisse.ts#toSnapshot`) depuis `Sale.dueAt` (migration
   *  `20260915200000_sale_due_at`), posé une fois dans la transaction du passage à PAID — donc
   *  disponible aussi bien à la synchro nominale qu'à une reprise différée (`repairSale` / cron
   *  `repair-sales`) après un échec du premier `createInvoice`. */
  dueAt?: string | null;
  status?: string;
  voidPreparedAt?: Date | null;
  creditNoteId?: string | null;
  syncError?: string | null;
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

export const NEUTRALISATION_MARKER = "NEUTRALISATION_EN_ATTENTE";
/** Une écriture ordinaire préserve les étapes en vol, à reprendre et les neutralisations. */
export function shouldWriteSyncError(current: string | null | undefined, detail: string | null): boolean {
  const protectedError = (value: string | null | undefined) =>
    [NEUTRALISATION_MARKER, SYNC_EN_COURS_MARKER, SYNC_A_REPRENDRE_MARKER].some(marker => value?.startsWith(marker));
  return !protectedError(current) || protectedError(detail);
}
const NEUTRALISATION_REASON = "Vente annulée pendant la synchro : facture neutralisée";

/** Transactions courtes sous verrou, sans appel réseau. */
export type SyncGuard = {
  reread(): Promise<SyncSaleSnapshot | null>;
  claimSync(claim: string, phase: "compta" | "stock"): Promise<
    { claimed: true; fresh: SyncSaleSnapshot } |
    { claimed: false; busy: false; done: true; fresh: SyncSaleSnapshot } |
    { claimed: false; busy: boolean; done?: false; fresh: SyncSaleSnapshot | null }
  >;
  completeSync(claim: string, phase: "compta" | "stock"): Promise<void>;
  failSync(claim: string, phase: "compta" | "stock", detail: string): Promise<void>;
  saveInvoiceRefIfLive(invoiceId: string, invoiceNumber: string | null): Promise<
    { saved: true } | { saved: false; fresh: SyncSaleSnapshot | null }
  >;
  attachOrphanInvoice(invoiceId: string, invoiceNumber: string | null): Promise<boolean>;
  attachNeutralization(invoiceId: string, creditNoteId: string): Promise<void>;
  failNeutralization(invoiceId: string, detail: string): Promise<void>;
};

export type SyncOutcome = {
  stopped?: "VOID" | "VOID_IN_PROGRESS" | "NOT_FOUND" | "LOCKED" | "INVOICE_CONFLICT";
  neutralized?: boolean;
  settledOnVoidingSale?: boolean;
  stockOnVoidingSale?: boolean;
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

function createInvoice(sale: SyncSaleSnapshot, compta: ComptaClient) {
  return compta.createInvoice({
    tenantId: sale.tenantId, sourceType: CAISSE_SOURCE_TYPE, sourceId: sale.id,
    ticketRef: sale.sourceId, clientName: sale.clientName,
    // Vente à crédit (lot A) : omis quand non renseigné — PAS de fallback à une date bidon.
    ...(sale.dueAt ? { dueAt: sale.dueAt } : {}),
    lines: sale.lines.map(l => ({
      label: l.label, qty: l.qty, unitXpf: Number(l.unitXpf),
      // Omis quand non renseigné — PAS 0 (0 signifierait « hors champ TGC » côté Compta).
      ...(l.tgcRatePpm !== undefined && l.tgcRatePpm !== null ? { tgcRatePpm: l.tgcRatePpm } : {}),
    })),
  });
}

export async function retryNeutralization(sale: SyncSaleSnapshot, compta: ComptaClient, guard: SyncGuard) {
  if (sale.status !== "VOID" || !sale.invoiceId || sale.creditNoteId ||
      !sale.syncError?.startsWith(NEUTRALISATION_MARKER)) {
    return { neutralized: false, creditNoteId: sale.creditNoteId ?? null, failure: null };
  }
  try {
    const note = await compta.creditNote({ tenantId: sale.tenantId, invoiceId: sale.invoiceId, reason: NEUTRALISATION_REASON });
    await guard.attachNeutralization(sale.invoiceId, note.creditNoteId);
    return { neutralized: true, creditNoteId: note.creditNoteId, failure: null };
  } catch (e) {
    const failure = asCoreFailure(e);
    if (!failure) throw e;
    return { neutralized: false, creditNoteId: null, failure };
  }
}

function stoppedFor(sale: SyncSaleSnapshot | null): SyncOutcome["stopped"] {
  if (!sale) return "NOT_FOUND";
  if (sale.status !== undefined && sale.status !== "PAID") return "VOID";
  if (sale.voidPreparedAt) return "VOID_IN_PROGRESS";
}

/**
 * Relecture sous verrou avant chaque étape ; appels réseau hors verrou.
 * Facture créée pendant une annulation directe : neutralisation (décision Marco 15/10).
 * Relecture après règlements et stock, puis marquage de leurs effets externes.
 * Fenêtres résiduelles signalées par settledOnVoidingSale / stockOnVoidingSale.
 */
async function runGuardedSaleSync(
  compta: ComptaClient, stock: StockClient, persist: SyncPersist, guard: SyncGuard, timeoutMs: number, allowNegativeStock: boolean,
): Promise<SyncOutcome> {
  let invoiceId: string | null = null;
  let invoiceNumber: string | null = null;
  let stockDecremented = 0;
  let active: { claim: string; phase: "compta" | "stock" } | null = null;
  const races: Pick<SyncOutcome, "settledOnVoidingSale" | "stockOnVoidingSale"> = {};
  const stop = async (stopped: NonNullable<SyncOutcome["stopped"]>): Promise<SyncOutcome> => {
    if (stopped === "VOID_IN_PROGRESS") {
      await persist.recordFailure("VOID_IN_PROGRESS annulation en cours : synchro Compta/Stock suspendue");
    }
    return { synced: false, failure: null, stopped, invoiceId, invoiceNumber, stockDecremented, ...races };
  };
  const reread = async () => {
    const cur = await guard.reread();
    invoiceId = cur?.invoiceId ?? null;
    invoiceNumber = cur?.invoiceNumber ?? null;
    if (cur?.stockSyncedAt) stockDecremented = cur.lines.filter(l => l.kind === "PRODUCT" && l.productId).length;
    return cur;
  };
  try {
    let cur = await reread();
    let stopped = stoppedFor(cur);
    if (stopped) return await stop(stopped);
    if (!cur) return await stop("NOT_FOUND");
    if (!cur.comptaSyncedAt && !cur.invoiceId) {
      const inv = await createInvoice(cur, compta);
      invoiceId = inv.invoiceId;
      invoiceNumber = inv.number;
      const saved = await guard.saveInvoiceRefIfLive(inv.invoiceId, inv.number);
      if (!saved.saved) {
        const fresh = saved.fresh;
        if (fresh?.status === "VOID" && !fresh.invoiceId) {
          if (!await guard.attachOrphanInvoice(inv.invoiceId, inv.number)) return await stop("VOID");
          const result = await retryNeutralization({ ...fresh, invoiceId: inv.invoiceId, syncError: NEUTRALISATION_MARKER }, compta, guard);
          // Ne pas écraser le marqueur en cas d'échec : le balayage doit reprendre l'avoir.
          return { ...await stop("VOID"), failure: result.failure, ...(result.neutralized ? { neutralized: true } : {}) };
        }
        stopped = stoppedFor(fresh);
        if (stopped) return await stop(stopped);
        if (fresh?.invoiceId && fresh.invoiceId !== inv.invoiceId) {
          await persist.recordFailure(`INVOICE_CONFLICT facture créée ${inv.invoiceId} ≠ facture enregistrée ${fresh.invoiceId}`);
          return await stop("INVOICE_CONFLICT");
        }
        // Refus inexpliqué : aucune opération d'argent supplémentaire.
        return await stop("LOCKED");
      }
    }
    cur = await reread();
    stopped = stoppedFor(cur);
    if (stopped) return await stop(stopped);
    if (!cur) return await stop("NOT_FOUND");
    if (!cur.comptaSyncedAt) {
      if (!cur.invoiceId) throw new Error("Synchro règlements : invoiceId absent");
      if (cur.payments.length) {
        const claim = syncClaimFor(cur.payments.length, new Date(), timeoutMs, crypto.randomUUID());
        const result = await guard.claimSync(claim, "compta");
        if (!result.claimed && !result.done) return await stop(result.busy ? "LOCKED" : stoppedFor(result.fresh) ?? "LOCKED");
        if (result.claimed) active = { claim, phase: "compta" };
        cur = result.fresh;
      } else cur = await guard.reread();
      invoiceId = cur?.invoiceId ?? null;
      invoiceNumber = cur?.invoiceNumber ?? null;
      stopped = stoppedFor(cur);
      if (stopped) return await stop(stopped);
      if (!cur) return await stop("NOT_FOUND");
      if (!cur.invoiceId) throw new Error("Synchro règlements : invoiceId absent après relecture");
      if (!cur.comptaSyncedAt) {
        for (const p of cur.payments) {
          await compta.settle({ tenantId: cur.tenantId, invoiceId: cur.invoiceId,
            amountXpf: Number(p.amountXpf), method: p.method,
            paymentRef: p.settleRef ?? `${CAISSE_SOURCE_TYPE}:${cur.id}:${p.id}` });
        }
        const afterSettle = await guard.reread();
        if (afterSettle?.status === "VOID" || afterSettle?.voidPreparedAt) races.settledOnVoidingSale = true;
        if (active) await guard.completeSync(active.claim, "compta");
        else await persist.markComptaSynced();
        active = null;
      }
    }
    cur = await reread();
    stopped = stoppedFor(cur);
    if (stopped) return await stop(stopped);
    if (!cur) return await stop("NOT_FOUND");
    if (!cur.stockSyncedAt) {
      let productLines = cur.lines.filter(l => l.kind === "PRODUCT" && l.productId);
      if (productLines.length) {
        const claim = syncClaimFor(productLines.length, new Date(), timeoutMs, crypto.randomUUID());
        const result = await guard.claimSync(claim, "stock");
        if (!result.claimed && !result.done) return await stop(result.busy ? "LOCKED" : stoppedFor(result.fresh) ?? "LOCKED");
        if (result.claimed) active = { claim, phase: "stock" };
        cur = result.fresh;
        productLines = cur.lines.filter(l => l.kind === "PRODUCT" && l.productId);
      } else cur = await guard.reread();
      invoiceId = cur?.invoiceId ?? null;
      invoiceNumber = cur?.invoiceNumber ?? null;
      stopped = stoppedFor(cur);
      if (stopped) return await stop(stopped);
      if (!cur) return await stop("NOT_FOUND");
      if (!cur.stockSyncedAt) {
        for (const l of productLines) {
          await stock.recordSale({ tenantId: cur.tenantId, productId: l.productId!, qty: l.qty,
            sourceType: CAISSE_SOURCE_TYPE, sourceId: `${cur.id}:${l.id}`, actorId: cur.cashierId ?? undefined,
            ...(allowNegativeStock ? { allowNegative: true } : {}) });
          stockDecremented++;
        }
        const afterStock = await guard.reread();
        if (afterStock?.status === "VOID" || afterStock?.voidPreparedAt) races.stockOnVoidingSale = true;
        if (active) await guard.completeSync(active.claim, "stock");
        else await persist.markStockSynced();
        active = null;
      } else stockDecremented = productLines.length;
    }
    await persist.clearError();
    return { synced: true, failure: null, invoiceId, invoiceNumber, stockDecremented, ...races };
  } catch (e) {
    const failure = asCoreFailure(e);
    if (!failure) {
      if (active) {
        try { await guard.failSync(active.claim, active.phase, e instanceof Error ? e.message : String(e)); }
        catch { /* Préserver l'erreur d'origine. */ }
      }
      throw e;
    }
    if (active) await guard.failSync(active.claim, active.phase, formatFailure(failure));
    else await persist.recordFailure(formatFailure(failure));
    return { synced: false, failure, invoiceId, invoiceNumber, stockDecremented, ...races };
  }
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
  guard?: SyncGuard,
  timeoutMs = 8000,
  allowNegativeStock = false,
): Promise<SyncOutcome> {
  if (guard) return runGuardedSaleSync(compta, stock, persist, guard, timeoutMs, allowNegativeStock);
  let invoiceId = sale.invoiceId;
  let invoiceNumber = sale.invoiceNumber;
  const productLines = sale.lines.filter((l) => l.kind === "PRODUCT" && l.productId);
  let stockDecremented = sale.stockSyncedAt ? productLines.length : 0;

  try {
    // ÉTAPE COMPTA (facture + settles) — sautée si déjà marquée faite.
    if (!sale.comptaSyncedAt) {
      if (!invoiceId) {
        const inv = await createInvoice(sale, compta);
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
          ...(allowNegativeStock ? { allowNegative: true } : {}),
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
