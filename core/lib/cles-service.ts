import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server.js";

export type Appelant = { nom: string; tenants: string[] };
export type ContexteAppel = {
  appelant: string; tenants: string[]; historique: boolean; route: string;
  compte: boolean; journalises: Set<string>; empreinte: Buffer;
};
type Entree = Appelant & { empreinte: Buffer };
type Requete = { nextUrl?: { pathname: string }; url: string };
let memo: { brut: string | undefined; entrees: Entree[] } | null = null;
let erreurSignalee = false;
const als = new AsyncLocalStorage<ContexteAppel>();
let contextes = new WeakMap<object, ContexteAppel>();
const compteurs = new Map<string, { contexte: ContexteAppel; tenant: string; verdict: string; n: number }>();
let total = 0;
let minuterie: ReturnType<typeof setInterval> | undefined;

function lireCles(): Entree[] {
  const brut = process.env.SERVICE_KEYS_JSON;
  if (memo && memo.brut === brut) return memo.entrees;
  let entrees: Entree[] = [];
  if (brut?.trim()) {
    try {
      const obj: unknown = JSON.parse(brut);
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new Error("forme");
      for (const [nom, valeur] of Object.entries(obj)) {
        if (typeof valeur !== "object" || valeur === null || Array.isArray(valeur)) throw new Error("forme");
        const e = valeur as { sha256?: unknown; tenants?: unknown };
        if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(e.sha256)) throw new Error("forme");
        if (!Array.isArray(e.tenants) || !e.tenants.every((t) => typeof t === "string")) throw new Error("forme");
        if (e.tenants.length) entrees.push({ nom, empreinte: Buffer.from(e.sha256, "hex"), tenants: e.tenants });
      }
    } catch {
      entrees = [];
      if (!erreurSignalee) {
        erreurSignalee = true;
        console.error("[cles-service] SERVICE_KEYS_JSON illisible");
      }
    }
  }
  memo = { brut, entrees };
  return entrees;
}

export function identifierCle(cle: string | null | undefined): Appelant | null {
  if (!cle) return null;
  const h = createHash("sha256").update(cle, "utf8").digest();
  let trouve: Entree | undefined;
  for (const e of lireCles()) {
    if (timingSafeEqual(e.empreinte, h)) trouve ??= e;
  }
  return trouve ? { nom: trouve.nom, tenants: [...trouve.tenants] } : null;
}

export function egalTempsConstant(a: string, b: string): boolean {
  try {
    return timingSafeEqual(createHash("sha256").update(a, "utf8").digest(), createHash("sha256").update(b, "utf8").digest());
  } catch { return false; }
}
export function clesNominativesPosees(): boolean { return lireCles().length > 0; }
export function cleHistoriqueAcceptee(): boolean { return process.env.SERVICE_KEY_LEGACY_OK !== "0"; }
export function modeCles(): "journal" | "applique" {
  return process.env.SERVICE_KEYS_MODE?.trim().toLowerCase() === "applique" ? "applique" : "journal";
}

export function routeNormalisee(chemin: string): string {
  try {
    const pathname = new URL(chemin, "http://service.invalid").pathname;
    return pathname.split("/").map((s) => /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(s) ? ":id" : s).join("/");
  } catch { return ""; }
}

export function entrerAppel(req: Requete, appelant: Appelant | null, cle: string): void {
  let route = "";
  try { route = routeNormalisee(req.nextUrl?.pathname ?? new URL(req.url).pathname); } catch { /* URL illisible */ }
  const ctx: ContexteAppel = {
    appelant: appelant?.nom ?? "historique", tenants: [...(appelant?.tenants ?? ["*"])],
    historique: appelant === null, route, compte: false, journalises: new Set(),
    empreinte: createHash("sha256").update(cle, "utf8").digest(),
  };
  als.enterWith(ctx);
  contextes.set(req, ctx);
}
function dansPortee(ctx: ContexteAppel, tenant: string): boolean {
  return ctx.tenants.includes("*") || ctx.tenants.includes(tenant);
}
function journaliserHorsPortee(ctx: ContexteAppel, tenant: string): void {
  if (ctx.journalises.has(tenant)) return;
  ctx.journalises.add(tenant);
  console.warn(`[cles-service] HORS_PORTEE appelant=${ctx.appelant} tenant=${tenant} route=${ctx.route}`);
}
export class HorsPorteeError extends Error {
  constructor() { super("HORS_PORTEE"); this.name = "HORS_PORTEE"; }
}
export function horsPortee(req: object, tenantId: string | null | undefined): NextResponse | null {
  const ctx = contextes.get(req);
  if (!ctx || !tenantId || !clesNominativesPosees() || dansPortee(ctx, tenantId)) return null;
  journaliserHorsPortee(ctx, tenantId);
  return modeCles() === "applique" ? NextResponse.json({ error: "HORS_PORTEE" }, { status: 403 }) : null;
}
export function viderJournal(): void {
  if (clesNominativesPosees()) {
    for (const { contexte: c, tenant, verdict, n } of compteurs.values()) {
      console.info(`[cles-service] SYNTHESE appelant=${c.appelant} tenant=${tenant} route=${c.route} verdict=${verdict} n=${n}`);
    }
  }
  compteurs.clear();
  total = 0;
}
export async function verifierPortee(tenantId: string, lireCle: () => Promise<string | null>): Promise<void> {
  const ctx = als.getStore();
  if (!ctx || !tenantId || !clesNominativesPosees()) return;
  const cle = await lireCle();
  // Node 20/22 : enterWith déborde sur le contexte parent ; un contexte ne vaut que pour la requête qui porte la même clé.
  if (!cle || !timingSafeEqual(createHash("sha256").update(cle, "utf8").digest(), ctx.empreinte)) return;
  if (!dansPortee(ctx, tenantId)) {
    journaliserHorsPortee(ctx, tenantId);
    if (modeCles() === "applique") throw new HorsPorteeError();
    return;
  }
  if (ctx.compte) return;
  ctx.compte = true;
  const verdict = ctx.historique ? "historique" : "ok";
  const cleCompteur = JSON.stringify([ctx.appelant, tenantId, ctx.route, verdict]);
  const compteur = compteurs.get(cleCompteur);
  if (compteur) compteur.n++;
  else compteurs.set(cleCompteur, { contexte: ctx, tenant: tenantId, verdict, n: 1 });
  total++;
  minuterie ??= setInterval(viderJournal, 60_000).unref();
  if (total >= 1_000) viderJournal();
}
/** Pour les tests : oublie contextes, memo et journaux en attente. */
export function reinitialiserClesService(): void {
  memo = null;
  erreurSignalee = false;
  compteurs.clear();
  total = 0;
  if (minuterie) clearInterval(minuterie);
  minuterie = undefined;
  contextes = new WeakMap();
  als.disable();
}
