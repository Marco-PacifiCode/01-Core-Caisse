import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "@/lib/service-auth";
import { getLoyaltyProgram, upsertLoyaltyProgram } from "@/lib/caisse";

export const runtime = "nodejs";

/**
 * GET /api/loyalty/program — réglages du programme de fidélité (S2S, X-Core-Key).
 * Query : ?tenantId=…
 * Réponse 200 : { ok:true, program } — `program = {mode:"OFF"}` si aucune ligne n'existe encore
 * (jamais créée à la lecture, cf. plan §6 piège n°4).
 */
export async function GET(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tenantId = (url.searchParams.get("tenantId") ?? "").trim();
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const program = await getLoyaltyProgram(tenantId);
  return NextResponse.json({ ok: true, program });
}

/**
 * PUT /api/loyalty/program — règle le programme de fidélité (S2S, X-Core-Key).
 *
 * 🔒 DROIT : ADMIN seule (plan §2.1, comme l'annulation d'un bon). La garde de rôle est posée
 *    côté SURFACE (finance-actions.ts) — ce Core ne connaît que la clé de service, jamais le
 *    rôle de l'appelant (décision Marco, 2026-09-15).
 *
 * Body : { tenantId, mode, visitsPerReward?, pointsPerHundredXpf?, pointsBase?, pointsPerReward?,
 *          rewardKind?, rewardPercent?, rewardAmountXpf?, rewardBase?, rewardValidityMonths?,
 *          clientPortalVisible?, updatedBy? }
 * Réponse 200 : { ok:true, program } · 400 { error:<refus validateProgram> } · 401 clé absente.
 */
export async function PUT(req: NextRequest) {
  if (!hasServiceKey(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) return NextResponse.json({ error: "tenantId requis" }, { status: 400 });

  const rewardAmountXpf =
    body.rewardAmountXpf === undefined || body.rewardAmountXpf === null
      ? null
      : BigInt(Math.round(Number(body.rewardAmountXpf)));

  const updatedBy = typeof body.updatedBy === "string" ? body.updatedBy : null;

  const result = await upsertLoyaltyProgram(
    tenantId,
    {
      mode: typeof body.mode === "string" ? body.mode : "",
      visitsPerReward: typeof body.visitsPerReward === "number" ? body.visitsPerReward : null,
      pointsPerHundredXpf: typeof body.pointsPerHundredXpf === "number" ? body.pointsPerHundredXpf : null,
      pointsBase: typeof body.pointsBase === "string" ? body.pointsBase : null,
      pointsPerReward: typeof body.pointsPerReward === "number" ? body.pointsPerReward : null,
      rewardKind: typeof body.rewardKind === "string" ? body.rewardKind : null,
      rewardPercent: typeof body.rewardPercent === "number" ? body.rewardPercent : null,
      rewardAmountXpf,
      rewardBase: typeof body.rewardBase === "string" ? body.rewardBase : null,
      rewardValidityMonths: typeof body.rewardValidityMonths === "number" ? body.rewardValidityMonths : null,
      clientPortalVisible: typeof body.clientPortalVisible === "boolean" ? body.clientPortalVisible : null,
    },
    updatedBy,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, program: result.data });
}
