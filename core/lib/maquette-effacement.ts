import { withTenant } from "./tenant";

/** Crochet de recette seulement ; jamais fourni par la route HTTP. */
export async function effacerMaquette(tenantId: string, apresPrecomptage?: () => Promise<void>): Promise<Record<string, number>> {
  return withTenant(tenantId, async (tx) => {
    // La fonction SQL conserve son précomptage et son plafond. En recette, établir le même
    // instantané avant la connexion concurrente, sans modifier la fonction SECURITY DEFINER.
    if (apresPrecomptage) {
      const tables = await tx.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'tenantId' AND table_name <> 'TenantMaquette'`;
      for (const { table_name } of tables) {
        const identifiant = '"' + table_name.replaceAll('"', '""') + '"';
        await tx.$queryRawUnsafe(`SELECT count(*) FROM ${identifiant} WHERE "tenantId" = $1::uuid`, tenantId);
      }
      await apresPrecomptage();
    }
    // Borne l'instruction elle-même, avant l'appel de la fonction SQL.
    await tx.$executeRaw`SELECT set_config('statement_timeout', '10s', true)`;
    const lignes = await tx.$queryRaw<{ compteurs: Record<string, number> }[]>`SELECT effacer_tenant_maquette(${tenantId}::uuid) AS compteurs`;
    return lignes[0]?.compteurs ?? {};
  }, { timeout: 15_000, maxWait: 5_000, isolationLevel: "RepeatableRead" });
}
