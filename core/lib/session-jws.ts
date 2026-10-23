// session-jws.ts — vérification des sessions signées par Core-Auth (JWS EdDSA, Ed25519).
//
// Chantier AUTH_SECRET, étapes 1-2 (« double acceptation ») : la clé publique d'abord, l'ancien
// secret partagé en repli. SANS AUTH_PUBLIC_KEY ni AUTH_PUBLIC_KEY_CABINET, décodage et
// encodage restent exactement ceux d'aujourd'hui ; le chemin (secret/refus) est journalisé.
//
// Source unique : 00-Archi-NextGen/_routine/ops/auth-jws/session-jws.ts. Chaque lecteur en garde
// une COPIE IDENTIQUE (lib/session-jws.ts) : on ne l'adapte pas sur place, on corrige la source
// puis on recopie. Le câblage propre au dépôt (auth.ts, secrets-session.ts) vit à côté.
//
// Contrat du jeton (figé à l'étape 0 ; Core-Auth le signera à l'étape 2) :
//   en-tête : { alg: "EdDSA", typ: "JWT" } (kid facultatif, ignoré : chaque clé posée est essayée)
//   claims  : iss = "core-auth", aud = "pacificode:session", exp obligatoire,
//             plus les claims de session habituels (sub, tenantId, role, tk, sv, fs…).
//   L'audience distingue une session d'un futur jeton de service (volet B, aud = <core>).
// Clés publiques (non secrètes) : AUTH_PUBLIC_KEY (commun) et AUTH_PUBLIC_KEY_CABINET (tenants
//   kind="cabinet", posée seulement là où AUTH_SECRET_CABINET l'est aujourd'hui). Chacune : une
//   liste, séparée par des virgules, de la coordonnée `x` (base64url, 43 caractères) d'une clé
//   Ed25519. Deux entrées = rotation en cours.
// Contrôles ajoutés à l'étape 2 :
//   1. L'en-tête typ doit être JWT, avec l'algorithme EdDSA.
//   2. fs, si présent, doit être un nombre fini et non dépassé au-delà de la tolérance.
//   3. Une clé cabinet sans AUTH_SECRET_CABINET non vide est ignorée et signalée.
//   4. Une coordonnée x commune aux deux listes reste seulement dans le lot commun.
//   5. Une clé cabinet n'accepte que les jetons dont tk vaut cabinet.
// Journal : « [auth-jws] chemin=<chemin> n=<nombre> », agrégé par fenêtre de 10 min et par
//   processus. Jamais une valeur de clé ni de jeton.
//
// Un lecteur ne peut pas signer : un jeton vérifié par la clé publique est rendu TEL QUEL à
// l'encodage (le cookie garde la signature de Core-Auth). S'il a été modifié entre-temps (rappel
// `jwt` du lecteur), on retombe sur l'encodage d'aujourd'hui et le journal le dit (reemis-secret).

import { importJWK, jwtVerify } from "jose";

export const EMETTEUR_SESSION = "core-auth";
export const AUDIENCE_SESSION = "pacificode:session";
export const EN_TETE_SESSION = { alg: "EdDSA", typ: "JWT" } as const;
const ALGORITHMES = [EN_TETE_SESSION.alg];
export const TOLERANCE_HORLOGE_S = 15; // même tolérance que le décodage NextAuth
const FORMAT_X = /^[A-Za-z0-9_-]{43}$/;

type Env = Record<string, string | undefined>;
export type TypeCle = "commun" | "cabinet";
export type JetonVerifie = { payload: Record<string, unknown>; type: TypeCle };
export type Chemin =
  | "publique" // vérifié par AUTH_PUBLIC_KEY
  | "publique-cabinet" // vérifié par AUTH_PUBLIC_KEY_CABINET
  | "secret" // repli : accepté par l'ancien secret partagé
  | "refus" // ni l'un ni l'autre
  | "jws-refuse" // jeton signé présenté, refusé par toutes les clés posées
  | "reemis-secret" // jeton signé modifié par le lecteur, réémis avec l'ancien secret
  | "cle-cabinet-sans-secret" // clé cabinet ignorée faute de secret cabinet
  | "cle-doublon" // coordonnée commune aux deux listes, conservée en commun seulement
  | "signe" // session signée par Core-Auth avec la clé commune
  | "signe-cabinet" // session signée par Core-Auth avec la clé cabinet
  | "signature-impossible" // Core-Auth conserve l'encodage d'aujourd'hui faute de signature possible
  | "cle-illisible"; // une entrée de AUTH_PUBLIC_KEY* n'est pas une clé Ed25519

