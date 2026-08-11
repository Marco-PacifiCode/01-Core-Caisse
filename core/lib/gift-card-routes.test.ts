// Contrat des routes bons cadeaux + atomicité des écritures — lit le SOURCE (lib/caisse.ts +
// app/api/gift-cards/**, app/api/sales/:id/checkout).
//
// POURQUOI CE TEST LIT LE CODE SOURCE (même raison que sales-list-route.test.ts)
// Le runner du repo (`node --test --experimental-strip-types`) ne peut pas EXÉCUTER un route
// handler ni une fonction qui parle à Prisma : il importerait `next/server` sans contexte Next
// et `@prisma/client` sans client généré. On fige donc le contrat en lisant le source.
//
// CE QUE CES ASSERTIONS ATTRAPENT RÉELLEMENT :
//  · la clé de service retirée sur une route bon cadeau → elle deviendrait publique ;
//  · le `updateMany` conditionnel remplacé par un `findFirst` + `update` → deux comptoirs qui
//    présentent le même bon à la même seconde le passent tous les deux (double dépense) ;
//  · une écriture de comptabilité qui s'introduit dans `redeemGiftCard` → le salon compte le
//    même argent deux fois (une fois à l'achat, une fois à la consommation) ;
//  · `giftCards` qui deviendrait obligatoire sur `POST /api/sales/:id/checkout` → la requête et
//    la réponse des marchands qui n'émettent pas de bons cesseraient d'être identiques.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));

const giftCardsRouteFile = path.join(libDir, "..", "app", "api", "gift-cards", "route.ts");
const redeemRouteFile = path.join(libDir, "..", "app", "api", "gift-cards", "[id]", "redeem", "route.ts");
const cancelRouteFile = path.join(libDir, "..", "app", "api", "gift-cards", "[id]", "cancel", "route.ts");
const checkoutRouteFile = path.join(libDir, "..", "app", "api", "sales", "[id]", "checkout", "route.ts");
const caisseFile = path.join(libDir, "caisse.ts");

const ROUTE_FILES = [giftCardsRouteFile, redeemRouteFile, cancelRouteFile, checkoutRouteFile];

/** Corps d'une fonction exportée : de `export async function <name>` jusqu'au prochain `export`. */
function exportBody(src: string, name: string): string {
  const debut = src.indexOf(`export async function ${name}`);
  assert.ok(debut > -1, `${name} introuvable`);
  const reste = src.slice(debut);
  const finRelative = reste.indexOf("\nexport ", 1);
  return finRelative > -1 ? reste.slice(0, finRelative) : reste;
}

/** Isole un bloc [début, fin] inclus, pour ne pas laisser une assertion mordre sur le voisin. */
function isolateBlock(corps: string, startMarker: string, endMarker: string): string {
  const s = corps.indexOf(startMarker);
  assert.ok(s > -1, `marqueur de début introuvable : ${startMarker}`);
  const e = corps.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > -1, `marqueur de fin introuvable : ${endMarker}`);
  return corps.slice(s, e + endMarker.length);
}

