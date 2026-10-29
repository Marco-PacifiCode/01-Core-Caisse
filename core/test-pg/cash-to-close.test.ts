import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// CI local uniquement : migrations et client généré à partir du schéma 4a.
// Aucune migration exécutée par ce test, aucun commerce réel utilisé.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL obligatoire (base de recette uniquement)");
const prisma = new PrismaClient();
after(async () => { await prisma.$disconnect(); });

test("migration 4a : enum présent, défaut false et lecture Prisma de TO_CLOSE", async () => {
  const tenantId = randomUUID(), sessionId = randomUUID(), actorId = randomUUID();
  const rollback = new Error("ROLLBACK_SYNTHETIC_TEST");
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    const values = await tx.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel::text FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
      WHERE t.typname='SessionStatus' AND e.enumlabel='TO_CLOSE'`;
    assert.equal(values.length, 1);
    await tx.cashSettings.create({ data: { tenantId } });
    const settings = await tx.$queryRaw<{ toCloseEnabled: boolean }[]>`
      SELECT "toCloseEnabled" FROM "CashSettings" WHERE "tenantId"=${tenantId}::uuid`;
    assert.equal(settings[0].toCloseEnabled, false);
    await tx.cashSession.create({ data: { id: sessionId, tenantId, openedBy: actorId, openingFloatXpf: 0n } });
    // Seul le banc de recette écrit cet état ; l'application 4a ne le fait jamais.
    await tx.$executeRaw`UPDATE "CashSession" SET status='TO_CLOSE' WHERE id=${sessionId}::uuid AND "tenantId"=${tenantId}::uuid`;
    const session = await tx.cashSession.findFirstOrThrow({ where: { tenantId, id: sessionId } });
    assert.equal(session.status, "TO_CLOSE");
    assert.equal(session.closedAt, null);
    throw rollback;
  }), error => error === rollback);
});
