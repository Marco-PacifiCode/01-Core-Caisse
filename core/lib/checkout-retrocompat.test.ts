// Rétrocompatibilité du checkout Core-Caisse avec la prod 92aea55 (commandes de bons en ligne).
//
// CE QUE CES TESTS PROTÈGENT
// Les surfaces en prod (Rôtisserie, PLW-Gym…) appellent le checkout SANS `orderId` ni `message`.
// Pour elles, rien ne doit changer : même entrée acceptée/refusée, même chemin (aucune requête
// `giftCardOrder`), même forme de réponse (aucun champ retiré ni renommé).
//   (a) Entrée  : validateGiftCard / validateGiftCards courants vs copie figée de la prod
//                 (lib/__fixtures__/gift-card.prod-92aea55.ts).
//   (b) Réponse : la réponse 200 est construite INLINE dans lib/caisse.ts#checkoutSale (et la
//                 route la renvoie telle quelle) → comparaison structurelle avec `git show 92aea55`.
//   (c) Chemin  : tout accès `giftCardOrder` du checkout est sous `if (g.orderId)` ; codes HTTP
//                 de la prod ⊆ codes courants dans la route checkout.
//
// Exécution : cd core && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateGiftCard, validateGiftCards, type GiftCardInput } from "./gift-card.ts";
import {
  validateGiftCard as validateGiftCardProd,
  validateGiftCards as validateGiftCardsProd,
} from "./__fixtures__/gift-card.prod-92aea55.ts";

const PROD = "92aea55";
const CAISSE = "lib/caisse.ts";
const ROUTE = "app/api/sales/[id]/checkout/route.ts";

function inputNominal(extra: Partial<GiftCardInput> = {}): GiftCardInput {
  return { code: "bc 4k7q-p2", amountXpf: 5000, beneficiaryName: "Camille", ...extra };
}