function giftCardsRouteSrc(): string {
  return readFileSync(giftCardsRouteFile, "utf8");
}
function giftCardsGetBody(): string {
  return exportBody(giftCardsRouteSrc(), "GET");
}
function giftCardsPostBody(): string {
  return exportBody(giftCardsRouteSrc(), "POST");
}
function redeemBody(): string {
  return exportBody(readFileSync(redeemRouteFile, "utf8"), "POST");
}
function cancelBody(): string {
  return exportBody(readFileSync(cancelRouteFile, "utf8"), "POST");
}
function checkoutSrc(): string {
  return readFileSync(checkoutRouteFile, "utf8");
}
function caisseSrc(): string {
  return readFileSync(caisseFile, "utf8");
}
function corpsRedeemGiftCard(): string {
  return exportBody(caisseSrc(), "redeemGiftCard");
}
function corpsCancelGiftCard(): string {
  return exportBody(caisseSrc(), "cancelGiftCard");
}
function corpsCloseSession(): string {
  return exportBody(caisseSrc(), "closeSession");
}
function corpsCheckoutSale(): string {
  return exportBody(caisseSrc(), "checkoutSale");
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// 1. Les 4 fichiers de route existent (sinon tout le reste serait vert sur une chaîne vide)
// ══════════════════════════════════════════════════════════════════════════════════════════

test("les 4 routes bons cadeaux existent et ne sont pas des coquilles vides", () => {
  for (const f of ROUTE_FILES) {
    assert.ok(existsSync(f), `introuvable : ${f}`);
    assert.ok(readFileSync(f, "utf8").length > 200, `trop court, suspect : ${f}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 2. Clé de service — chaque route S2S exige hasServiceKey(req)
// ══════════════════════════════════════════════════════════════════════════════════════════

test("GET /api/gift-cards exige la clé de service", () => {
  assert.match(giftCardsGetBody(), /hasServiceKey\(req\)/);
});

test("POST /api/gift-cards exige la clé de service", () => {
  assert.match(giftCardsPostBody(), /hasServiceKey\(req\)/);
});

test("POST /api/gift-cards/:id/redeem exige la clé de service", () => {
  assert.match(redeemBody(), /hasServiceKey\(req\)/);
});

test("POST /api/gift-cards/:id/cancel exige la clé de service", () => {
  assert.match(cancelBody(), /hasServiceKey\(req\)/);
});

test("POST /api/sales/:id/checkout exige la clé de service", () => {
  assert.match(checkoutSrc(), /hasServiceKey\(req\)/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 3. tenantId — chaque route S2S l'exige explicitement
// ══════════════════════════════════════════════════════════════════════════════════════════

test("GET /api/gift-cards exige tenantId", () => {
  assert.match(giftCardsGetBody(), /tenantId requis/);
});

test("POST /api/gift-cards exige tenantId", () => {
  assert.match(giftCardsPostBody(), /tenantId requis/);
});

test("POST /api/gift-cards/:id/redeem exige tenantId", () => {
  assert.match(redeemBody(), /tenantId requis/);
});

test("POST /api/gift-cards/:id/cancel exige tenantId", () => {
  assert.match(cancelBody(), /tenantId requis/);
});

test("POST /api/sales/:id/checkout exige tenantId", () => {
  assert.match(checkoutSrc(), /tenantId requis/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 4. NOT_FOUND → 404 sur redeem et cancel
// ══════════════════════════════════════════════════════════════════════════════════════════

test("redeem mappe NOT_FOUND en 404", () => {
  assert.match(redeemBody(), /NOT_FOUND.*404/s);
});

test("cancel mappe NOT_FOUND en 404", () => {
  assert.match(cancelBody(), /NOT_FOUND.*404/s);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 5. 🔴 ATOMICITÉ — LE TEST QUI COMPTE
// ══════════════════════════════════════════════════════════════════════════════════════════

test("redeemGiftCard : un updateMany, pas un update par id", () => {
  assert.match(corpsRedeemGiftCard(), /updateMany\(/);
});

test("redeemGiftCard : la condition redeemedAt IS NULL est dans le WHERE", () => {
  assert.match(corpsRedeemGiftCard(), /redeemedAt:\s*null/);
});

test("redeemGiftCard : le refus vient du nombre de lignes affectées (count === 0)", () => {
  assert.match(corpsRedeemGiftCard(), /count === 0/);
});

test("🔴 redeemGiftCard : AUCUN findFirst avant le updateMany — lire pour vérifier PUIS écrire ouvrirait une fenêtre de double dépense", () => {
  // Lire pour vérifier que le bon est libre PUIS écrire, c'est laisser un intervalle pendant
  // lequel le bon part deux fois — deux prestations rendues pour un seul encaissement. La
  // relecture n'a le droit d'exister qu'APRÈS l'échec, et seulement pour NOMMER le refus.
  const corps = corpsRedeemGiftCard();
  const iUpdate = corps.indexOf("updateMany");
  const iFind = corps.indexOf("findFirst");
  assert.ok(iUpdate > -1, "updateMany introuvable dans redeemGiftCard");
  assert.ok(
    iFind === -1 || iFind > iUpdate,
    "un findFirst précède le updateMany dans redeemGiftCard — fenêtre de double dépense",
  );
});

test("cancelGiftCard : un updateMany, pas un update par id", () => {
  assert.match(corpsCancelGiftCard(), /updateMany\(/);
});

test("cancelGiftCard : la condition redeemedAt IS NULL est dans le WHERE (un bon consommé ne s'annule pas)", () => {
  assert.match(corpsCancelGiftCard(), /redeemedAt:\s*null/);
});

test("🔴 cancelGiftCard : AUCUN findFirst avant le updateMany — même raison que redeemGiftCard", () => {
  const corps = corpsCancelGiftCard();
  const iUpdate = corps.indexOf("updateMany");
  const iFind = corps.indexOf("findFirst");
  assert.ok(iUpdate > -1, "updateMany introuvable dans cancelGiftCard");
  assert.ok(
    iFind === -1 || iFind > iUpdate,
    "un findFirst précède le updateMany dans cancelGiftCard — fenêtre de double dépense",
  );
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 6. 🔒 CONSOMMATION = ZÉRO COMPTABILITÉ
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// Le montant d'un bon est entré dans le CA le jour de son achat. Si une de ces écritures
// apparaît dans redeemGiftCard, le salon compte le même argent deux fois.

const CHAINES_INTERDITES = [
  "salePayment",
  "cashMovement",
  "comptaClient",
  "syncLoadedSale",
  "runSaleSync",
  "sale.create",
  "sale.update",
];

for (const chaine of CHAINES_INTERDITES) {
  test(`🔒 redeemGiftCard ne contient jamais « ${chaine} » — la consommation n'a aucune comptabilité`, () => {
    assert.ok(!corpsRedeemGiftCard().includes(chaine), `« ${chaine} » trouvé dans redeemGiftCard`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// 7. 🔒 LE Z — les deux champs sont INFORMATIFS, hors CA et hors attendu du tiroir
// ══════════════════════════════════════════════════════════════════════════════════════════

test("closeSession produit bien giftCardRedeemedCount et giftCardRedeemedXpf", () => {
  const corps = corpsCloseSession();
  assert.match(corps, /giftCardRedeemedCount/);
  assert.match(corps, /giftCardRedeemedXpf/);
});

test("🔴 closeSession : l'appel à expectedCashXpf ne mentionne aucun bon cadeau", () => {
  // Les deux champs du Z sont INFORMATIFS ; ils n'entrent ni dans le CA ni dans l'attendu du
  // tiroir. `expectedCashXpf` ne reçoit pas de bons — si ce test tombe, quelqu'un a fait
  // transiter un bon par l'attendu du tiroir.
  const appel = isolateBlock(corpsCloseSession(), "expectedCashXpf({", "})");
  assert.ok(!/gift/i.test(appel), `« gift » trouvé dans l'appel à expectedCashXpf : ${appel}`);
});

test("🔴 closeSession : le calcul de totalSales n'additionne jamais un bon cadeau", () => {
  const corps = corpsCloseSession();
  assert.ok(!/totalSales\s*\+=.*[Gg]ift/.test(corps), "totalSales += … gift détecté dans closeSession");
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 8. 🔴 V-CUT ET ELLÉMENT SONT INCHANGÉS — VERROUILLE-LE
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// Ces marchands n'envoient pas ce champ. Ces assertions sont ce qui garantit que leur requête
// ET leur réponse restent identiques à l'octet près : un jour quelqu'un rendra ce paramètre
// obligatoire ou ce champ systématique, et ce test doit tomber ce jour-là.

test("checkout route : giftCards est un champ du body OPTIONNEL", () => {
  assert.match(checkoutSrc(), /giftCards\?:/);
});

test("checkout route : giftCards absent ou vide → checkoutSale est appelé sans options (undefined)", () => {
  assert.match(checkoutSrc(), /body\.giftCards.*length > 0.*undefined/s);
});

test("checkoutSale : le 4e paramètre options est optionnel", () => {
  assert.match(corpsCheckoutSale(), /options\?:/);
});

test("checkoutSale : tout le bloc bons cadeaux est gardé par giftCardInputs.length > 0", () => {
  assert.match(corpsCheckoutSale(), /giftCardInputs\.length > 0/);
});

test("checkoutSale : le champ giftCards de la réponse est omis quand il n'y a pas de bon", () => {
  assert.match(corpsCheckoutSale(), /issued\.length > 0 \?/);
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// 9. 🔴 ÉMISSION ATOMIQUE — l'argent pris ET le bon créé, ou ni l'un ni l'autre
// ══════════════════════════════════════════════════════════════════════════════════════════

test("🔴 checkoutSale : le passage à PAID et la création des bons sont dans LA MÊME transaction", () => {
  // Les deux écritures sont dans la MÊME transaction : soit l'argent est pris ET le bon
  // existe, soit ni l'un ni l'autre.
  const bloc = isolateBlock(corpsCheckoutSale(), "const issued = await withTenant", "  });");
  assert.match(bloc, /status:\s*"PAID"/);
  assert.match(bloc, /tx\.giftCard\.create/);
});
