// Seed core_caisse — données métier uniquement.
// Les tenants et utilisateurs vivent dans core_auth (identité externalisée).
// On keye les données sur les UUID canoniques des tenants (source de vérité : core_auth prisma/seed.ts,
// identiques à core_compta et core_stock).
//
// La caisse n'a pas de catalogue propre (il vit dans Core-Stock) : on seede juste une session ouverte
// par tenant démo (fond de caisse), pour que l'écran caisse soit immédiatement opérationnel en dev.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// UUID canoniques (identiques à core_auth / core_compta / core_stock — source de vérité : 00-Archi-PacifiCode)
const TENANT_ELLEMENT = "a0000000-0000-4000-8000-000000000001"; // Institut Ellément
const TENANT_BOUTIQUE = "a0000000-0000-4000-8000-000000000003"; // Boutique Démo

// Un opérateur d'ouverture fictif (uuid quelconque — la vraie identité vient de core_auth en runtime).
const SEED_OPERATOR = "b0000000-0000-4000-8000-0000000000ff";

type TenantSeed = { tenantId: string; label: string; openingFloatXpf: bigint };

const TENANTS: TenantSeed[] = [
  { tenantId: TENANT_ELLEMENT, label: "Ellément", openingFloatXpf: 10000n },
  { tenantId: TENANT_BOUTIQUE, label: "Boutique Démo", openingFloatXpf: 20000n },
];

async function seedTenant(def: TenantSeed) {
  const { tenantId, label, openingFloatXpf } = def;
  const existing = await prisma.cashSession.findFirst({ where: { tenantId, status: "OPEN" } });
  if (existing) {
    console.log(`• ${label} : session déjà ouverte, rien à faire.`);
    return;
  }
  await prisma.cashSession.create({
    data: { tenantId, openedBy: SEED_OPERATOR, openingFloatXpf, note: "Session ouverte (seed dev)" },
  });
  console.log(`✓ ${label} : session ouverte avec fond ${openingFloatXpf} F.`);
}

async function main() {
  console.log("Reset des données métier core_caisse…");
  // Reset dans l'ordre des dépendances FK.
  await prisma.salePayment.deleteMany();
  await prisma.saleLine.deleteMany();
  await prisma.sale.deleteMany();
  await prisma.cashSession.deleteMany();

  for (const def of TENANTS) await seedTenant(def);
  console.log("Seed terminé.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
