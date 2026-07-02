// scripts/seed-tenant.ts — onboarding d'UN tenant depuis un descripteur JSON (audit 2026-07-02, reco n°6).
//
// core_caisse ne REQUIERT AUCUNE donnée pour un nouveau tenant (vérifié 2026-07-03) :
//   - la caisse n'a pas de catalogue propre (il vit dans core_stock) ;
//   - les CashSession s'ouvrent à l'usage (écran caisse, fond de caisse saisi par l'opérateur) —
//     la session ouverte du seed.ts historique est un confort de DEV, pas un prérequis ;
//   - Sale/SaleLine/SalePayment naissent à l'encaissement.
// Ce script existe pour l'uniformité de l'orchestrateur d'onboarding : il valide le descripteur,
// vérifie que la base répond, et confirme qu'il n'y a rien à provisionner.
//
// Usage : npm run seed:tenant -- <chemin/tenant.json>     (ou TENANT_FILE=<chemin>)
// IDEMPOTENT et NON-DESTRUCTIF : n'écrit RIEN, aucun deleteMany (le seed.ts historique, lui,
// efface les ventes — ne JAMAIS le rejouer en prod).
//
// ⚠️ RLS/FORCE (2026-07, prisma/manual/2026-07_securite_rls.sql) : par cohérence avec les autres
// cores, exécuter avec un rôle BYPASSRLS (ex. postgres) via DATABASE_URL. Rappel : le rôle du
// balayage cron (CRON_DATABASE_URL) doit lui aussi être BYPASSRLS — cf. la migration manuelle.
// Cf. runbook 00-Archi-NextGen/vps/onboard-tenant.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type TenantDescriptor = { id: string; slug: string; name: string; enabledModules?: string[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg: string): never {
  console.error(`✗ seed:tenant (core_caisse) — ${msg}`);
  process.exit(1);
}

function loadDescriptor(): TenantDescriptor {
  const path = process.argv[2] ?? process.env.TENANT_FILE;
  if (!path) fail("usage : npm run seed:tenant -- <chemin/tenant.json> (ou TENANT_FILE=<chemin>)");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (e) {
    fail(`descripteur illisible (${path}) : ${(e as Error).message}`);
  }
  const d = raw as TenantDescriptor;
  if (!d.id || !UUID_RE.test(d.id)) fail(`"id" absent ou pas un UUID : ${d.id}`);
  if (!d.slug || !d.name) fail(`"slug"/"name" absents`);
  return d;
}

async function main() {
  const d = loadDescriptor();
  console.log(`— core_caisse · tenant ${d.slug} (${d.id})`);
  await prisma.$queryRaw`SELECT 1`; // la base répond
  console.log(
    `✓ Rien à provisionner : les sessions de caisse s'ouvrent à l'usage (fond de caisse saisi ` +
      `par l'opérateur), les ventes naissent à l'encaissement.`,
  );
  console.log(`Seed tenant core_caisse terminé.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
