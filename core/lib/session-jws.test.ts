// session-jws.test.ts — paire Ed25519 FACTICE, générée ici à chaque exécution : jamais une vraie
// clé, rien n'est écrit sur disque. Copie identique dans chaque lecteur (lib/session-jws.test.ts),
// à DEUX lignes près, selon le lanceur du dépôt : l'import du lanceur (« vitest » ou « node:test »)
// et le chemin du module (« ./session-jws » ou « ./session-jws.ts »). Rien d'autre ne change.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompactSign, exportJWK, generateKeyPair, SignJWT } from "jose";
import { decode, encode, type JWT, type JWTDecodeParams, type JWTEncodeParams } from "next-auth/jwt";
import {
  AUDIENCE_SESSION,
  EMETTEUR_SESSION,
  TOLERANCE_HORLOGE_S,
  __pourTests,
  clesPubliquesPosees,
  decodeurAvecRepli,
  encodeurAvecRepli,
  noterChemin,
  regimeCabinetPose,
  verifierSessionJws,
} from "./session-jws.ts";

const SEL = "authjs.session-token";
// Type de clé privée sans dépendre de la version de jose (5 : KeyLike, 6 : CryptoKey).
type ClePrivee = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
// Secrets factices à faible entropie : rien qui ressemble à une vraie clé (gitleaks).
const SECRET_FACTICE = "factice-".repeat(6);
const AUTRE_SECRET_FACTICE = "autre-factice-".repeat(4);

let journal: string[] = [];
beforeEach(() => {
  journal = [];
  __pourTests((ligne) => journal.push(ligne));
});

async function paireFactice(): Promise<{ x: string; privee: ClePrivee }> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const { x } = await exportJWK(publicKey);
  return { x: x as string, privee: privateKey };
}

type Options = { iss?: string | null; aud?: string | null; exp?: number | string | null; typ?: string | null };
async function signer(privee: ClePrivee, claims: Record<string, unknown> = {}, o: Options = {}): Promise<string> {
  let j = new SignJWT({ sub: "u1", tenantId: "t1", role: "ADMIN", ...claims })
    .setProtectedHeader({ alg: "EdDSA", ...(o.typ === null ? {} : { typ: o.typ ?? "JWT" }) })
    .setIssuedAt();
  if (o.iss !== null) j = j.setIssuer(o.iss ?? EMETTEUR_SESSION);
  if (o.aud !== null) j = j.setAudience(o.aud ?? AUDIENCE_SESSION);
  if (o.exp !== null) j = j.setExpirationTime(o.exp ?? "1h");
  return j.sign(privee);
}

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/** Espion minimal (sans dépendre du lanceur). */
function espion<A extends unknown[], R>(fn: (...a: A) => R) {
  const appels: A[] = [];
  const f = (...a: A): R => {
    appels.push(a);
    return fn(...a);
  };
  return Object.assign(f, { appels });
}

/** Le journal ne contient jamais une valeur de clé ni un jeton. */
function journalPropre(...valeurs: string[]): void {
  for (const ligne of journal) {
    assert.match(ligne, /^\[auth-jws\] chemin=[a-z-]+ n=\d+$/);
    for (const v of valeurs) assert.ok(!ligne.includes(v), "valeur sensible dans le journal");
  }
}

const params = (token: string) => ({ token, salt: SEL, secret: SECRET_FACTICE });
// Comme dans le câblage des dépôts : `decode` / `encode` sont génériques, on fixe leurs types.
const decodeNextAuth = (env: () => Record<string, string | undefined>) =>
  decodeurAvecRepli<JWTDecodeParams, JWT>(decode, env);
type Dec = { token?: string };
type Enc = { token?: unknown; salt: string; secret: string };