// ---------------------------------------------------------------- journal

const FENETRE_JOURNAL_MS = 10 * 60 * 1000;
const compteurs = new Map<Chemin, { n: number; depuis: number }>();
let ecrire: (ligne: string) => void = (ligne) => console.info(ligne);

/** Compte un passage par `chemin` ; écrit la 1re fois, puis le cumul toutes les 10 min. */
export function noterChemin(chemin: Chemin, maintenant: number = Date.now()): void {
  const c = compteurs.get(chemin);
  if (!c) {
    compteurs.set(chemin, { n: 0, depuis: maintenant });
    ecrire(`[auth-jws] chemin=${chemin} n=1`);
    return;
  }
  c.n += 1;
  if (maintenant - c.depuis >= FENETRE_JOURNAL_MS) {
    ecrire(`[auth-jws] chemin=${chemin} n=${c.n}`);
    c.n = 0;
    c.depuis = maintenant;
  }
}

// ---------------------------------------------------------------- clés

type CleImportee = Awaited<ReturnType<typeof importJWK>>;
type Cle = { cle: CleImportee; type: TypeCle };
let cacheCles: { brut: string; cles: Promise<Cle[]> } | null = null;

export function clesListees(valeur: string | undefined): string[] {
  return (valeur ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Vrai si au moins une clé publique est posée : sinon, rien ne change. */
export function clesPubliquesPosees(env: Env = process.env): boolean {
  const cabinet = clesListees(env.AUTH_PUBLIC_KEY_CABINET);
  if (cabinet.length > 0 && !regimeCabinetPose(env)) noterChemin("cle-cabinet-sans-secret");
  return clesListees(env.AUTH_PUBLIC_KEY).length + (regimeCabinetPose(env) ? cabinet.length : 0) > 0;
}

/** Vrai si le régime cabinet est actif (secret cabinet non vide). */
export function regimeCabinetPose(env: Env = process.env): boolean {
  return Boolean(env.AUTH_SECRET_CABINET);
}

function chargerCles(env: Env): Promise<Cle[]> {
  const cabinetPose = regimeCabinetPose(env);
  const brut = `${cabinetPose ? 1 : 0}|${env.AUTH_PUBLIC_KEY_CABINET ?? ""}|${env.AUTH_PUBLIC_KEY ?? ""}`;
  if (cacheCles?.brut === brut) return cacheCles.cles;
  const lots: [TypeCle, string | undefined][] = [
    ["cabinet", cabinetPose ? env.AUTH_PUBLIC_KEY_CABINET : undefined],
    ["commun", env.AUTH_PUBLIC_KEY],
  ];
  const cles = (async () => {
    const out: Cle[] = [];
    const communes = new Set(clesListees(env.AUTH_PUBLIC_KEY));
    for (const [type, valeur] of lots) {
      for (const x of clesListees(valeur)) {
        if (type === "cabinet" && communes.has(x)) {
          noterChemin("cle-doublon");
          continue;
        }
        if (!FORMAT_X.test(x)) {
          noterChemin("cle-illisible");
          continue;
        }
        try {
          out.push({ cle: await importJWK({ kty: "OKP", crv: "Ed25519", x }, "EdDSA"), type });
        } catch {
          noterChemin("cle-illisible");
        }
      }
    }
    return out;
  })();
  cacheCles = { brut, cles };
  return cles;
}

function formeJws(jeton: string): boolean {
  const parties = jeton.split(".");
  return parties.length === 3 && parties.every((p) => p.length > 0);
}

/**
 * Vérifie un jeton de session signé par Core-Auth. `null` : aucune clé posée, pas un JWS
 * (une session chiffrée d'aujourd'hui, par exemple), ou refusé par toutes les clés.
 */
export async function verifierSessionJws(
  jeton: string | undefined | null,
  env: Env = process.env,
): Promise<JetonVerifie | null> {
  if (!jeton || !clesPubliquesPosees(env) || !formeJws(jeton)) return null;
  for (const c of await chargerCles(env)) {
    try {
      const { payload } = await jwtVerify(jeton, c.cle, {
        algorithms: ALGORITHMES,
        typ: EN_TETE_SESSION.typ,
        issuer: EMETTEUR_SESSION,
        audience: AUDIENCE_SESSION,
        requiredClaims: ["exp"],
        clockTolerance: TOLERANCE_HORLOGE_S,
      });
      if (payload.fs !== undefined && (
        typeof payload.fs !== "number" || !Number.isFinite(payload.fs) ||
        Math.floor(Date.now() / 1000) > payload.fs + TOLERANCE_HORLOGE_S
      )) continue;
      if (c.type === "cabinet" && payload.tk !== "cabinet") continue;
      return { payload: payload as Record<string, unknown>, type: c.type };
    } catch {
      // Clé suivante.
    }
  }
  noterChemin("jws-refuse");
  return null;
}

// ---------------------------------------------------------------- jeton rendu tel quel

const jetonsSignes = new WeakMap<object, { jeton: string; empreinte: string }>();

/** Retient le jeton signé d'où vient `payload`, pour le rendre tel quel à l'encodage. */
export function retenirJetonSigne(payload: object, jeton: string): void {
  jetonsSignes.set(payload, { jeton, empreinte: JSON.stringify(payload) });
}

/**
 * Le jeton signé d'origine si `payload` en vient et n'a pas été modifié ; sinon `undefined`
 * (l'appelant encode alors comme aujourd'hui).
 */
export function jetonSigneDe(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const retenu = jetonsSignes.get(payload);
  if (!retenu) return undefined;
  if (JSON.stringify(payload) === retenu.empreinte) return retenu.jeton;
  noterChemin("reemis-secret");
  return undefined;
}

// ---------------------------------------------------------------- briques de câblage

/**
 * Pour un décodeur existant (multi-secrets ou non) : essaie la clé publique. En cas de succès,
 * note le chemin et retient le jeton. `null` → l'appelant poursuit avec l'ancien secret.
 */
export async function essayerClePublique(
  jeton: string | undefined | null,
  env: Env = process.env,
): Promise<JetonVerifie | null> {
  const verifie = await verifierSessionJws(jeton, env);
  if (!verifie || !jeton) return null;
  noterChemin(verifie.type === "cabinet" ? "publique-cabinet" : "publique");
  retenirJetonSigne(verifie.payload, jeton);
  return verifie;
}

/** À appeler après le repli sur l'ancien secret : journalise toujours, clé posée ou non. */
export function noterRepli(accepte: boolean, _env: Env = process.env): void {
  noterChemin(accepte ? "secret" : "refus");
}

/**
 * `jwt.decode` NextAuth : la clé publique d'abord, puis `repli` (le décodage d'aujourd'hui).
 * Sans clé publique posée, appelle `repli` tel quel, en journalisant le chemin.
 */
export function decodeurAvecRepli<P extends { token?: string }, J extends object>(
  repli: (p: P) => Promise<J | null>,
  lireEnv: () => Env = () => process.env,
): (p: P) => Promise<J | null> {
  return async (p) => {
    const env = lireEnv();
    if (!clesPubliquesPosees(env)) {
      let r0: J | null;
      try {
        r0 = await repli(p);
      } catch (e) {
        noterRepli(false, env);
        throw e;
      }
      noterRepli(Boolean(r0), env);
      return r0;
    }
    const verifie = await essayerClePublique(p.token, env);
    if (verifie) return verifie.payload as J;
    let r: J | null;
    try {
      r = await repli(p);
    } catch (e) {
      noterRepli(false, env); // le décodage d'aujourd'hui lève sur un mauvais secret : il lève encore
      throw e;
    }
    noterRepli(Boolean(r), env);
    return r;
  };
}

/** `jwt.encode` NextAuth : rend tel quel un jeton vérifié par la clé publique, sinon `repli`. */
export function encodeurAvecRepli<P extends { token?: unknown }>(
  repli: (p: P) => Promise<string>,
): (p: P) => Promise<string> {
  return async (p) => jetonSigneDe(p.token) ?? repli(p);
}

// ---------------------------------------------------------------- tests

/** Réservé aux tests : capte le journal et remet l'état du module à zéro. */
export function __pourTests(capteur?: (ligne: string) => void): void {
  ecrire = capteur ?? ((ligne) => console.info(ligne));
  compteurs.clear();
  cacheCles = null;
}
