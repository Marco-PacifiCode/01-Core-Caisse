// lib/maquette-exclusion.ts — démo privée : exclusion des tenants MAQUETTE des traitements
// multi-tenants (cron de reprise lib/repair-sweep.ts : sélection, neutralisations, compteurs).
// Le registre "TenantMaquette" est lu par le client du cron (rôle BYPASSRLS de CRON_DATABASE_URL,
// SELECT accordé par la migration 20261111130000) ; le filtre est posé DANS chaque requête.
import type { Prisma } from "@prisma/client";

type Lecteur = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Prisma.PrismaPromise<T> };

/** Identifiants des tenants inscrits au registre des maquettes. */
export async function tenantsMaquette(client: Lecteur): Promise<string[]> {
  const lignes = await client.$queryRaw<{ t: string }[]>`SELECT "tenantId"::text AS t FROM "TenantMaquette"`;
  return lignes.map((l) => l.t);
}

/** Filtre de vente qui écarte les tenants maquette. Liste vide = filtre d'origine, inchangé. */
export function sansMaquettes(where: Prisma.SaleWhereInput, maquettes: readonly string[]): Prisma.SaleWhereInput {
  return maquettes.length ? { AND: [where, { tenantId: { notIn: [...maquettes] } }] } : where;
}