// « comportement de RÉPONSE » et non « comportement » : depuis le 2026-10-23, cette branche
// journalise le chemin du repli. Ce qu'elle rend, lève et appelle, lui, n'a pas bougé d'un iota.
describe("sans clé publique posée : exactement le comportement de réponse d'aujourd'hui", () => {
  it("decode appelle le repli avec les mêmes paramètres, rend son résultat, et journalise le chemin secret", async () => {
    const { privee } = await paireFactice();
    const jws = await signer(privee);
    const rendu = { sub: "legacy" };
    const repli = espion<[Dec], Promise<object>>(async () => rendu);
    const dec = decodeurAvecRepli(repli, () => ({ AUTH_SECRET: SECRET_FACTICE }));
    for (const token of [jws, "a.b.c.d.e", ""]) {
      const p = params(token);
      assert.equal(await dec(p), rendu);
      assert.equal(repli.appels.at(-1)?.[0], p);
    }
    assert.equal(repli.appels.length, 3);
    assert.deepEqual(journal, ["[auth-jws] chemin=secret n=1"]);
  });

  it("régime cabinet posé (AUTH_SECRET_CABINET), sans clé publique : idem, aucun contrôle ajouté", async () => {
    const { privee } = await paireFactice();
    const env = { AUTH_SECRET: SECRET_FACTICE, AUTH_SECRET_CABINET: AUTRE_SECRET_FACTICE };
    const rendu = { sub: "legacy", tk: "cabinet", fs: 1 };
    const repli = espion<[Dec], Promise<object>>(async () => rendu);
    const dec = decodeurAvecRepli(repli, () => env);
    for (const token of [await signer(privee, { tk: "cabinet", fs: 1 }), "a.b.c.d.e"]) {
      const p = params(token);
      assert.equal(await dec(p), rendu);
      assert.equal(repli.appels.at(-1)?.[0], p);
    }
    assert.equal(await verifierSessionJws(await signer(privee), env), null);
    assert.deepEqual(journal, ["[auth-jws] chemin=secret n=1"]);
  });

  it("une exception du repli remonte telle quelle", async () => {
    const dec = decodeurAvecRepli<Dec, object>(async () => {
      throw new Error("panne base");
    }, () => ({}));
    await assert.rejects(dec(params("x")), /panne base/);
  });

  it("sans clé publique posée : le repli qui rend une charge utile journalise chemin=secret", async () => {
    const rendu = { sub: "legacy" };
    const dec = decodeurAvecRepli<Dec, object>(async () => rendu, () => ({}));
    assert.equal(await dec(params("x")), rendu);
    assert.deepEqual(journal, ["[auth-jws] chemin=secret n=1"]);
    journalPropre();
  });

  it("sans clé publique posée : le repli qui rend null journalise chemin=refus", async () => {
    const dec = decodeurAvecRepli<Dec, object>(async () => null, () => ({}));
    assert.equal(await dec(params("x")), null);
    assert.deepEqual(journal, ["[auth-jws] chemin=refus n=1"]);
    journalPropre();
  });

  it("encode appelle le repli avec les mêmes paramètres", async () => {
    const repli = espion<[Enc], Promise<string>>(async () => "jwe-d-aujourd-hui");
    const p = { token: { sub: "u1" }, salt: SEL, secret: SECRET_FACTICE };
    assert.equal(await encodeurAvecRepli(repli)(p), "jwe-d-aujourd-hui");
    assert.equal(repli.appels.at(-1)?.[0], p);
  });

  it("verifierSessionJws ne vérifie rien", async () => {
    const { privee } = await paireFactice();
    assert.equal(await verifierSessionJws(await signer(privee), {}), null);
    assert.equal(await verifierSessionJws(await signer(privee), { AUTH_PUBLIC_KEY: " , " }), null);
  });
});

