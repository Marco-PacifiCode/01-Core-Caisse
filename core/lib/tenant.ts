import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/** Type local — reflète le payload de core_auth GET /api/tenant */
export type TenantConfig = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  theme: any;
  enabledModules: string[];
  phone: string | null;
  email: string | null;
  address: string | null;
};

/** Hostname courant (sans port), en minuscules. */
export async function currentHost(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  return host.split(":")[0].toLowerCase();
}

/**
 * Résout le tenant via l'API de core_auth (GET /api/tenant).
 * core_auth résout lui-même le tenant par le header Host.
 * Renvoie null si le host est inconnu (404) ou si core_auth est injoignable.
 */
export async function resolveTenant(): Promise<TenantConfig | null> {
  const host = await currentHost();
  if (!host) return null;

  const coreAuthUrl = process.env.CORE_AUTH_URL || "http://localhost:3102";
  try {
    // ⚠️ Le header `Host` ne peut PAS être forcé via fetch (undici le réécrit depuis l'URL).
    // On forwarde le vrai hostname via `x-forwarded-host`, que core_auth lit en priorité.
    const res = await fetch(`${coreAuthUrl}/api/tenant`, {
      headers: { "x-forwarded-host": host },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as TenantConfig;
  } catch {
    return null;
  }
}

// UUID (v1-v5, casse indifférente). `SET LOCAL` ne supporte pas les paramètres liés → l'interpolation
// est inévitable ; on la borne à un UUID STRICTEMENT validé (aucune injection possible).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Exécute `fn` dans une transaction où la variable de session
 * `app.current_tenant` est positionnée → active les politiques RLS
 * (defense-in-depth, voir prisma/rls.sql).
 * Rejette tout tenantId non-UUID AVANT interpolation SQL.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`withTenant: tenantId invalide (UUID attendu), reçu ${JSON.stringify(tenantId).slice(0, 80)}`);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${tenantId}'`);
    return fn(tx);
  });
}
