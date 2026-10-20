// Câblage réel du lecteur : uniquement des clés et un secret factices.
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Auth } from "@auth/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { encode } from "next-auth/jwt";
import { AUDIENCE_SESSION, EMETTEUR_SESSION, __pourTests } from "./session-jws.ts";
import { jwtSession } from "./session-jwt.ts";

const SECRET_FACTICE = "secret-factice-de-test-0123456789abcdef0123456789";
const COOKIE = "authjs.session-token";

beforeEach(() => {
  __pourTests();
});

async function sessionSigneeFactice() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const { x } = await exportJWK(publicKey);
  assert.ok(x);
  const jws = await new SignJWT({ sub: "u1", tenantId: "t1", role: "ADMIN" })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(EMETTEUR_SESSION)
    .setAudience(AUDIENCE_SESSION)
    .setExpirationTime("1h")
    .sign(privateKey);
  return { x, jws };
}

async function lireSession(jeton: string) {
  return Auth(new Request("http://localhost/api/auth/session", {
    headers: { cookie: COOKIE + "=" + jeton },
  }), {
    providers: [],
    session: { strategy: "jwt" },
    trustHost: true,
    secret: SECRET_FACTICE,
    basePath: "/api/auth",
    jwt: jwtSession,
    callbacks: {
      session({ session, token }) {
        (session.user as any).tenantId = (token as any).tenantId;
        return session;
      },
    },
  });
}

async function avecClesPubliques(x: string | undefined, action: () => Promise<void>) {
  const anciennes = {
    AUTH_PUBLIC_KEY: process.env.AUTH_PUBLIC_KEY,
    AUTH_PUBLIC_KEY_CABINET: process.env.AUTH_PUBLIC_KEY_CABINET,
  };
  delete process.env.AUTH_PUBLIC_KEY_CABINET;
  if (x === undefined) delete process.env.AUTH_PUBLIC_KEY;
  else process.env.AUTH_PUBLIC_KEY = x;
  try {
    await action();
  } finally {
    for (const [nom, valeur] of Object.entries(anciennes)) {
      if (valeur === undefined) delete process.env[nom];
      else process.env[nom] = valeur;
    }
  }
}

describe("câblage de la session NextAuth", () => {
  it("auth.ts passe par jwtSession", () => {
    const source = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
    assert.match(source, /jwt:\s*jwtSession/);
    assert.match(source, /import\s*\{\s*jwtSession\s*\}\s*from\s*["']\.\/lib\/session-jwt\.ts["']/);
  });

  it("avec AUTH_PUBLIC_KEY, l'action session de NextAuth lit une session signée et garde le cookie tel quel", async () => {
    const { x, jws } = await sessionSigneeFactice();
    await avecClesPubliques(x, async () => {
      const reponse = await lireSession(jws);
      const corps = await reponse.json();
      assert.equal(corps.user.tenantId, "t1");
      assert.ok(reponse.headers.get("set-cookie")?.includes(COOKIE + "=" + jws));
    });
  });

  it("sans AUTH_PUBLIC_KEY, une session chiffrée par l'ancien secret factice est lue comme aujourd'hui, et une session signée est refusée", async () => {
    const { jws } = await sessionSigneeFactice();
    await avecClesPubliques(undefined, async () => {
      const jwe = await encode({
        token: { sub: "u1", tenantId: "t1" },
        salt: COOKIE,
        secret: SECRET_FACTICE,
      });
      const reponse = await lireSession(jwe);
      const corps = await reponse.json();
      assert.equal(corps.user.tenantId, "t1");
      const refus = await lireSession(jws);
      const corpsRefuse = await refus.json();
      assert.ok(corpsRefuse === null || !corpsRefuse.user);
    });
  });
});
