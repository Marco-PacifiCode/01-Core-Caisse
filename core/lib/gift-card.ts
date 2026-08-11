// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/gift-card.ts — logique PURE des bons cadeaux (PC-0064).
//
// 🔒 L'INVARIANT DU MODULE, ET IL PASSE AVANT TOUT LE RESTE :
//
//        LE MONTANT D'UN BON ENTRE DANS LE CHIFFRE D'AFFAIRES UNE SEULE FOIS,
//        LE JOUR DE SON ACHAT.
//
//    Un bon cadeau est une PRESTATION VENDUE À L'AVANCE, pas un moyen de paiement.
//
//    · L'ACHAT est le jumeau exact d'une vente au comptoir : l'argent est encaissé, le Z le
//      compte, une facture part au nom de l'ACHETEUR. Il passe par `checkoutSale`, comme
//      n'importe quel ticket.
//    · LA CONSOMMATION N'A AUCUNE COMPTABILITÉ. Aucune facture, aucun paiement, aucun mouvement
//      de tiroir, aucun total du Z. Le jour où la cliente présente son bon, il ne se passe RIEN
//      côté argent — parce que l'argent est déjà passé. Encaisser à nouveau les francs du bon
//      compterait le même argent deux fois : c'est l'erreur exacte que ce module empêche.
//    · Le Z ne porte que deux champs INFORMATIFS (un compte, un montant), délibérément hors de
//      `totalSalesXpf` ET de `expectedXpf`. Et l'invariant ne tient pas par une note de bas de
//      page : il tient par la SIGNATURE. `expectedCashXpf` (lib/cash-movement.ts) ne reçoit pas
//      les bons, et `summarizeRedeemedGiftCards` ci-dessous ne rend rien qui puisse y entrer.
//      Pour casser l'invariant, il faudrait changer un prototype — pas oublier une ligne.
//
// CONTRAT DE PURETÉ (identique à lib/cash-movement.ts et lib/money.ts) : AUCUN import runtime —
// ni `@prisma/client`, ni `next/*`, ni `./tenant`. Le runner de tests est
// `node --test --experimental-strip-types`, qui exécute ce fichier directement, sans client
// Prisma généré ni contexte Next. Un seul `import` ici et toute la suite de tests tombe.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// ── Statut : DÉRIVÉ, jamais stocké ───────────────────────────────────────────────────────────
// Un statut en base exigerait de faire expirer les bons par un traitement de fond, c'est-à-dire
// de laisser la production se modifier toute seule. On calcule à la lecture, c'est tout.

export type GiftCardStatus =
  | "VALID" // ni consommé, ni annulé, ni périmé
  | "REDEEMED" // consommé — BINAIRE, il n'y a pas de « partiellement consommé »
  | "CANCELLED" // annulé par l'administratrice
  | "EXPIRED"; // date de validité dépassée à l'instant où on regarde

export type GiftCardStateLike = {
  redeemedAt: Date | string | null;
  cancelledAt: Date | string | null;
  expiresAt: Date | string | null;
};

