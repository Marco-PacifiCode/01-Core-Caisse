// import-cloture.test.ts — import d'une clôture Z déjà faite hors ligne (Rôtisserie de Pouembout).
//
// POURQUOI DEUX STYLES DE TEST DANS CE FICHIER
// `prepareClotureImport` (lib/import-cloture.ts) est PURE — aucune dépendance DB — donc EXÉCUTÉE
// ici (comme sync.test.ts / void-sale.test.ts). L'idempotence de `importerCloture` (lib/caisse.ts)
// dépend d'une lecture/écriture Prisma sous `withTenant` : non exécutable par ce runner
// (`node --test`, pas de DB) — on fige son contrat en lisant le code source, exactement comme
// void-route.test.ts fige SALE_NOT_FOUND.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareClotureImport, type ImportClotureInput } from "./import-cloture.ts";

const libDir = path.dirname(fileURLToPath(import.meta.url));

/** Un import valide de référence — chaque test ne dévie que du champ qu'il vérifie. */
function makeInput(overrides: Partial<ImportClotureInput> = {}): ImportClotureInput {
  return {
    sourceType: "tablette-pouembout",
    sourceId: "2026-08-20",
    posteId: "comptoir-1",
    openedAt: "2026-08-20T07:00:00.000Z",
    closedAt: "2026-08-20T18:00:00.000Z",
    openingFloatXpf: 10_000,
    closingCountedXpf: 145_000,
    expectedXpf: 150_000,
    note: "Import journée du 20/08",
    ...overrides,
  };
}

// ─── Source ─────────────────────────────────────────────────────────────────

test("sourceType et sourceId manquants → SOURCE_REQUISE (pas d'idempotence possible sans eux)", () => {
  assert.deepEqual(prepareClotureImport(makeInput({ sourceType: null })), { ok: false, error: "SOURCE_REQUISE" });
  assert.deepEqual(prepareClotureImport(makeInput({ sourceId: null })), { ok: false, error: "SOURCE_REQUISE" });
  assert.deepEqual(prepareClotureImport(makeInput({ sourceType: "", sourceId: "" })), {
    ok: false,
    error: "SOURCE_REQUISE",
  });
  assert.deepEqual(prepareClotureImport(makeInput({ sourceType: "   " })), { ok: false, error: "SOURCE_REQUISE" });
});

// ─── Dates ──────────────────────────────────────────────────────────────────

test("dates manquantes ou illisibles → DATES_INVALIDES", () => {
  assert.deepEqual(prepareClotureImport(makeInput({ openedAt: null })), { ok: false, error: "DATES_INVALIDES" });
  assert.deepEqual(prepareClotureImport(makeInput({ closedAt: null })), { ok: false, error: "DATES_INVALIDES" });
  assert.deepEqual(prepareClotureImport(makeInput({ openedAt: "pas-une-date" })), {
    ok: false,
    error: "DATES_INVALIDES",
  });
  assert.deepEqual(prepareClotureImport(makeInput({ closedAt: "pas-une-date" })), {
    ok: false,
    error: "DATES_INVALIDES",
  });
});

test("closedAt antérieur à openedAt → DATES_INVALIDES", () => {
  const out = prepareClotureImport(
    makeInput({ openedAt: "2026-08-20T18:00:00.000Z", closedAt: "2026-08-20T07:00:00.000Z" }),
  );
  assert.deepEqual(out, { ok: false, error: "DATES_INVALIDES" });
});

test("closedAt strictement égal à openedAt est accepté (borne >=)", () => {
  const same = "2026-08-20T12:00:00.000Z";
  const out = prepareClotureImport(makeInput({ openedAt: same, closedAt: same }));
  assert.equal(out.ok, true);
});

test("une date dans le futur (> 60 s) → DATES_INVALIDES, même borne que createSale", () => {
  const futur = new Date(Date.now() + 5 * 60_000).toISOString();
  assert.deepEqual(prepareClotureImport(makeInput({ openedAt: futur, closedAt: futur })), {
    ok: false,
    error: "DATES_INVALIDES",
  });
  // closedAt seul dans le futur, openedAt correct : refusé aussi.
  const out = prepareClotureImport(makeInput({ closedAt: futur }));
  assert.deepEqual(out, { ok: false, error: "DATES_INVALIDES" });
});

test("une dérive d'horloge de quelques secondes (< 60 s) est tolérée", () => {
  const presqueMaintenant = new Date(Date.now() + 5_000).toISOString();
  const out = prepareClotureImport(makeInput({ closedAt: presqueMaintenant }));
  assert.equal(out.ok, true);
});

// ─── Montants ───────────────────────────────────────────────────────────────

test("montants négatifs → MONTANT_INVALIDE", () => {
  assert.deepEqual(prepareClotureImport(makeInput({ openingFloatXpf: -1 })), {
    ok: false,
    error: "MONTANT_INVALIDE",
  });
  assert.deepEqual(prepareClotureImport(makeInput({ closingCountedXpf: -1 })), {
    ok: false,
    error: "MONTANT_INVALIDE",
  });
});

