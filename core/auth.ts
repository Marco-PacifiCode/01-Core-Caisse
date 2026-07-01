// auth.ts — décodeur de session JWT partagée émise par core_auth.
// Ce module ne gère PAS la connexion : login = core_auth (:3102).
// AUTH_SECRET DOIT être identique dans tous les moteurs (core_auth, core_compta, core_stock, core_caisse…).
// La session porte : sub (userId), tenantId, role.

import NextAuth from "next-auth";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  trustHost: true,
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