/** Millisecondes d'une date qui peut arriver en `Date` (Prisma) ou en ISO (JSON). `null` si illisible. */
function toMs(v: Date | string | null | undefined): number | null {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Statut affichable, calculé à l'instant `now`.
 *
 * L'ORDRE EST LE CONTRAT, pas un détail de lecture : un bon annulé reste annulé même périmé, et
 * un bon consommé reste consommé même après sa date de validité. Inverser ces deux lignes ferait
 * dire à l'écran qu'un bon déjà utilisé « a expiré » — donc mentir sur ce qui s'est passé, au
 * moment précis où quelqu'un cherche à comprendre.
 */
export function giftCardStatus(card: GiftCardStateLike, now: Date = new Date()): GiftCardStatus {
  if (card.cancelledAt) return "CANCELLED";
  if (card.redeemedAt) return "REDEEMED";
  const exp = toMs(card.expiresAt);
  if (exp !== null && exp < now.getTime()) return "EXPIRED";
  return "VALID";
}

/**
 * Le bon est-il encore consommable ?
 *
 * 🔴 L'EXPIRATION NE BLOQUE PAS, ET C'EST DÉLIBÉRÉ. Accepter ou refuser un bon périmé est une
 * décision du COMMERCE, pas du moteur : la cliente est au comptoir, le salon tranche. Le moteur
 * refuse ce qui est objectivement impossible — un bon déjà consommé, un bon annulé — et laisse la
 * date de validité à l'écran, qui l'affiche en clair pour que l'employée décide en connaissance
 * de cause. Un moteur qui refuserait tout seul rendrait la règle inapplicable au comptoir.
 */
export function isRedeemable(card: Pick<GiftCardStateLike, "redeemedAt" | "cancelledAt">): boolean {
  return !card.cancelledAt && !card.redeemedAt;
}

// ── Refus nommés ─────────────────────────────────────────────────────────────────────────────
// Même convention que MovementRefusal : union de littéraux SCREAMING_SNAKE, renvoyée telle quelle
// dans la réponse HTTP. Jamais d'exception, jamais de message libre côté moteur.

export type GiftCardRefusal =
  | "AMOUNT_NOT_POSITIVE" // 0 ou négatif : un bon qui ne vaut rien n'est pas un bon
  | "AMOUNT_NOT_INTEGER" // XPF = franc entier. Pas de centime, jamais.
  | "CODE_REQUIRED" // sans code, le bon est introuvable au comptoir
  | "CODE_TOO_LONG"
  | "BENEFICIARY_REQUIRED" // il faut savoir À QUI le bon est destiné, sinon on ne le retrouve pas
  | "EXPIRY_INVALID"; // une date de validité illisible vaut mieux refusée que stockée de travers

export type GiftCardRedeemRefusal =
  | "NOT_FOUND"
  | "ALREADY_REDEEMED" // 🔴 le refus que produit l'UPDATE conditionnel : 0 ligne affectée
  | "CANCELLED"
  | "REDEEMED_FOR_NOT_INTEGER"
  | "REDEEMED_FOR_NEGATIVE";

export type GiftCardCancelRefusal = "NOT_FOUND" | "ALREADY_REDEEMED" | "ALREADY_CANCELLED";

// ── Normalisation des entrées réseau ─────────────────────────────────────────────────────────
// Le JSON ne transporte pas de BigInt : les montants arrivent en `number` ou en `string`. Ces
// fonctions rendent un `bigint` ou un refus nommé — jamais une valeur douteuse.

export function normalizeGiftCardAmount(
  raw: unknown,
): { ok: true; amountXpf: bigint } | { ok: false; error: GiftCardRefusal } {
  let v: bigint;
  if (typeof raw === "bigint") {
    v = raw;
  } else if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, error: "AMOUNT_NOT_INTEGER" };
    if (!Number.isInteger(raw)) return { ok: false, error: "AMOUNT_NOT_INTEGER" };
    v = BigInt(raw);
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!/^-?\d+$/.test(s)) return { ok: false, error: "AMOUNT_NOT_INTEGER" };
    v = BigInt(s);
  } else {
    return { ok: false, error: "AMOUNT_NOT_INTEGER" };
  }
  if (v <= 0n) return { ok: false, error: "AMOUNT_NOT_POSITIVE" };
  return { ok: true, amountXpf: v };
}

/**
 * Prix de la prestation le jour de l'échange. FACULTATIF, et il ne calcule AUCUN solde — il n'y a
 * pas de solde, le bon est binaire. Il ne sert qu'à recouper la caisse après coup.
 * `null`/`undefined` → `null` (non renseigné), et ce n'est pas une erreur.
 */
export function normalizeRedeemedFor(
  raw: unknown,
): { ok: true; redeemedForXpf: bigint | null } | { ok: false; error: GiftCardRedeemRefusal } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, redeemedForXpf: null };
  let v: bigint;
  if (typeof raw === "bigint") {
    v = raw;
  } else if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return { ok: false, error: "REDEEMED_FOR_NOT_INTEGER" };
    v = BigInt(raw);
  } else if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    v = BigInt(raw.trim());
  } else {
    return { ok: false, error: "REDEEMED_FOR_NOT_INTEGER" };
  }
  if (v < 0n) return { ok: false, error: "REDEEMED_FOR_NEGATIVE" };
  return { ok: true, redeemedForXpf: v };
}

/**
 * Code comparable : majuscules, sans espace ni séparateur.
 *
 * Un code est recopié À LA MAIN d'un bon papier vers un écran, souvent par une autre personne que
 * celle qui l'a écrit. « bc 4k7q p2 », « BC-4K7QP2 » et « bc4k7qp2 » désignent le même bon, et
 * refuser l'un des trois au comptoir n'apporte rien à personne. La normalisation est appliquée
 * À L'ÉCRITURE COMME À LA LECTURE — c'est ce qui rend `@@unique(tenantId, code)` fiable : deux
 * écritures d'un même code sous deux graphies ne doivent pas produire deux bons.
 */
export function normalizeCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Texte court optionnel : `trim`, mono-ligne, borné. `""` → `null`. */
export function normalizeText(raw: unknown, max = 200): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim().slice(0, max);
  return s.length > 0 ? s : null;
}

