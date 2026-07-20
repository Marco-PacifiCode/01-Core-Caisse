import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { log } from "./log";
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
  } catch (e) {
    // Socle observabilité : erreur réseau vers core_auth = anomalie (le 404 domaine
    // inconnu passe par !res.ok au-dessus et reste silencieux, c'est un cas normal).
    log.error("tenant.resolve", e, { host });
    return null;
  }
}

/** UUID strict (8-4-4-4-12 hex). Seule forme admise pour app.current_tenant. */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Garde anti-injection (chantier sécurité audit 2026-07-02) : valide que la
 * valeur est un UUID strict avant tout usage dans un GUC RLS. Lève sinon.
 */
export function assertTenantId(tenantId: string): string {
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    throw new Error("INVALID_TENANT_ID");
  }
  return tenantId;
}

/**
 * Exécute `fn` dans une transaction où la variable de session
 * `app.current_tenant` est positionnée → active les politiques RLS
 * (defense-in-depth, voir prisma/rls.sql).
 * Durci audit 2026-07-02 : tenantId validé UUID strict + set_config PARAMÉTRÉ
 * (is_local=true ≡ SET LOCAL) — plus d'interpolation SQL. Homogène avec les 5
 * autres cores (cf. 01-Core-Compta/core/lib/tenant.ts).
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const safeTenantId = assertTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${safeTenantId}, true)`;
    return fn(tx);
  });
}
