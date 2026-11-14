// lib/maquette.ts — démo privée : copie « maquette » d'un prospect (tenant Core-Auth au stade
// maquette, hôte demo-<slug>.pacificode.nc, effacé 30 jours après sa création).
//
// Module PUR (dépendances injectées) : vérification auprès de Core-Auth, clé de service dédiée,
// validation du jeu de démonstration et plan déterministe du semis. Les routes /api/maquette/semer et
// /api/maquette/effacer câblent Prisma (lib/maquette-semis.ts pour l'écriture des journées).
//
// Garde-fous :
//   · rien n'est semé ni effacé sans que Core-Auth dise, À L'INSTANT, que le tenant est une maquette
//     (et que son échéance est dans le bon sens) — tout doute = STADE_INCONNU, on ne fait rien ;
//   · la clé MAQUETTE_API_KEY n'ouvre QUE ces deux routes ; une clé générale ne les ouvre pas, et la
//     clé maquette est refusée par le contrôle général (lib/service-auth.ts, lib/cles-service.ts) ;
//   · l'inscription et l'effacement sont portés par la base (inscrire_tenant_maquette /
//     effacer_tenant_maquette, migration 20261111130000_tenant_maquette).
// Argent : XPF entiers, jamais de centimes. Ventes fictives seulement.

import { createHash } from "node:crypto";
import { egalTempsConstant, motifCleMaquetteRefusee } from "./cles-service.ts";

export const HOTE_DEMO = /^demo-[a-z0-9-]+\.pacificode\.nc$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELAI_CORE_AUTH_MS = 5_000;

export type Maquette = { hote: string; expiresAt: Date };
export type RefusMaquette = "NON_MAQUETTE" | "EXPIREE" | "PAS_ENCORE_EXPIREE" | "HOTE_NON_CONFORME" | "STADE_INCONNU";
export type Verdict = { ok: true; maquette: Maquette } | { ok: false; refus: RefusMaquette };

export type DepsCoreAuth = {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  maintenant?: () => Date;
};

export const estUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/**
 * Lit le stade maquette d'un tenant auprès de Core-Auth (projection publique, SANS clé). Lève sur
 * toute réponse douteuse (statut ≠ 200, JSON illisible, autre tenant, champ mal formé).
 * `null` = Core-Auth ne déclare pas de maquette pour ce tenant.
 */