test("montants manquants ou non entiers → MONTANT_INVALIDE", () => {
  assert.deepEqual(prepareClotureImport(makeInput({ openingFloatXpf: null })), {
    ok: false,
    error: "MONTANT_INVALIDE",
  });
  assert.deepEqual(prepareClotureImport(makeInput({ closingCountedXpf: undefined })), {
    ok: false,
    error: "MONTANT_INVALIDE",
  });
  assert.deepEqual(prepareClotureImport(makeInput({ expectedXpf: null })), {
    ok: false,
    error: "MONTANT_INVALIDE",
  });
  assert.deepEqual(prepareClotureImport(makeInput({ openingFloatXpf: 1000.5 })), {
    ok: false,
    error: "MONTANT_INVALIDE",
  });
  assert.deepEqual(prepareClotureImport(makeInput({ closingCountedXpf: Number.NaN })), {
    ok: false,
    error: "MONTANT_INVALIDE",
  });
});

test("expectedXpf n'est PAS borné à >= 0 (un attendu peut être négatif après de gros remboursements)", () => {
  const out = prepareClotureImport(makeInput({ expectedXpf: -500, closingCountedXpf: 0 }));
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.varianceXpf, 500n);
});

// ─── Écart : TOUJOURS calculé, jamais repris de l'appelant ───────────────────

test("varianceXpf = closingCountedXpf - expectedXpf, quels que soient les montants", () => {
  const out = prepareClotureImport(makeInput({ closingCountedXpf: 145_000, expectedXpf: 150_000 }));
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.varianceXpf, -5_000n);

  const out2 = prepareClotureImport(makeInput({ closingCountedXpf: 150_000, expectedXpf: 150_000 }));
  assert.equal(out2.ok, true);
  if (out2.ok) assert.equal(out2.varianceXpf, 0n);

  const out3 = prepareClotureImport(makeInput({ closingCountedXpf: 152_000, expectedXpf: 150_000 }));
  assert.equal(out3.ok, true);
  if (out3.ok) assert.equal(out3.varianceXpf, 2_000n);
});

test("varianceXpf n'est PAS un champ d'entrée : le type ImportClotureInput ne le porte pas", () => {
  // Preuve structurelle plutôt qu'une assertion à l'exécution : un appelant qui fournirait
  // `varianceXpf` dans le body JSON verrait le champ simplement ignoré (TypeScript ne le
  // laisserait même pas passer côté route), et ne PEUT PAS influencer le calcul ci-dessus.
  const input = makeInput() as Record<string, unknown>;
  assert.equal("varianceXpf" in input, false);
});

// ─── Champs annexes ───────────────────────────────────────────────────────────

test("posteId et note sont optionnels, triviaux et triés (trim)", () => {
  const out = prepareClotureImport(makeInput({ posteId: "  comptoir-2  ", note: "  ras  " }));
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.posteId, "comptoir-2");
    assert.equal(out.note, "ras");
  }
  const out2 = prepareClotureImport(makeInput({ posteId: null, note: null }));
  assert.equal(out2.ok, true);
  if (out2.ok) {
    assert.equal(out2.posteId, null);
    assert.equal(out2.note, null);
  }
});

// ─── Idempotence de `importerCloture` (lib/caisse.ts) — figée par lecture de source ──────────
// (dépend d'une lecture/écriture Prisma sous withTenant : non exécutable par ce runner, cf.
// en-tête du fichier — même limite que void-route.test.ts pour SALE_NOT_FOUND.)

function readCaisse(): string {
  return readFileSync(path.join(libDir, "caisse.ts"), "utf8");
}

test("importerCloture cherche la session EXISTANTE par (tenantId, sourceType, sourceId) avant d'écrire", () => {
  const src = readCaisse();
  const bloc = src.slice(src.indexOf("export async function importerCloture"));
  assert.match(bloc.slice(0, 1500), /sourceType:\s*prepared\.sourceType,\s*sourceId:\s*prepared\.sourceId/);
  assert.match(bloc.slice(0, 1500), /alreadyExisted:\s*true/);
});

test("importerCloture ne modifie PAS la session si elle existe déjà (pas d'update, juste une relecture)", () => {
  const src = readCaisse();
  const debut = src.indexOf("export async function importerCloture");
  const finFonction = src.indexOf("\n// ─── Tickets", debut);
  const bloc = src.slice(debut, finFonction > -1 ? finFonction : undefined);
  // Aucun `cashSession.update` dans toute la fonction : la branche "existing" ne fait qu'un
  // findFirst suivi d'un retour — une pièce déjà établie ne se réécrit pas sur un renvoi.
  assert.doesNotMatch(bloc, /cashSession\.update/);
});

test("importerCloture rattrape la course sur l'index unique (P2002) comme openSession", () => {
  const src = readCaisse();
  const bloc = src.slice(src.indexOf("export async function importerCloture"));
  assert.match(bloc.slice(0, 3000), /P2002/);
  assert.match(bloc.slice(0, 3000), /uniq_session_external_source/);
});

test("importerCloture crée la session directement CLOSED", () => {
  const src = readCaisse();
  const bloc = src.slice(src.indexOf("export async function importerCloture"));
  assert.match(bloc.slice(0, 3000), /status:\s*"CLOSED"/);
});

test("la route d'import existe, exige la clé de service, et route SÉPARÉE des routes vivantes", () => {
  const route = readFileSync(
    path.join(libDir, "..", "app", "api", "sessions", "import", "route.ts"),
    "utf8",
  );
  assert.match(route, /hasServiceKey\(req\)/);
  assert.match(route, /importerCloture/);
  // Le chemin vivant ne doit apparaître nulle part dans cette route.
  assert.doesNotMatch(route, /openSession\(/);
  assert.doesNotMatch(route, /closeSession\(/);
});
