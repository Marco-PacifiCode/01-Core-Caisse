// Contrat de GET /api/sales — la LISTE des tickets, et sa ventilation par moyen de paiement.
//
// POURQUOI CE TEST EXISTE
// Cette route alimente le « journal des tickets » des trois surfaces. Elle chargeait déjà
// les paiements de chaque vente (`include: { payments: … }`) mais n'en sortait QUE la somme :
// le `method` était lu puis jeté. Conséquence concrète, mesurée le 2026-08-10 : aucun écran
// ne pouvait dire « combien en espèces, combien en carte », et la seule façon de l'obtenir
// était une requête SQL à la main sur le VPS.
//
// POURQUOI IL LIT LE CODE SOURCE (même raison que `sale-read-route.test.ts`)
// Le runner du repo (`node --test --experimental-strip-types`) ne peut pas EXÉCUTER un route
// handler : il importerait `next/server` sans contexte Next et `@prisma/client` sans client
// généré. On fige donc le contrat en lisant le source.
//
// Ce que ces assertions attrapent réellement :
//  · la clé de service retirée → la route deviendrait publique ;
//  · le `withTenant` retiré → un salon lirait les tickets d'un autre (RLS contournée) ;
//  · `payments` retiré du rendu → la ventilation redeviendrait muette, sans erreur ;
//  · un `amountXpf` sérialisé sans `xpf()` → `NextResponse.json` LÈVE sur le BigInt et la
//    route rend 500 : le journal se vide à l'écran, sans un message d'erreur.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const routeFile = path.join(libDir, "..", "app", "api", "sales", "route.ts");

/** Corps de la fonction GET seule — pour ne pas valider une assertion sur le POST voisin. */
function getBody(): string {
  const src = readFileSync(routeFile, "utf8");
  const debut = src.indexOf("export async function GET");
  assert.ok(debut > -1, "GET introuvable dans la route");
  return src.slice(debut);
}

test("la route de liste des tickets existe (sinon tout le reste serait vert pour rien)", () => {
  // Sans cette assertion, un renommage de dossier rendrait le fichier introuvable et chaque
  // contrôle suivant passerait triomphalement sur une chaîne vide.
  assert.ok(existsSync(routeFile), `introuvable : ${routeFile}`);
  assert.ok(readFileSync(routeFile, "utf8").length > 200);
});

test("GET exige la clé de service", () => {
  assert.match(getBody(), /hasServiceKey\(req\)/);
});

test("GET borne la lecture au tenant (withTenant, pas un findMany nu)", () => {
  const body = getBody();
  assert.match(body, /withTenant\(\s*tenantId/);
  assert.match(body, /tenantId,/);
});

test("VENTILATION : le rendu expose `payments` avec son `method`", () => {
  // C'est LE point de ce fichier. La donnée était déjà chargée ; ce qui manquait, c'était
  // de la rendre. Si quelqu'un « nettoie » ce map en croyant qu'il fait doublon avec
  // `paidXpf`, la ventilation disparaît des trois surfaces sans qu'aucun test ne tombe.
  const body = getBody();
  assert.match(body, /payments:\s*s\.payments\.map/);
  assert.match(body, /method:\s*p\.method/);
});

test("VENTILATION : `amountXpf` passe par xpf() — un BigInt brut ferait rendre 500", () => {
  // Ancré sur la propriété entière : `subtotalXpf:` contient `totalXpf:`, une recherche par
  // sous-chaîne validerait la mauvaise ligne. Le piège a déjà été payé sur ce dépôt.
  assert.match(getBody(), /amountXpf:\s*xpf\(p\.amountXpf\)/);
});

test("`paidXpf` reste la SOMME des paiements (la ventilation ne le remplace pas)", () => {
  // Les deux coexistent volontairement : `paidXpf` sert au total d'un ticket, `payments`
  // sert à la ventilation. Retirer l'un au profit de l'autre casserait un appelant.
  assert.match(getBody(), /paidXpf:\s*xpf\(s\.payments\.reduce/);
});

test("les paiements sont chargés en UNE fois (include), pas par ticket", () => {
  // Garde anti-N+1 : la ventilation ne doit jamais devenir « un appel par ticket ».
  // C'est précisément ce qu'on croyait devoir faire avant de relire la route.
  const body = getBody();
  assert.match(body, /include:\s*\{\s*payments:/);
  assert.ok(!/for\s*\(.*await/s.test(body), "boucle await détectée dans GET (N+1)");
});

test("la limite reste bornée (pas de lecture illimitée)", () => {
  assert.match(getBody(), /Math\.min\(/);
});
