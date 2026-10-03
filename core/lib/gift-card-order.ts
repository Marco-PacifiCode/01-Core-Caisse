// Commande de bon cadeau EN LIGNE — règles PURES (aucun accès base).
//
// La vitrine dépose une commande « à encaisser » (PENDING). Le bon ne naît PAS ici : il naît
// dans la transaction du checkout (`GiftCard.orderId`), qui passe la commande à PAID.

import { randomInt } from "node:crypto";
import { CODE_ALPHABET, UUID_RE, normalizeText } from "./gift-card.ts";

export type GiftCardOrderInput = {
  amountXpf: bigint;
  serviceId: string | null;
  serviceLabel: string | null;
  buyerName: string;
  buyerPhone: string | null;
  buyerEmail: string | null;
  beneficiaryName: string;
  beneficiaryPhone: string | null;
  beneficiaryEmail: string | null;
  message: string | null;
};

export type GiftCardOrderRefusal =
  | "INVALID_BODY"
  | "INVALID_AMOUNT"
  | "INVALID_SERVICE"
  | "SERVICE_LABEL_TOO_LONG"
  | "BUYER_NAME_REQUIRED"
  | "BUYER_CONTACT_REQUIRED"
  | "BENEFICIARY_NAME_REQUIRED"
  | "INVALID_PHONE"
  | "INVALID_EMAIL"
  | "MESSAGE_TOO_LONG";

export const ORDER_MIN_XPF = 1000n;
export const ORDER_MAX_XPF = 500000n;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Fail = { ok: false; error: GiftCardOrderRefusal };
type Field<T> = { ok: true; value: T } | Fail;

/** Texte optionnel borné : absent/vide → null ; trop long ou non-texte → refus. */
function optionalText(raw: unknown, max: number, error: GiftCardOrderRefusal): Field<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error };
  if (raw.trim().length > max) return { ok: false, error };
  return { ok: true, value: normalizeText(raw, max) };
}

function parseAmount(raw: unknown): bigint | null {
  let v: bigint;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw)) return null;
    v = BigInt(raw);
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    v = BigInt(raw.trim());
  } else if (typeof raw === "bigint") {
    v = raw;
  } else {
    return null;
  }
  return v >= ORDER_MIN_XPF && v <= ORDER_MAX_XPF ? v : null;
}

function email(raw: unknown): Field<string | null> {
  const r = optionalText(raw, 254, "INVALID_EMAIL");
  if (!r.ok || r.value === null) return r;
  return EMAIL_RE.test(r.value) ? r : { ok: false, error: "INVALID_EMAIL" };
}

/** Valide et normalise le corps d'une commande en ligne. Refus nommé, jamais d'exception. */
export function validateGiftCardOrder(
  raw: unknown,
): { ok: true; data: GiftCardOrderInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_BODY" };
  const b = raw as Record<string, unknown>;

  const amountXpf = parseAmount(b.amountXpf);
  if (amountXpf === null) return { ok: false, error: "INVALID_AMOUNT" };

  let serviceId: string | null = null;
  if (b.serviceId !== undefined && b.serviceId !== null && b.serviceId !== "") {
    if (typeof b.serviceId !== "string" || !UUID_RE.test(b.serviceId.trim())) {
      return { ok: false, error: "INVALID_SERVICE" };
    }
    serviceId = b.serviceId.trim().toLowerCase();
  }
  const serviceLabel = optionalText(b.serviceLabel, 120, "SERVICE_LABEL_TOO_LONG");
  if (!serviceLabel.ok) return serviceLabel;

  const buyerName = optionalText(b.buyerName, 120, "BUYER_NAME_REQUIRED");
  if (!buyerName.ok || buyerName.value === null) return { ok: false, error: "BUYER_NAME_REQUIRED" };
  const buyerPhone = optionalText(b.buyerPhone, 40, "INVALID_PHONE");
  if (!buyerPhone.ok) return buyerPhone;
  const buyerEmail = email(b.buyerEmail);
  if (!buyerEmail.ok) return buyerEmail;
  if (buyerPhone.value === null && buyerEmail.value === null) return { ok: false, error: "BUYER_CONTACT_REQUIRED" };

  const beneficiaryName = optionalText(b.beneficiaryName, 120, "BENEFICIARY_NAME_REQUIRED");
  if (!beneficiaryName.ok || beneficiaryName.value === null) return { ok: false, error: "BENEFICIARY_NAME_REQUIRED" };
  const beneficiaryPhone = optionalText(b.beneficiaryPhone, 40, "INVALID_PHONE");
  if (!beneficiaryPhone.ok) return beneficiaryPhone;
  const beneficiaryEmail = email(b.beneficiaryEmail);
  if (!beneficiaryEmail.ok) return beneficiaryEmail;

  let message: string | null = null;
  if (b.message !== undefined && b.message !== null) {
    if (typeof b.message !== "string" || b.message.trim().length > 500) return { ok: false, error: "MESSAGE_TOO_LONG" };
    message = b.message.trim() || null;
  }

  return {
    ok: true,
    data: {
      amountXpf,
      serviceId,
      serviceLabel: serviceLabel.value,
      buyerName: buyerName.value,
      buyerPhone: buyerPhone.value,
      buyerEmail: buyerEmail.value,
      beneficiaryName: beneficiaryName.value,
      beneficiaryPhone: beneficiaryPhone.value,
      beneficiaryEmail: beneficiaryEmail.value,
      message,
    },
  };
}

/** Référence lisible « CMD-XXXXXX » (alphabet des codes de bon, tirage crypto). Unicité = index. */
export function generateOrderReference(): string {
  let out = "";
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `CMD-${out}`;
}

export type GiftCardOrderRowLike = {
  id: string;
  tenantId: string;
  reference: string;
  status: string;
  channel: string;
  amountXpf: bigint;
  serviceId: string | null;
  serviceLabel: string | null;
  buyerName: string;
  buyerPhone: string | null;
  buyerEmail: string | null;
  beneficiaryName: string;
  beneficiaryPhone: string | null;
  beneficiaryEmail: string | null;
  message: string | null;
  paymentMode: string;
  paymentProvider: string | null;
  paymentRef: string | null;
  createdAt: Date;
  updatedAt: Date;
  paidAt: Date | null;
  saleId: string | null;
  giftCardId: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  cancelledByName: string | null;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Ligne → JSON : BigInt en number (XPF entier), dates en ISO. */
export function serializeGiftCardOrder(row: GiftCardOrderRowLike) {
  return {
    ...row,
    amountXpf: Number(row.amountXpf),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    paidAt: iso(row.paidAt),
    cancelledAt: iso(row.cancelledAt),
  };
}

export type GiftCardOrderJson = ReturnType<typeof serializeGiftCardOrder>;
