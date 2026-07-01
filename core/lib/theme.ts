// theme.ts — applique la charte d'un marchand par requête.
// Le `Tenant.theme` (core_auth) ne stocke que 3 bases (ink/sage/blush) ; on en DÉRIVE
// les ~11 variables CSS utilisées par globals.css. Posées en style inline sur <html>,
// elles surchargent le :root figé (l'inline gagne, quel que soit l'ordre des feuilles).

type Theme = { ink?: string; sage?: string; blush?: string } | null | undefined;

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "").trim();
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(f)) return null;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}

const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((x) => clamp(x).toString(16).padStart(2, "0")).join("");

/** Mélange a→b à hauteur t (0..1) par canal. */
function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  if (!ca || !cb) return a;
  return toHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}
const darken = (hex: string, t: number) => mix(hex, "#000000", t);

/**
 * Dérive les variables CSS de charte du marchand depuis ses 3 bases.
 * Renvoie {} si le thème est absent/invalide → on retombe sur le :root par défaut.
 * À poser en `style` inline sur <html>.
 */
export function themeStyleVars(theme: Theme): Record<string, string> {
  if (!theme?.ink || !theme?.sage || !theme?.blush) return {};
  if (!hexToRgb(theme.ink) || !hexToRgb(theme.sage) || !hexToRgb(theme.blush)) return {};
  const { ink, sage, blush } = theme;
  const line = mix(blush, ink, 0.14);
  return {
    "--blush": blush,
    "--blush-2": mix(blush, ink, 0.03),
    "--cream": mix(blush, sage, 0.1),
    "--sage": sage,
    "--sage-soft": mix(sage, blush, 0.45),
    "--sage-deep": darken(sage, 0.18),
    "--sage-ink": darken(sage, 0.32),
    "--ink": ink,
    "--muted": mix(ink, blush, 0.42),
    "--line": line,
    "--line-sage": mix(line, sage, 0.45),
  };
}
