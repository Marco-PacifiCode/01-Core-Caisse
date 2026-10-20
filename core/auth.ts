// auth.ts — décodeur de session JWT partagée émise par core_auth.
// Ce module ne gère PAS la connexion : login = core_auth (:3102).
// Session de core_auth : signée (AUTH_PUBLIC_KEY) ou, en repli, chiffrée par l'AUTH_SECRET partagé.
// La session porte : sub (userId), tenantId, role.

import NextAuth from "next-auth";
import { jwtSession } from "./lib/session-jwt.ts";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  trustHost: true,
  jwt: jwtSession,
  providers: [],
  pages: { signIn: "/connexion" },
  callbacks: {
    session({ session, token }) {
      if (session.user) {
        // @ts-expect-error champs custom
        session.user.id = token.sub;
        // @ts-expect-error champs custom
        session.user.role = (token as any).role;
        // @ts-expect-error champs custom
        session.user.tenantId = (token as any).tenantId;
      }
      return session;
    },
  },
});
