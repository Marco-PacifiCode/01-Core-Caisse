import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { resolveTenant } from "@/lib/tenant";
import type { TenantConfig } from "@/lib/tenant";

export type SessionUser = { id: string; email: string; name?: string; role: "CLIENT" | "PRO" | "ADMIN"; tenantId: string };

async function ctx(): Promise<{ user: SessionUser | null; tenant: TenantConfig | null }> {
  const [session, tenant] = await Promise.all([auth(), resolveTenant()]);
  const user = (session?.user as unknown as SessionUser) ?? null;
  // un utilisateur ne vaut que pour SON tenant (résolu par le domaine courant)
  if (user && tenant && user.tenantId !== tenant.id) return { user: null, tenant };
  return { user, tenant };
}

/** Page réservée au staff (PRO/ADMIN) du tenant courant. */
export async function requireStaff(next = "/caisse") {
  const { user, tenant } = await ctx();
  if (!user || !tenant || (user.role !== "PRO" && user.role !== "ADMIN")) {
    redirect(`/connexion?next=${encodeURIComponent(next)}`);
  }
  return { user, tenant };
}

/** Page réservée à un utilisateur connecté du tenant courant. */
export async function requireUser(next = "/compte") {
  const { user, tenant } = await ctx();
  if (!user || !tenant) redirect(`/connexion?next=${encodeURIComponent(next)}`);
  return { user, tenant };
}

export async function optionalUser() {
  return ctx();
}