/** Date de validité : `null` (sans limite) ou une date lisible. Une valeur illisible est un REFUS. */
export function normalizeExpiry(
  raw: unknown,
): { ok: true; expiresAt: Date | null } | { ok: false; error: GiftCardRefusal } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, expiresAt: null };
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? { ok: true, expiresAt: raw } : { ok: false, error: "EXPIRY_INVALID" };
  }
  if (typeof raw !== "string") return { ok: false, error: "EXPIRY_INVALID" };
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return { ok: false, error: "EXPIRY_INVALID" };
  return { ok: true, expiresAt: new Date(t) };
}

// ── Émission ─────────────────────────────────────────────────────────────────────────────────

/** Ce qu'une surface envoie pour faire naître un bon. `serviceLabel` absent = bon en VALEUR. */
export type GiftCardInput = {
  code?: unknown;
  amountXpf?: unknown;
  serviceLabel?: unknown;
  serviceId?: unknown;
  buyerName?: unknown;
  buyerPhone?: unknown;
  buyerEmail?: unknown;
  beneficiaryName?: unknown;
  beneficiaryPhone?: unknown;
  beneficiaryEmail?: unknown;
  expiresAt?: unknown;
};

/** Ce que la couche base écrit, une fois l'entrée jugée bonne. Tout est déjà normalisé. */
export type GiftCardData = {
  code: string;
  amountXpf: bigint;
  serviceLabel: string | null;
  serviceId: string | null;
  buyerName: string | null;
  buyerPhone: string | null;
  buyerEmail: string | null;
  beneficiaryName: string | null;
  beneficiaryPhone: string | null;
  beneficiaryEmail: string | null;
  expiresAt: Date | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Valide et normalise un bon à émettre.
 *
 * `amountXpf` est exigé MÊME sur un bon nominatif, et ce n'est pas une inadvertance : c'est ce
 * qui a été encaissé le jour de la vente, donc ce qui est déjà entré dans le CA. Un bon nominatif
 * sans montant serait une prestation offerte dont personne ne saurait dire combien elle a
 * rapporté — et le Z ne pourrait plus se recouper.
 *
 * Il faut au moins UN identifiant de bénéficiaire (nom, téléphone ou e-mail) : les trois sont
 * stockés parce que la fiche cliente se rapproche à la LECTURE (il n'existe aucune table cliente,
 * et la clé de dédup CHANGE quand la cliente donne son e-mail après coup), mais un bon sans aucun
 * identifiant ne se rattacherait à personne et resterait introuvable au comptoir.
 */
export function validateGiftCard(input: GiftCardInput): { ok: true; data: GiftCardData } | { ok: false; error: GiftCardRefusal } {
  const code = normalizeCode(input.code);
  if (!code) return { ok: false, error: "CODE_REQUIRED" };
  if (code.length > 40) return { ok: false, error: "CODE_TOO_LONG" };

  const amount = normalizeGiftCardAmount(input.amountXpf);
  if (!amount.ok) return { ok: false, error: amount.error };

  const expiry = normalizeExpiry(input.expiresAt);
  if (!expiry.ok) return { ok: false, error: expiry.error };

  const beneficiaryName = normalizeText(input.beneficiaryName, 120);
  const beneficiaryPhone = normalizeText(input.beneficiaryPhone, 40);
  const beneficiaryEmail = normalizeText(input.beneficiaryEmail, 160);
  if (!beneficiaryName && !beneficiaryPhone && !beneficiaryEmail) {
    return { ok: false, error: "BENEFICIARY_REQUIRED" };
  }

  const serviceId = typeof input.serviceId === "string" && UUID_RE.test(input.serviceId.trim())
    ? input.serviceId.trim()
    : null;

  return {
    ok: true,
    data: {
      code,
      amountXpf: amount.amountXpf,
      serviceLabel: normalizeText(input.serviceLabel, 160),
      serviceId,
      buyerName: normalizeText(input.buyerName, 120),
      buyerPhone: normalizeText(input.buyerPhone, 40),
      buyerEmail: normalizeText(input.buyerEmail, 160),
      beneficiaryName,
      beneficiaryPhone,
      beneficiaryEmail,
      expiresAt: expiry.expiresAt,
    },
  };
}

/**
 * Valide un LOT de bons à émettre dans une même vente, et refuse tout doublon de code À
 * L'INTÉRIEUR du lot.
 *
 * Ce garde n'est pas décoratif : l'index unique protège la base, mais deux bons de même code dans
 * un seul panier feraient échouer la transaction APRÈS que l'argent est pris. Mieux vaut refuser
 * avant l'encaissement que se retrouver avec une vente PAID sans ses bons.
 */
export function validateGiftCards(
  inputs: readonly GiftCardInput[],
): { ok: true; data: GiftCardData[] } | { ok: false; error: GiftCardRefusal | "DUPLICATE_CODE"; index: number } {
  const out: GiftCardData[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < inputs.length; i++) {
    const r = validateGiftCard(inputs[i]);
    if (!r.ok) return { ok: false, error: r.error, index: i };
    if (seen.has(r.data.code)) return { ok: false, error: "DUPLICATE_CODE", index: i };
    seen.add(r.data.code);
    out.push(r.data);
  }
  return { ok: true, data: out };
}

// ── Code lisible ─────────────────────────────────────────────────────────────────────────────

/**
 * Alphabet sans caractère ambigu : ni O/0, ni I/1, ni S/5. Voir `normalizeCode` — ce code est
 * recopié à la main, et une confusion de glyphe se paie par un bon introuvable au comptoir.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

/**
 * Code lisible d'un bon (« BC4K7QP2 » — l'écran l'affiche avec un tiret, la base le stocke sans).
 * `rand` est injectable pour rendre la fonction testable ; l'unicité RÉELLE est garantie par
 * l'index unique `(tenantId, code)`, jamais par le tirage.
 */
export function generateGiftCardCode(rand: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return `BC${out}`;
}

/** Code tel qu'on l'écrit sur le bon papier et à l'écran : « BC-4K7QP2 ». */
export function formatGiftCardCode(code: string): string {
  const c = normalizeCode(code);
  return c.startsWith("BC") && c.length > 2 ? `BC-${c.slice(2)}` : c;
}

// ── Le Z : deux champs INFORMATIFS, et rien d'autre ──────────────────────────────────────────

export type RedeemedGiftCardLike = { amountXpf: bigint };

export type GiftCardRedeemedTotals = {
  /** Combien de prestations ont été réglées par un bon pendant la session. */
  giftCardRedeemedCount: number;
  /** Leur valeur faciale cumulée — DÉJÀ ENCAISSÉE à la vente des bons, donc déjà dans le CA. */
  giftCardRedeemedXpf: bigint;
};

/**
 * 🔒 LE POINT OÙ L'INVARIANT SE TIENT, ET IL SE TIENT PAR LA SIGNATURE.
 *
 * Cette fonction rend un objet dont AUCUN champ ne porte le nom d'un poste de trésorerie ou de
 * chiffre d'affaires. Elle ne prend pas de fond de caisse, pas de ventes, pas de mouvements — et
 * symétriquement, `expectedCashXpf` (lib/cash-movement.ts) ne prend PAS de bons cadeaux. Les deux
 * prototypes sont disjoints : pour faire entrer un bon consommé dans l'attendu du tiroir ou dans
 * le CA, il faudrait modifier un prototype, pas oublier une ligne. C'est la seule forme de
 * garde-fou qui survive à une relecture distraite.
 *
 * Le montant retenu est la valeur FACIALE du bon (`amountXpf`), pas `redeemedForXpf` : c'est bien
 * cette somme-là qui est entrée dans le CA le jour de l'achat, et c'est elle que le Z rappelle.
 */
export function summarizeRedeemedGiftCards(
  cards: readonly RedeemedGiftCardLike[],
): GiftCardRedeemedTotals {
  let total = 0n;
  for (const c of cards) total += c.amountXpf;
  return { giftCardRedeemedCount: cards.length, giftCardRedeemedXpf: total };
}

/**
 * Libellé du Z. Il dit la chose importante EN TOUTES LETTRES — « déjà encaissés à la vente des
 * bons » — parce que c'est exactement la phrase qui empêche quelqu'un d'additionner ce montant au
 * CA du jour en croyant réparer un oubli.
 */
export function giftCardZLabel(totals: GiftCardRedeemedTotals, formatXpf: (v: bigint) => string): string | null {
  if (totals.giftCardRedeemedCount === 0) return null;
  const n = totals.giftCardRedeemedCount;
  const presta = n === 1 ? "prestation réglée" : "prestations réglées";
  return `dont ${n} ${presta} par bon cadeau — ${formatXpf(totals.giftCardRedeemedXpf)}, déjà encaissés à la vente des bons`;
}

/**
 * La consommation appartient-elle à cette session de caisse ?
 *
 * Fenêtre `[openedAt, closedAt]`, bornes INCLUSES, et `closedAt` absent = session encore ouverte,
 * donc pas de borne haute. Il n'y a AUCUNE clé étrangère de `GiftCard` vers `CashSession`, et
 * c'est structurel : une consommation n'est pas une opération de caisse, elle n'a aucune
 * comptabilité. La rattacher par une FK laisserait croire le contraire — et rendrait tentant de
 * l'additionner quelque part.
 */
export function isRedeemedInSession(
  redeemedAt: Date | string | null,
  session: { openedAt: Date | string; closedAt: Date | string | null },
): boolean {
  const t = toMs(redeemedAt);
  if (t === null) return false;
  const start = toMs(session.openedAt);
  if (start === null || t < start) return false;
  const end = toMs(session.closedAt);
  return end === null || t <= end;
}
