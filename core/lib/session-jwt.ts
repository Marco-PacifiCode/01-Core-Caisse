// session-jwt.ts — `jwt` NextAuth de ce lecteur (chantier AUTH_SECRET, étape 1) : la clé publique
// de Core-Auth d'abord (AUTH_PUBLIC_KEY), l'ancien secret partagé en repli. Sans AUTH_PUBLIC_KEY :
// décodage et encodage NextAuth d'aujourd'hui, à l'identique.
import { decode, encode, type JWT, type JWTDecodeParams, type JWTEncodeParams } from "next-auth/jwt";
import { decodeurAvecRepli, encodeurAvecRepli } from "./session-jws.ts";
// Paramètres de type explicites : `decode` est générique, tsc n'en déduit pas le type de jeton seul.
export const jwtSession = {
  decode: decodeurAvecRepli<JWTDecodeParams, JWT>(decode),
  encode: encodeurAvecRepli<JWTEncodeParams>(encode),
};