/** Source prod d'un fichier de core/, ou null si git est indisponible. */
function prodSource(rel: string): string | null {
  try {
    return execFileSync("git", ["show", `${PROD}:core/${rel}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function currentSource(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** Bloc équilibré en accolades commençant à la première occurrence de `start`. */
function block(src: string, start: string, from = 0): { text: string; begin: number; end: number } {
  const begin = src.indexOf(start, from);
  assert.ok(begin >= 0, `bloc introuvable : ${start}`);
  let i = src.indexOf("{", begin);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return { text: src.slice(begin, i + 1), begin, end: i + 1 };
}

/** Fonction exportée entière : du `export async function` jusqu’à la prochaine déclaration exportée. */
function fnSource(src: string, start: string): string {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `fonction introuvable : ${start}`);
  const b = src.indexOf("\nexport ", a + start.length);
  return src.slice(a, b < 0 ? undefined : b);
}

const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

/** Toutes les lignes de `prod` se retrouvent, dans l'ordre, dans `cur` (identique ou ajouts seuls). */
function assertOnlyAdditions(prod: string, cur: string, label: string) {
  const p = lines(prod);
  const c = lines(cur);
  let j = 0;
  for (const l of p) {
    while (j < c.length && c[j] !== l) j++;
    assert.ok(j < c.length, `${label} : ligne prod absente ou réordonnée → « ${l} »`);
    j++;
  }
}

// ── (a) Entrée ──────────────────────────────────────────────────────────────────────────────

test("(a) bon classique sans message ni orderId : data = prod + message:null + orderId:null", () => {
  const cur = validateGiftCard(inputNominal());
  const prod = validateGiftCardProd(inputNominal());
  assert.equal(cur.ok, true);
  assert.equal(prod.ok, true);
  if (cur.ok && prod.ok) {
    assert.deepEqual(cur.data, { ...prod.data, message: null, orderId: null });
  }
});

test("(a) bon complet (bénéficiaire, téléphone, expiration) sans orderId : même data que la prod", () => {
  const input = inputNominal({ beneficiaryPhone: "687123456", serviceLabel: "Massage", expiresAt: "2027-01-31" });
  const cur = validateGiftCard(input);
  const prod = validateGiftCardProd(input);
  assert.equal(cur.ok, prod.ok);
  if (cur.ok && prod.ok) assert.deepEqual(cur.data, { ...prod.data, message: null, orderId: null });
});

for (const [label, extra] of [
  ["code vide", { code: "" }],
  ["montant nul", { amountXpf: 0 }],
  ["sans bénéficiaire", { beneficiaryName: undefined }],
] as const) {
  test(`(a) refus classique (${label}) : même code de refus que la prod`, () => {
    const cur = validateGiftCard(inputNominal(extra as Partial<GiftCardInput>));
    const prod = validateGiftCardProd(inputNominal(extra as Partial<GiftCardInput>));
    assert.equal(prod.ok, false);
    assert.deepEqual(cur, prod);
  });
}

test("(a) validateGiftCards sans orderId : succès et doublon de code identiques à la prod", () => {
  const two = [inputNominal(), inputNominal({ code: "BC2222" })];
  const cur = validateGiftCards(two);
  const prod = validateGiftCardsProd(two);
  assert.equal(cur.ok, true);
  if (cur.ok && prod.ok) assert.deepEqual(cur.data, prod.data.map((d) => ({ ...d, message: null, orderId: null })));
  const dup = [inputNominal(), inputNominal()];
  assert.deepEqual(validateGiftCards(dup), validateGiftCardsProd(dup));
});

// ── (b) Réponse ─────────────────────────────────────────────────────────────────────────────

test("(b) réponse 200 de checkoutSale, rows.push des bons émis et type GiftCardIssued : prod ⊆ courant", (t) => {
  const prod = prodSource(CAISSE);
  if (prod === null) return t.skip("git indisponible");
  const cur = currentSource(CAISSE);
  const fnP = fnSource(prod, "export async function checkoutSale(");
  const fnC = fnSource(cur, "export async function checkoutSale(");
  // Bloc de la réponse 200 : `return { ok: true, saleId, status: "PAID", … }`.
  const ret = (s: string) => block(s, "return {\n    ok: true,\n    saleId,", 0).text;
  assert.equal(ret(fnC.replace(/\r\n/g, "\n")), ret(fnP.replace(/\r\n/g, "\n")), "réponse 200 modifiée");
  // Éléments de `giftCards[]` dans la réponse.
  assertOnlyAdditions(block(fnP, "rows.push({").text, block(fnC, "rows.push({").text, "rows.push");
  assertOnlyAdditions(block(prod, "export type GiftCardIssued").text, block(cur, "export type GiftCardIssued").text, "GiftCardIssued");
});

test("(b) la route checkout renvoie le résultat tel quel, comme en prod", (t) => {
  const prod = prodSource(ROUTE);
  if (prod === null) return t.skip("git indisponible");
  const cur = currentSource(ROUTE);
  assert.ok(prod.includes("return NextResponse.json(result);"));
  assert.ok(cur.includes("return NextResponse.json(result);"));
});

// ── (c) Chemin ──────────────────────────────────────────────────────────────────────────────

test("(c) checkoutSale : tout accès giftCardOrder / orderRace.id = est sous `if (g.orderId)` ou `if (giftCardsWithOrder.length > 0)`", () => {
  const fn = fnSource(currentSource(CAISSE), "export async function checkoutSale(");
  const guarded: Array<[number, number]> = [];
  for (const garde of ["if (g.orderId) {", "if (giftCardsWithOrder.length > 0) {"]) {
    let from = 0;
    while (fn.indexOf(garde, from) >= 0) {
      const b = block(fn, garde, from);
      guarded.push([b.begin, b.end]);
      from = b.end;
    }
  }
  assert.ok(guarded.length >= 1, "garde `if (g.orderId)` attendue");
  assert.ok(
    fn.includes("const giftCardsWithOrder = giftCardsToIssue.filter((g) => g.orderId);"),
    "giftCardsWithOrder doit être giftCardsToIssue.filter((g) => g.orderId)",
  );
  for (const re of [/giftCardOrder/g, /orderRace\.id = /g]) {
    for (const m of fn.matchAll(re)) {
      const pos = m.index ?? -1;
      assert.ok(guarded.some(([a, b]) => pos > a && pos < b), `${m[0]} hors garde orderId (offset ${pos})`);
    }
  }
});

test("(c) route checkout : codes HTTP de la prod ⊆ codes courants", (t) => {
  const prod = prodSource(ROUTE);
  if (prod === null) return t.skip("git indisponible");
  const cur = currentSource(ROUTE);
  const codes = (s: string) => new Set([...s.matchAll(/(?:\b[A-Z_]+|status):\s*(\d{3})\b/g)].map((m) => `${m[0].split(":")[0]}=${m[1]}`));
  const p = codes(prod);
  const c = codes(cur);
  assert.ok(p.size > 0);
  for (const k of p) {
    if (k.startsWith("status=")) assert.ok(c.has(k), `code perdu : ${k}`);
    else assert.ok(c.has(k), `mapping erreur→HTTP perdu ou modifié : ${k}`);
  }
});
