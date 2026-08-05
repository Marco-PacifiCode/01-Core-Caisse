// Contrat de GET /api/sales/:id — le chaînon dont dépend la reprise de stock d'un avoir.
//
// POURQUOI CE TEST EXISTE, ET POURQUOI IL LIT LE CODE SOURCE
// Cette route est appelée par les surfaces au moment exact où un avoir est émis : c'est
// elle qui rend les `productId` et les `qty` que la surface remet en stock (la facture
// Core-Compta ne porte pas les productId, seule la vente les connaît). Si elle échoue,
// l'avoir est déjà écrit en comptabilité et le stock ne revient pas — il n'y a pas de
// rollback.
//
// Le runner du repo (`node --test --experimental-strip-types`) ne peut pas EXÉCUTER un
// route handler : il importerait `next/server` sans contexte Next, et `@prisma/client`
// sans client généré. On fige donc le contrat en lisant le source, comme
// `V-Cut/surface/lib/admin-route-guards.test.ts` le fait pour les gardes de routes.
//
// Ce que ces assertions attrapent réellement :
//  · une clé de service oubliée → la route deviendrait publique ;
//  · un `where` sans tenantId → un salon lirait le ticket d'un autre ;
//  · un BigInt sérialisé sans `xpf()` → `NextResponse.json` LÈVE (« Do not know how to
//    serialize a BigInt ») et la route rend 500 au moment du clic sur « Avoir ».

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const routeFile = path.join(libDir, "..", "app", "api", "sales", "[id]", "route.ts");

test("la route de lecture d'un ticket existe (sinon les tests ci-dessous seraient verts pour rien)", () => {
  // Sans cette assertion, un renommage de dossier rendrait le fichier introuvable et
  // chaque contrôle suivant passerait triomphalement sur une chaîne vide.
  assert.ok(existsSync(routeFile), `introuvable : ${routeFile}`);
  assert.ok(readFileSync(routeFile, "utf8").length > 200);
});

test("elle exige la clé de service — elle n'est jamais publique", () => {
  const src = readFileSync(routeFile, "utf8");
  assert.match(src, /hasServiceKey\s*\(/, "la garde S2S doit être appelée");
  assert.match(src, /status:\s*401/, "et rendre 401 quand elle manque");
});

test("elle borne la lecture au tenant demandé — deux fois plutôt qu'une", () => {
  const src = readFileSync(routeFile, "utf8");
  assert.match(src, /withTenant\s*\(/, "GUC + RLS forcée");
  assert.match(src, /tenantId/, "et un where explicite sur le tenant");
  assert.match(src, /status:\s*400/, "tenantId manquant = 400, pas une lecture au hasard");
});

test("tout montant sort par xpf() — un BigInt brut ferait LEVER la sérialisation JSON", () => {
  const src = readFileSync(routeFile, "utf8");
  // Les champs monétaires du modèle (schema.prisma) qui transitent par cette route.
  // ⚠️ On ancre le nom en DÉBUT de propriété : `subtotalXpf:` contient `totalXpf:`, une
  // recherche par sous-chaîne validerait la mauvaise ligne et le test ne mordrait plus
  // (constaté en écrivant ce fichier — une mutation de contrôle passait inaperçue).
  for (const champ of ["subtotalXpf", "totalXpf", "unitXpf", "lineXpf", "amountXpf"]) {
    const motif = new RegExp(`(^|[^A-Za-z])${champ}\\s*:`);
    const lignes = src.split("\n").filter((l) => motif.test(l));
    assert.ok(lignes.length > 0, `le champ ${champ} doit figurer dans la réponse`);
    for (const l of lignes) {
      assert.match(l, /xpf\(/, `${champ} doit passer par xpf() — sinon 500 au clic sur « Avoir »`);
    }
  }
});

test("elle rend les lignes AVEC leur productId et leur qty — c'est ce qui remet le stock", () => {
  const src = readFileSync(routeFile, "utf8");
  assert.match(src, /lines:/, "les lignes du ticket");
  assert.match(src, /productId/, "sans productId, la surface ne sait pas quel article remettre");
  assert.match(src, /qty/, "sans qty, elle ne sait pas combien en remettre");
  assert.match(src, /kind/, "sans kind, elle remettrait aussi les prestations en stock");
});

test("un ticket inexistant rend 404 — jamais un objet vide qui passerait pour un ticket", () => {
  const src = readFileSync(routeFile, "utf8");
  assert.match(src, /status:\s*404/);
});
