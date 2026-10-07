// Garde « espaces-jsx » — défaut du compilateur de Next 16.2.x.
// Un texte JSX qui suit un élément ou une expression sur la même ligne, contient un retour à la ligne ET une
// entité HTML (&apos;, &nbsp;…) perd son espace de début : « mot.Suite » à l'écran au lieu de « mot. Suite ».
// Le défaut ne se voit ni dans le source ni dans les tests de texte, seulement sur la page rendue.
//
//   node scripts/espaces-jsx.mjs         liste les textes concernés
//   node scripts/espaces-jsx.mjs --fix   pose un {" "} explicite devant chacun
//
// Outil repris de BrousseConciergerie (2026-10-07). Le défaut est corrigé en amont dans Next 16.3.6 :
// la preuve par compilation ci-dessous le signale, et cette garde pourra alors être retirée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Cas = { position: number; ligne: number; colonne: number; extrait: string };
type Outil = {
  casPerdants: (texteSource: string, nomDeFichier?: string) => Cas[];
  corriger: (texteSource: string, nomDeFichier?: string) => string;
  fichiersTsx: (racine: string) => string[];
};
type Swc = {
  loadBindings: () => Promise<unknown>;
  transform: (src: string, options: unknown) => Promise<{ code: string }>;
};

// Racine de l'application : le premier dossier parent qui porte un package.json.
let racine = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(racine, "package.json"))) racine = dirname(racine);

const charger = async (): Promise<Outil> => import(pathToFileURL(join(racine, "scripts", "espaces-jsx.mjs")).href);
const chargerSwc = async (): Promise<Swc | null> => {
  try {
    const swc: Swc = createRequire(join(racine, "package.json"))("next/dist/build/swc");
    await swc.loadBindings();
    return swc;
  } catch {
    return null;
  }
};

const CANONIQUE = "<p><strong>a</strong> L&apos;adresse est fausse.\n</p>";
const PERDANTS = [
  CANONIQUE,
  "<p>{n} n&apos;existe pas\n</p>",
  '<p><a href="/x">ici</a> l&apos;un\n  ou\n</p>',
  "<p><strong>a</strong> bc\n  d&apos;e\n</p>",
];
const SAINS = [
  "<p><strong>a</strong> L'adresse est fausse.\n</p>",
  "<p><strong>a</strong> L&apos;adresse est fausse.</p>",
  "<p>a <strong>a</strong>\n  L&apos;adresse</p>",
  '<p><strong>a</strong>{" "}L&apos;adresse est fausse.\n</p>',
];
const mod = (s: string) => `export const X=()=>(${s});`;

test("espaces-jsx : l'outil détecte les quatre exemples perdants", async () => {
  const outil = await charger();
  for (const s of PERDANTS) assert.equal(outil.casPerdants(mod(s), "x.tsx").length, 1, s);
});

test("espaces-jsx : l'outil ignore les quatre cas sains", async () => {
  const outil = await charger();
  for (const s of SAINS) assert.equal(outil.casPerdants(mod(s), "x.tsx").length, 0, s);
});

test("espaces-jsx : la correction ne change que les blancs de début", async () => {
  const outil = await charger();
  for (const s of PERDANTS) {
    const src = mod(s);
    const fix = outil.corriger(src, "x.tsx");
    assert.equal(outil.casPerdants(fix, "x.tsx").length, 0);
    assert.equal(fix, src.replace(/([>}]) /, '$1{" "}'));
  }
  const crlf = mod(CANONIQUE).replace(/\n/g, "\r\n");
  assert.equal(outil.corriger(crlf, "x.tsx"), crlf.replace(/([>}]) /, '$1{" "}'));
});

test("espaces-jsx : le compilateur garde l'espace du texte corrigé", async () => {
  const outil = await charger();
  const swc = await chargerSwc();
  if (!swc) return; // Next introuvable : rien à prouver ici
  const compile = async (src: string) =>
    (
      await swc.transform(src, {
        jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      })
    ).code;
  const garde = (code: string) => code.includes('" ",') || code.includes("\" L'adresse");
  const src = mod(CANONIQUE);
  assert.ok(garde(await compile(outil.corriger(src, "x.tsx"))), "espace perdu après correction");
  if (garde(await compile(src))) {
    process.emitWarning("espaces-jsx : défaut du compilateur corrigé en amont, cette garde peut être retirée");
  }
});

test("espaces-jsx : aucun texte JSX ne perd son espace de début dans les .tsx", async () => {
  const outil = await charger();
  const liste: string[] = [];
  for (const f of outil.fichiersTsx(racine)) {
    for (const c of outil.casPerdants(readFileSync(f, "utf8"), f)) {
      liste.push(`${relative(racine, f).split(sep).join("/")}:${c.ligne}`);
    }
  }
  assert.equal(
    liste.length,
    0,
    `${liste.length} texte(s) JSX perdraient leur espace de début (défaut du compilateur de Next) :\n${liste.join("\n")}\nLancer : node scripts/espaces-jsx.mjs --fix`,
  );
});
