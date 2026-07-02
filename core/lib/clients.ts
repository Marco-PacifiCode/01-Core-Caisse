// lib/clients.ts — clients SORTANTS vers les autres cores (Compta + Stock), S2S via X-Core-Key.
//
// La caisse ORCHESTRE : à l'encaissement elle pousse une facture + un paiement à Core-Compta et
// décrémente Core-Stock. Ces clients encapsulent ces contrats (vérifiés en frais depuis les repos) :
//   - Compta POST /api/invoices        → { invoiceId, number, totalXpf, alreadyExisted }
//   - Compta POST /api/settle          → { ok, invoiceId, paid, remaining }
//   - Compta GET  /api/invoices/:id/receipt?tenantId=… → application/pdf (ticket 80 mm)
//   - Stock  POST /api/movements       → { ok, movementId, productId, qtyOnHand, alreadyExisted }
//
// MODE MOCK (CORE_CLIENTS_MOCK) : quand activé, aucun appel réseau — les réponses sont simulées
// (idempotence en mémoire par processus). Permet build/tsc/test local SANS Compta & Stock up.
// En prod on laisse CORE_CLIENTS_MOCK vide → vrais appels HTTP.

// ─── Configuration par env ───────────────────────────────────────────────────
function mockEnabled(): boolean {
  const v = (process.env.CORE_CLIENTS_MOCK || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const comptaUrl = () => process.env.CORE_COMPTA_URL || "http://localhost:3101";
const comptaKey = () => process.env.CORE_COMPTA_API_KEY || "";
const stockUrl = () => process.env.CORE_STOCK_URL || "http://localhost:3105";
const stockKey = () => process.env.CORE_STOCK_API_KEY || "";

/** Timeout des appels S2S sortants (ms). Env CORE_CLIENT_TIMEOUT_MS, défaut 8000. */
function timeoutMs(): number {
  const n = Number(process.env.CORE_CLIENT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

/** Cibles S2S (pour le healthcheck /api/health — sondes de joignabilité). */
export function coreClientTargets(): { compta: string; stock: string; mocked: boolean } {
  return { compta: comptaUrl(), stock: stockUrl(), mocked: mockEnabled() };
}

// ─── Contrats (types) ────────────────────────────────────────────────────────
export type InvoiceLineInput = { label: string; qty: number; unitXpf: number };

export type CreateInvoiceInput = {
  tenantId: string;
  sourceType: string;
  sourceId: string;
  clientName?: string | null;
  lines: InvoiceLineInput[];
};

export type CreateInvoiceResult = {
  invoiceId: string;
  number: string;
  totalXpf: number;
  alreadyExisted: boolean;
};

export type SettleInput = {
  tenantId: string;
  invoiceId: string;
  amountXpf: number;
  method: string; // CASH | CARD | TRANSFER | CHEQUE | OTHER
  paymentRef: string; // idempotence côté Compta
};

export type SettleResult = {
  ok: true;
  invoiceId: string;
  paid: number;
  remaining: number;
};

export type MovementInput = {
  tenantId: string;
  productId: string;
  qty: number;
  sourceType: string;
  sourceId: string;
  actorId?: string;
};

export type MovementResult = {
  ok: true;
  movementId: string;
  productId: string;
  qtyOnHand: number;
  alreadyExisted: boolean;
};

// Nature d'un échec S2S — distinguable par l'appelant :
//   "timeout" : la cible n'a pas répondu dans CORE_CLIENT_TIMEOUT_MS (status 0) → transitoire, à rejouer.
//   "network" : connexion impossible (service down, DNS, port fermé — status 0) → transitoire, à rejouer.
//   "http"    : la cible a répondu non-2xx (status porté) → 5xx transitoire ; 4xx = problème de données
//               (ex : 409 INSUFFICIENT_STOCK) qui ne se résoudra pas par simple rejeu.
export type CoreFailureKind = "timeout" | "network" | "http";

// Erreur normalisée pour un appel core sortant en échec (permet retry sûr grâce à l'idempotence).
// NB : pas de « parameter properties » TS (public x) — non supportées par node --experimental-strip-types
// (les tests chargent ce module directement, cf. lib/clients.test.ts).
export class CoreClientError extends Error {
  core: "compta" | "stock";
  op: string;
  status: number;
  detail: string;
  kind: CoreFailureKind;

  constructor(core: "compta" | "stock", op: string, status: number, detail: string, kind: CoreFailureKind = "http") {
    super(`[${core}:${op}] ${kind} ${status} ${detail}`);
    this.name = "CoreClientError";
    this.core = core;
    this.op = op;
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

// ─── Interface commune ───────────────────────────────────────────────────────
export interface ComptaClient {
  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  /** URL S2S du reçu/ticket PDF (à imprimer côté caisse). */
  receiptUrl(invoiceId: string, tenantId: string): string;
}

export interface StockClient {
  recordSale(input: MovementInput): Promise<MovementResult>;
}

// ─── Implémentation HTTP réelle ──────────────────────────────────────────────
// TOUT appel sortant porte un AbortSignal.timeout (défaut 8 s) : une cible qui ne répond pas ne peut
// PAS geler un encaissement. L'échec est normalisé en CoreClientError { kind, status } distinguable
// (timeout / network / http) — l'appelant persiste l'état et la reprise (repair) convergera plus tard.
async function postJson(
  core: "compta" | "stock",
  op: string,
  url: string,
  key: string,
  body: unknown,
): Promise<Response> {
  const ms = timeoutMs();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Core-Key": key },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new CoreClientError(core, op, 0, `pas de réponse après ${ms} ms`, "timeout");
    }
    const cause = (e as { cause?: unknown })?.cause;
    const detail = String(cause instanceof Error ? cause.message : cause ?? (e as Error)?.message ?? e).slice(0, 300);
    throw new CoreClientError(core, op, 0, detail, "network");
  }
  if (!res.ok) {
    throw new CoreClientError(core, op, res.status, await safeText(res), "http");
  }
  return res;
}

const httpCompta: ComptaClient = {
  async createInvoice(input) {
    const res = await postJson("compta", "createInvoice", `${comptaUrl()}/api/invoices`, comptaKey(), {
      tenantId: input.tenantId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      clientName: input.clientName ?? undefined,
      lines: input.lines,
    });
    return (await res.json()) as CreateInvoiceResult;
  },

  async settle(input) {
    const res = await postJson("compta", "settle", `${comptaUrl()}/api/settle`, comptaKey(), {
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      amountXpf: input.amountXpf,
      method: input.method,
      paymentRef: input.paymentRef,
    });
    return (await res.json()) as SettleResult;
  },

  receiptUrl(invoiceId, tenantId) {
    return `${comptaUrl()}/api/invoices/${invoiceId}/receipt?tenantId=${encodeURIComponent(tenantId)}`;
  },
};

const httpStock: StockClient = {
  async recordSale(input) {
    const res = await postJson("stock", "recordSale", `${stockUrl()}/api/movements`, stockKey(), {
      tenantId: input.tenantId,
      productId: input.productId,
      type: "SALE",
      qty: input.qty,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      actorId: input.actorId,
    });
    return (await res.json()) as MovementResult;
  },
};

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}

// ─── Implémentation MOCK (en mémoire, idempotente par processus) ─────────────
const mockInvoices = new Map<string, CreateInvoiceResult>(); // clé: tenantId|sourceType|sourceId
const mockSettled = new Map<string, number>(); // clé: paymentRef → montant (idempotence)
const mockMovements = new Map<string, MovementResult>(); // clé: tenantId|sourceType|sourceId|productId
let mockSeq = 0;
const nextId = (p: string) => `${p}-mock-${(++mockSeq).toString().padStart(6, "0")}`;

const mockCompta: ComptaClient = {
  async createInvoice(input) {
    const key = `${input.tenantId}|${input.sourceType}|${input.sourceId}`;
    const existing = mockInvoices.get(key);
    if (existing) return { ...existing, alreadyExisted: true };
    const total = input.lines.reduce((t, l) => t + Math.round(l.unitXpf) * l.qty, 0);
    const created: CreateInvoiceResult = {
      invoiceId: nextId("inv"),
      number: `MOCK-${new Date().getFullYear()}-${(mockSeq).toString().padStart(4, "0")}`,
      totalXpf: total,
      alreadyExisted: false,
    };
    mockInvoices.set(key, created);
    return created;
  },

  async settle(input) {
    const prior = mockSettled.get(input.paymentRef);
    if (prior !== undefined) {
      // idempotent : déjà encaissé sous ce ref
      const paid = sumSettledForInvoice(input.invoiceId);
      return { ok: true, invoiceId: input.invoiceId, paid, remaining: 0 };
    }
    mockSettled.set(input.paymentRef, input.amountXpf);
    mockSettledByInvoice(input.invoiceId).push(input.amountXpf);
    const paid = sumSettledForInvoice(input.invoiceId);
    return { ok: true, invoiceId: input.invoiceId, paid, remaining: 0 };
  },

  receiptUrl(invoiceId, tenantId) {
    return `${comptaUrl()}/api/invoices/${invoiceId}/receipt?tenantId=${encodeURIComponent(tenantId)}`;
  },
};

const mockInvoicePayments = new Map<string, number[]>();
const mockSettledByInvoice = (invoiceId: string) => {
  let arr = mockInvoicePayments.get(invoiceId);
  if (!arr) {
    arr = [];
    mockInvoicePayments.set(invoiceId, arr);
  }
  return arr;
};
const sumSettledForInvoice = (invoiceId: string) =>
  (mockInvoicePayments.get(invoiceId) ?? []).reduce((t, n) => t + n, 0);

const mockStock: StockClient = {
  async recordSale(input) {
    const key = `${input.tenantId}|${input.sourceType}|${input.sourceId}|${input.productId}`;
    const existing = mockMovements.get(key);
    if (existing) return { ...existing, alreadyExisted: true };
    const created: MovementResult = {
      ok: true,
      movementId: nextId("mv"),
      productId: input.productId,
      qtyOnHand: 0,
      alreadyExisted: false,
    };
    mockMovements.set(key, created);
    return created;
  },
};

// ─── Sélecteurs ──────────────────────────────────────────────────────────────
export function comptaClient(): ComptaClient {
  return mockEnabled() ? mockCompta : httpCompta;
}

export function stockClient(): StockClient {
  return mockEnabled() ? mockStock : httpStock;
}

export function clientsAreMocked(): boolean {
  return mockEnabled();
}
