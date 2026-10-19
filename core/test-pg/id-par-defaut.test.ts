// Recette PostgreSQL réelle : l'`id` de CashMovement, PartialRefund et VoidAction est tiré PAR
// LA BASE (DEFAULT gen_random_uuid(), posé par leurs migrations). Depuis le 19/10 le schéma le
// déclare en @default(dbgenerated("gen_random_uuid()")) ; avant, il disait @default(uuid()) et
// un `prisma migrate dev` aurait généré une migration qui SUPPRIMAIT ces DEFAULT — toute insertion
// SQL qui compte dessus aurait alors échoué.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL est obligatoire pour test:pg");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("la base porte DEFAULT gen_random_uuid() sur l'id des trois tables", async () => {
  // ::text partout : Prisma ne sait pas désérialiser le type sql_identifier d'information_schema.
  const rows = await prisma.$queryRaw<{ table_name: string; column_default: string | null }[]>`
    SELECT table_name::text AS table_name, column_default::text AS column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'id'
      AND table_name IN ('CashMovement', 'PartialRefund', 'VoidAction')
    ORDER BY table_name`;
  assert.deepEqual(rows, [
    { table_name: "CashMovement", column_default: "gen_random_uuid()" },
    { table_name: "PartialRefund", column_default: "gen_random_uuid()" },
    { table_name: "VoidAction", column_default: "gen_random_uuid()" },
  ]);
});

test("VoidAction créée par Prisma sans id : la base en tire un", async () => {
  const tenantId = randomUUID();
  const actionId = randomUUID();
  const inTenant = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });
  try {
    const row = await inTenant(tx => tx.voidAction.create({ data: { tenantId, actionId, saleId: randomUUID() } }));
    assert.match(row.id, UUID);
    const relue = await inTenant(tx => tx.voidAction.findUnique({ where: { tenantId_actionId: { tenantId, actionId } } }));
    assert.equal(relue?.id, row.id);
  } finally {
    await inTenant(tx => tx.voidAction.deleteMany({ where: { tenantId } }));
  }
});
