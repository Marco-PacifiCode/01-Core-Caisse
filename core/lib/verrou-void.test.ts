import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// PC-0235 : pg_advisory_xact_lock renvoie `void`, que Prisma ne sait pas lire via
// $queryRaw (P2010 « Failed to deserialize column of type 'void' ») : toute vente échouait.
// Un verrou lu par $queryRaw doit donc caster son résultat (::text) ou passer par $executeRaw.
test("aucun $queryRaw ne renvoie la colonne void d'un verrou consultatif", () => {
  const fautifs: string[] = [];
  for (const dir of ["lib", "app"]) {
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/\$queryRaw`SELECT pg_advisory_xact_lock\([^`]*`/g)) {
        if (!m[0].endsWith("::text`")) fautifs.push(`${dir}/${f}`);
      }
    }
  }
  assert.deepEqual(fautifs, []);
});