describe("avec AUTH_PUBLIC_KEY : la clé publique d'abord", () => {
  it("un jeton signé par la paire factice est accepté sans toucher au repli", async () => {
    const { x, privee } = await paireFactice();
    const jws = await signer(privee, { tk: "salon", sv: 3 });
    const repli = espion<[Dec], Promise<object | null>>(async () => null);
    const dec = decodeurAvecRepli(repli, () => ({ AUTH_PUBLIC_KEY: x }));
    const r = (await dec(params(jws))) as Record<string, unknown>;
    assert.equal(r.sub, "u1");
    assert.equal(r.tenantId, "t1");
    assert.equal(r.role, "ADMIN");
    assert.equal(r.tk, "salon");
    assert.equal(r.sv, 3);
    assert.equal(repli.appels.length, 0);
    assert.deepEqual(journal, ["[auth-jws] chemin=publique n=1"]);
    journalPropre(x, jws);
  });

  it("un jeton signé par une AUTRE paire est refusé (repli essayé, refus journalisé)", async () => {
    const { x } = await paireFactice();
    const autre = await paireFactice();
    const jws = await signer(autre.privee);
    const dec = decodeurAvecRepli<Dec, object>(async () => null, () => ({ AUTH_PUBLIC_KEY: x }));
    assert.equal(await dec(params(jws)), null);
    assert.deepEqual(journal, ["[auth-jws] chemin=jws-refuse n=1", "[auth-jws] chemin=refus n=1"]);
    journalPropre(x, autre.x, jws);
  });

  it("refuse tout écart au contrat : algorithme, émetteur, audience, expiration, altération", async () => {
    const { x, privee } = await paireFactice();
    const env = { AUTH_PUBLIC_KEY: x };
    const passe = Math.floor(Date.now() / 1000) - 60;
    const ecarts: [string, string][] = [
      ["émetteur", await signer(privee, {}, { iss: "salon-reference" })],
      ["sans émetteur", await signer(privee, {}, { iss: null })],
      ["audience de service", await signer(privee, {}, { aud: "core-rdv" })],
      ["sans audience", await signer(privee, {}, { aud: null })],
      ["sans expiration", await signer(privee, {}, { exp: null })],
      ["expiré", await signer(privee, {}, { exp: passe })],
      // Confusion d'algorithme : HS256 avec la clé publique comme secret HMAC.
      [
        "HS256",
        await new SignJWT({ sub: "u1", tenantId: "t1", role: "ADMIN" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer(EMETTEUR_SESSION)
          .setAudience(AUDIENCE_SESSION)
          .setExpirationTime("1h")
          .sign(new TextEncoder().encode(x)),
      ],
      ["alg none", `${b64url({ alg: "none" })}.${b64url({ sub: "u1", iss: EMETTEUR_SESSION, aud: AUDIENCE_SESSION, exp: passe + 7200 })}.AAAA`],
    ];
    const valide = await signer(privee);
    const [h, , sig] = valide.split(".");
    ecarts.push(["signature altérée", `${h}.${valide.split(".")[1]}.${"A".repeat(86)}`]);
    const charge = b64url({ sub: "u1", tenantId: "t1", role: "ADMIN-BIS", iss: EMETTEUR_SESSION, aud: AUDIENCE_SESSION, exp: passe + 7200 });
    ecarts.push(["charge altérée", `${h}.${charge}.${sig}`]);
    for (const [nom, jws] of ecarts) assert.equal(await verifierSessionJws(jws, env), null, nom);
    assert.notEqual(await verifierSessionJws(valide, env), null);
  });

  it("une session chiffrée d'aujourd'hui reste acceptée par l'ancien secret, en repli", async () => {
    const { x } = await paireFactice();
    const jwe = await encode({ token: { sub: "u1", tenantId: "t1", role: "PRO" }, salt: SEL, secret: SECRET_FACTICE });
    assert.equal(jwe.split(".").length, 5);
    const dec = decodeNextAuth(() => ({ AUTH_PUBLIC_KEY: x }));
    const r = (await dec(params(jwe))) as Record<string, unknown>;
    assert.equal(r.tenantId, "t1");
    assert.equal(r.role, "PRO");
    assert.deepEqual(journal, ["[auth-jws] chemin=secret n=1"]);
    // Mauvais secret : le décodage d'aujourd'hui lève, il lève encore (NextAuth le traite en refus).
    await assert.rejects(dec({ token: jwe, salt: SEL, secret: AUTRE_SECRET_FACTICE }));
    assert.equal(journal.at(-1), "[auth-jws] chemin=refus n=1");
    journalPropre(x, jwe, SECRET_FACTICE);
  });

  it("rotation : deux clés posées, l'une ou l'autre suffit ; espaces et \\r tolérés", async () => {
    const a = await paireFactice();
    const b = await paireFactice();
    const env = { AUTH_PUBLIC_KEY: ` ${a.x} ,${b.x}\r` };
    assert.equal((await verifierSessionJws(await signer(a.privee), env))?.type, "commun");
    assert.equal((await verifierSessionJws(await signer(b.privee), env))?.type, "commun");
  });

  it("entrée illisible : ignorée et signalée, sans sa valeur ; la bonne clé fonctionne encore", async () => {
    const { x, privee } = await paireFactice();
    const env = { AUTH_PUBLIC_KEY: `pas-une-cle,${x}` };
    assert.notEqual(await verifierSessionJws(await signer(privee), env), null);
    assert.ok(journal.includes("[auth-jws] chemin=cle-illisible n=1"));
    journalPropre(x, "pas-une-cle");
  });
});

describe("étape 2 : contrôles ajoutés", () => {
  it("typ : absent ou at+jwt refusé, JWT accepté", async () => {
    const { x, privee } = await paireFactice();
    for (const typ of [null, "at+jwt", "JWT"]) {
      const jws = await signer(privee, {}, { typ });
      assert.equal((await verifierSessionJws(jws, { AUTH_PUBLIC_KEY: x }))?.type ?? null, typ === "JWT" ? "commun" : null);
      journalPropre(x, jws);
    }
  });

  it("exp : expiré depuis 10 s accepté, depuis 20 s refusé", async () => {
    const { x, privee } = await paireFactice();
    const maintenant = Math.floor(Date.now() / 1000);
    assert.equal(TOLERANCE_HORLOGE_S, 15);
    for (const retard of [10, 20]) {
      const jws = await signer(privee, {}, { exp: maintenant - retard });
      assert.equal((await verifierSessionJws(jws, { AUTH_PUBLIC_KEY: x }))?.type ?? null, retard === 10 ? "commun" : null);
    }
  });

  it("fs : passé de 60 s refusé, passé de 5 s ou futur accepté, non numérique ou infini refusé", async () => {
    const { x, privee } = await paireFactice();
    const maintenant = Math.floor(Date.now() / 1000);
    for (const [fs, accepte] of [[maintenant - 60, false], [maintenant - 5, true], [maintenant + 60, true], ["x", false]] as const) {
      const jws = await signer(privee, { fs }, { exp: maintenant + 3600 });
      assert.equal((await verifierSessionJws(jws, { AUTH_PUBLIC_KEY: x }))?.type ?? null, accepte ? "commun" : null);
      journalPropre(x, jws);
    }
    // fs: 1e400 se lit Infinity en JSON : refusé (SignJWT ne sait pas l'écrire, on signe le texte brut).
    const brut = `{"sub":"u1","iss":"${EMETTEUR_SESSION}","aud":"${AUDIENCE_SESSION}","exp":${maintenant + 3600},"fs":1e400}`;
    const infini = await new CompactSign(new TextEncoder().encode(brut))
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .sign(privee);
    assert.equal(await verifierSessionJws(infini, { AUTH_PUBLIC_KEY: x }), null);
  });

  it("clé cabinet seule : ignorée, repli inchangé et journal sans valeur", async () => {
    const { x, privee } = await paireFactice();
    const jws = await signer(privee, { tk: "cabinet" });
    for (const AUTH_SECRET_CABINET of [undefined, ""]) {
      const env = { AUTH_PUBLIC_KEY_CABINET: x, AUTH_SECRET_CABINET };
      assert.equal(regimeCabinetPose(env), false);
      assert.equal(clesPubliquesPosees(env), false);
      const rendu = { sub: "legacy" };
      const repli = espion<[Dec], Promise<object>>(async () => rendu);
      const p = params(jws);
      assert.equal(await decodeurAvecRepli(repli, () => env)(p), rendu);
      assert.deepEqual(repli.appels, [[p]]);
      assert.equal(await verifierSessionJws(jws, env), null);
      const enc = espion<[Enc], Promise<string>>(async () => "jwe-d-aujourd-hui");
      const pe = { token: rendu, salt: SEL, secret: SECRET_FACTICE };
      assert.equal(await encodeurAvecRepli(enc)(pe), "jwe-d-aujourd-hui");
      assert.equal(enc.appels[0][0], pe);
    }
    assert.deepEqual(journal, ["[auth-jws] chemin=cle-cabinet-sans-secret n=1", "[auth-jws] chemin=secret n=1"]);
    journalPropre(x, jws, SECRET_FACTICE);
  });

  it("clé cabinet avec secret : tk cabinet requis", async () => {
    const { x, privee } = await paireFactice();
    const env = { AUTH_PUBLIC_KEY_CABINET: x, AUTH_SECRET_CABINET: SECRET_FACTICE };
    for (const claims of [{ tk: "cabinet" }, {}, { tk: "salon" }]) {
      const jws = await signer(privee, claims);
      assert.equal((await verifierSessionJws(jws, env))?.type ?? null, claims.tk === "cabinet" ? "cabinet" : null);
      journalPropre(x, jws, SECRET_FACTICE);
    }
    assert.ok(journal.includes("[auth-jws] chemin=jws-refuse n=1"));
  });

  it("doublon : même x conservé en commun et signalé", async () => {
    const { x, privee } = await paireFactice();
    const env = { AUTH_PUBLIC_KEY: x, AUTH_PUBLIC_KEY_CABINET: x, AUTH_SECRET_CABINET: SECRET_FACTICE };
    const jws = await signer(privee, { tk: "cabinet" });
    assert.equal((await verifierSessionJws(jws, env))?.type, "commun");
    assert.ok(journal.includes("[auth-jws] chemin=cle-doublon n=1"));
    journalPropre(x, jws, SECRET_FACTICE);
  });
});

describe("cabinet", () => {
  it("la clé cabinet donne le type cabinet, la clé commune le type commun", async () => {
    const commun = await paireFactice();
    const cabinet = await paireFactice();
    const env = { AUTH_PUBLIC_KEY: commun.x, AUTH_PUBLIC_KEY_CABINET: cabinet.x, AUTH_SECRET_CABINET: SECRET_FACTICE };
    assert.equal((await verifierSessionJws(await signer(cabinet.privee, { tk: "cabinet" }), env))?.type, "cabinet");
    assert.equal((await verifierSessionJws(await signer(commun.privee), env))?.type, "commun");
    const dec = decodeurAvecRepli<Dec, object>(async () => null, () => env);
    await dec(params(await signer(cabinet.privee, { tk: "cabinet" })));
    assert.deepEqual(journal, ["[auth-jws] chemin=publique-cabinet n=1"]);
  });

  it("un lecteur sans clé cabinet refuse une session cabinet (comme sans AUTH_SECRET_CABINET)", async () => {
    const commun = await paireFactice();
    const cabinet = await paireFactice();
    assert.equal(await verifierSessionJws(await signer(cabinet.privee), { AUTH_PUBLIC_KEY: commun.x }), null);
  });

  it("régime cabinet : secret cabinet non vide requis", () => {
    assert.equal(regimeCabinetPose({}), false);
    assert.equal(regimeCabinetPose({ AUTH_SECRET_CABINET: SECRET_FACTICE }), true);
    assert.equal(regimeCabinetPose({ AUTH_PUBLIC_KEY_CABINET: "x" }), false);
    assert.equal(regimeCabinetPose({ AUTH_PUBLIC_KEY: "x" }), false);
  });
});

describe("encode : un lecteur ne signe pas", () => {
  it("un jeton vérifié par la clé publique est rendu tel quel", async () => {
    const { x, privee } = await paireFactice();
    const jws = await signer(privee);
    const dec = decodeNextAuth(() => ({ AUTH_PUBLIC_KEY: x }));
    const repliEnc = espion<[JWTEncodeParams], Promise<string>>(encode);
    const jeton = await dec(params(jws));
    assert.ok(jeton);
    assert.equal(await encodeurAvecRepli<JWTEncodeParams>(repliEnc)({ token: jeton, salt: SEL, secret: SECRET_FACTICE }), jws);
    assert.equal(repliEnc.appels.length, 0);
  });

  it("modifié par le lecteur, il repart par l'encodage d'aujourd'hui, et le journal le dit", async () => {
    const { x, privee } = await paireFactice();
    const jws = await signer(privee);
    const dec = decodeNextAuth(() => ({ AUTH_PUBLIC_KEY: x }));
    const jeton = (await dec(params(jws))) as Record<string, unknown>;
    jeton.role = "PRO";
    const rendu = await encodeurAvecRepli<JWTEncodeParams>(encode)({ token: jeton, salt: SEL, secret: SECRET_FACTICE });
    assert.notEqual(rendu, jws);
    assert.equal(rendu.split(".").length, 5);
    assert.ok(journal.includes("[auth-jws] chemin=reemis-secret n=1"));
  });

  it("un jeton venu de l'ancien secret repart par l'encodage d'aujourd'hui", async () => {
    const { x } = await paireFactice();
    const jwe = await encode({ token: { sub: "u1" }, salt: SEL, secret: SECRET_FACTICE });
    const dec = decodeNextAuth(() => ({ AUTH_PUBLIC_KEY: x }));
    const jeton = await dec(params(jwe));
    assert.ok(jeton);
    const enc = encodeurAvecRepli<Enc>(async () => "jwe-neuf");
    assert.equal(await enc({ token: jeton, salt: SEL, secret: SECRET_FACTICE }), "jwe-neuf");
  });
});

describe("journal", () => {
  it("1re ligne immédiate, puis le cumul toutes les 10 minutes", () => {
    noterChemin("secret", 0);
    noterChemin("secret", 1_000);
    noterChemin("secret", 2_000);
    noterChemin("secret", 3_000);
    assert.deepEqual(journal, ["[auth-jws] chemin=secret n=1"]);
    noterChemin("secret", 600_000);
    assert.deepEqual(journal, ["[auth-jws] chemin=secret n=1", "[auth-jws] chemin=secret n=4"]);
  });
});