export async function lireMaquette(tenantId: string, deps: DepsCoreAuth = {}): Promise<Maquette | null> {
  if (!estUuid(tenantId)) throw new Error("MAQUETTE_TENANT_INVALIDE");
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const base = env.CORE_AUTH_URL ?? "http://localhost:3102";
  const res = await doFetch(`${base}/api/tenant?tenantId=${encodeURIComponent(tenantId)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(DELAI_CORE_AUTH_MS),
  });
  if (res.status !== 200) throw new Error(`MAQUETTE_CORE_AUTH_STATUT_${res.status}`);
  let corps: unknown;
  try {
    corps = await res.json();
  } catch {
    throw new Error("MAQUETTE_CORE_AUTH_ILLISIBLE");
  }
  if (typeof corps !== "object" || corps === null) throw new Error("MAQUETTE_CORE_AUTH_ILLISIBLE");
  const c = corps as { id?: unknown; maquette?: unknown };
  if (typeof c.id !== "string" || c.id.toLowerCase() !== tenantId.toLowerCase()) throw new Error("MAQUETTE_CORE_AUTH_AUTRE_TENANT");
  if (c.maquette === undefined || c.maquette === null) return null;
  const m = c.maquette as { hote?: unknown; expiresAt?: unknown };
  if (typeof m !== "object" || typeof m.hote !== "string" || typeof m.expiresAt !== "string") {
    throw new Error("MAQUETTE_CORE_AUTH_FORME");
  }
  const expiresAt = new Date(m.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) throw new Error("MAQUETTE_CORE_AUTH_FORME");
  return { hote: m.hote, expiresAt };
}

async function verifier(tenantId: string, deps: DepsCoreAuth, sens: "semer" | "effacer"): Promise<Verdict> {
  let maquette: Maquette | null;
  try {
    maquette = await lireMaquette(tenantId, deps);
  } catch {
    return { ok: false, refus: "STADE_INCONNU" };
  }
  if (!maquette) return { ok: false, refus: "NON_MAQUETTE" };
  if (!HOTE_DEMO.test(maquette.hote)) return { ok: false, refus: "HOTE_NON_CONFORME" };
  const maintenant = (deps.maintenant ?? (() => new Date()))().getTime();
  const echeance = maquette.expiresAt.getTime();
  if (sens === "semer" && !(echeance > maintenant)) return { ok: false, refus: "EXPIREE" };
  if (sens === "effacer" && !(echeance < maintenant)) return { ok: false, refus: "PAS_ENCORE_EXPIREE" };
  return { ok: true, maquette };
}

/** Semis permis : maquette, échéance FUTURE, hôte demo-*.pacificode.nc. */
export const verifierPourSemer = (tenantId: string, deps: DepsCoreAuth = {}) => verifier(tenantId, deps, "semer");
/** Effacement permis : maquette, échéance PASSÉE, hôte demo-*.pacificode.nc. */
export const verifierPourEffacer = (tenantId: string, deps: DepsCoreAuth = {}) => verifier(tenantId, deps, "effacer");

/** Statut HTTP d'un refus : STADE_INCONNU = 503, échéance pas encore passée à l'effacement = 409, sinon 403. */
export function statutRefus(refus: RefusMaquette, sens: "semer" | "effacer"): number {
  if (refus === "STADE_INCONNU") return 503;
  if (sens === "effacer" && refus === "PAS_ENCORE_EXPIREE") return 409;
  return 403;
}

// ── Clé de service dédiée ────────────────────────────────────────────────────────────────────────

/**
 * Contrôle de la clé des routes /api/maquette/* : seule MAQUETTE_API_KEY (X-Core-Key, temps constant).
 * Variable absente, courte ou en collision → 401 (mal
 * configuré : même refus qu'une clé invalide).
 */
export function checkCleMaquette(req: { headers: Headers }, env: Record<string, string | undefined> = process.env): { ok: true } | { ok: false; status: 401 | 503 } {
  const motif = motifCleMaquetteRefusee(env);
  if (motif) {
    console.warn(`maquette_cle_refusee motif=${motif}`);
    return { ok: false, status: 401 };
  }
  const attendue = env.MAQUETTE_API_KEY!;
  const cle = req.headers.get("x-core-key");
  if (!cle || !egalTempsConstant(cle, attendue)) return { ok: false, status: 401 };
  return { ok: true };
}

// ── Jeu de démonstration ─────────────────────────────────────────────────────────────────────────

export type ArticleJeu = { nom: string; prix: number; tgc: number };
export type Jeu = { articles: ArticleJeu[]; ticketsParJour: { min: number; max: number }; jours: number };
export type CorpsSemer = { tenantId: string; jeu: Jeu };

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clesConnues = (o: Record<string, unknown>, permises: string[]) => Object.keys(o).every((k) => permises.includes(k));
const entier = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Valide le corps de POST /api/maquette/semer. Tout champ inconnu, toute borne dépassée → erreur (400). */
export function validerCorpsSemer(corps: unknown): { ok: true; valeur: CorpsSemer } | { ok: false; erreur: string } {
  const ko = (erreur: string) => ({ ok: false as const, erreur });
  if (!estObjet(corps) || !clesConnues(corps, ["tenantId", "jeu"])) return ko("corps : champs attendus tenantId, jeu");
  if (!estUuid(corps.tenantId)) return ko("tenantId : UUID attendu");
  const jeu = corps.jeu;
  if (!estObjet(jeu) || !clesConnues(jeu, ["articles", "ticketsParJour", "jours"])) return ko("jeu : champs attendus articles, ticketsParJour, jours");
  if (!Array.isArray(jeu.articles) || jeu.articles.length < 1 || jeu.articles.length > 60) return ko("jeu.articles : 1 à 60");
  const articles: ArticleJeu[] = [];
  for (const [i, a] of jeu.articles.entries()) {
    if (!estObjet(a) || !clesConnues(a, ["nom", "prix", "tgc"])) return ko(`articles[${i}] : champ inconnu`);
    if (typeof a.nom !== "string" || a.nom.trim().length < 1 || a.nom.trim().length > 80) return ko(`articles[${i}].nom : 1 à 80 caractères`);
    if (!entier(a.prix, 1, 10_000_000)) return ko(`articles[${i}].prix : entier XPF 1 à 10 000 000`);
    if (typeof a.tgc !== "number" || !Number.isFinite(a.tgc) || a.tgc < 0 || a.tgc > 30) return ko(`articles[${i}].tgc : 0 à 30`);
    articles.push({ nom: a.nom.trim(), prix: a.prix, tgc: a.tgc });
  }
  const tpj = jeu.ticketsParJour;
  if (!estObjet(tpj) || !clesConnues(tpj, ["min", "max"])) return ko("jeu.ticketsParJour : champs attendus min, max");
  if (!entier(tpj.min, 0, 40)) return ko("jeu.ticketsParJour.min : entier 0 à 40");
  if (!entier(tpj.max, tpj.min, 40)) return ko("jeu.ticketsParJour.max : entier min à 40");
  if (jeu.jours !== undefined && !entier(jeu.jours, 1, 30)) return ko("jeu.jours : entier 1 à 30");
  const jours = jeu.jours === undefined ? 30 : (jeu.jours as number);
  return { ok: true, valeur: { tenantId: corps.tenantId.toLowerCase(), jeu: { articles, ticketsParJour: { min: tpj.min, max: tpj.max }, jours } } };
}

// ── Plan déterministe du semis ───────────────────────────────────────────────────────────────────

/** Générateur pseudo-aléatoire déterministe (mulberry32), graine = empreinte du tenantId. */
export function aleaDeterministe(graine: string): () => number {
  let a = createHash("sha256").update(graine.toLowerCase(), "utf8").digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECALAGE_NC_MS = 11 * 3_600_000; // jour métier = UTC+11 (cf. lib/cash-day-projection.ts#businessDay)
const JOUR_MS = 86_400_000;

export type LignePlan = { nom: string; qty: number; unitXpf: number; tgcRatePpm: number };
export type TicketPlan = { a: Date; lignes: LignePlan[]; totalXpf: number; moyen: "CASH" | "CARD" };
export type JourneePlan = { businessDay: string; ouverture: Date; cloture: Date; fondXpf: number; tickets: TicketPlan[] };

/** Jour métier (AAAA-MM-JJ, heure de Nouméa) d'un instant. */
export function jourMetier(d: Date): string {
  return new Date(d.getTime() + DECALAGE_NC_MS).toISOString().slice(0, 10);
}

/**
 * Plan des `jours` derniers jours métier (aujourd'hui EXCLU), du plus ancien au plus récent :
 * ouverture 07:00, tickets entre 08:00 et 18:00, clôture 19:00 (heure de Nouméa) ; min–max tickets
 * par jour, 1 à 3 lignes par ticket tirées des articles, espèces ou carte. Montants XPF entiers.
 */
export function planifierSemis(jeu: Jeu, tenantId: string, maintenant: Date, fondXpf = 25_000): JourneePlan[] {
  const alea = aleaDeterministe(tenantId);
  const tirer = (min: number, max: number) => min + Math.floor(alea() * (max - min + 1));
  const aujourdhui = Date.parse(`${jourMetier(maintenant)}T00:00:00Z`);
  const plan: JourneePlan[] = [];
  for (let k = jeu.jours; k >= 1; k--) {
    const minuitUtc = aujourdhui - k * JOUR_MS;
    const businessDay = new Date(minuitUtc).toISOString().slice(0, 10);
    const debut = minuitUtc - DECALAGE_NC_MS; // minuit à Nouméa, en UTC
    const n = tirer(jeu.ticketsParJour.min, jeu.ticketsParJour.max);
    const instants: number[] = [];
    for (let i = 0; i < n; i++) instants.push(debut + 8 * 3_600_000 + tirer(0, 10 * 3_600 - 1) * 1000);
    instants.sort((x, y) => x - y);
    const tickets: TicketPlan[] = instants.map((t) => {
      const nbLignes = tirer(1, 3);
      const lignes: LignePlan[] = [];
      for (let j = 0; j < nbLignes; j++) {
        const art = jeu.articles[tirer(0, jeu.articles.length - 1)];
        lignes.push({ nom: art.nom, qty: tirer(1, 2), unitXpf: art.prix, tgcRatePpm: Math.round(art.tgc * 10_000) });
      }
      const totalXpf = lignes.reduce((s, l) => s + l.unitXpf * l.qty, 0);
      return { a: new Date(t), lignes, totalXpf, moyen: alea() < 0.5 ? "CASH" : "CARD" };
    });
    plan.push({ businessDay, ouverture: new Date(debut + 7 * 3_600_000), cloture: new Date(debut + 19 * 3_600_000), fondXpf, tickets });
  }
  return plan;
}

/** Code MAQUETTE_* d'une exception levée par la base, ou null. */
export function codeMaquette(err: unknown): string | null {
  const m = /MAQUETTE_[A-Z_]+/.exec(String((err as Error)?.message ?? err));
  return m ? m[0] : null;
}

/**
 * Dépassement de lock_timeout (SQLSTATE 55P03 : une caisse tient un verrou) ou de statement_timeout
 * (57014), ou sérialisation concurrente (40001 / Prisma P2034) → 503 CAISSE_OCCUPEE.
 */
export function estVerrouOccupe(err: unknown): boolean {
  const texte = String((err as Error)?.message ?? err) + JSON.stringify((err as { meta?: unknown })?.meta ?? null);
  return /55P03|57014|40001|P2034|could not serialize|lock timeout|statement timeout/i.test(texte + String((err as { code?: unknown })?.code ?? ""));
}
