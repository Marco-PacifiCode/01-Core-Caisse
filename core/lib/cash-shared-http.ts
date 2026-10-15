import { NextRequest, NextResponse } from "next/server";
import { hasServiceKey } from "./service-auth";
import { withTenant } from "./tenant";
import { cashAction, envelope, uuid, type ActionInput, type CashTx } from "./caisse-sync";
import { CashContractError, jsonValue } from "./cash-day-projection";

function response(body: unknown, status = 200) { return NextResponse.json(jsonValue(body), { status, headers: { "Cache-Control": "no-store" } }); }
export async function cashHttp(req: NextRequest, fn: () => Promise<unknown>) {
  if (!hasServiceKey(req)) return response({ ok: false, error: "Unauthorized" }, 401);
  try { return await fn(); }
  catch (e) {
    if (e instanceof CashContractError) return response({ ok: false, error: e.message, data: e.data }, e.status);
    if (e instanceof SyntaxError) return response({ ok: false, error: "INVALID_PAYLOAD" }, 400);
    return response({ ok: false, error: "INTERNAL_ERROR" }, 500);
  }
}
export function cashRead(req: NextRequest, fn: (tx: CashTx, tenantId: string, q: URLSearchParams) => Promise<unknown>) {
  return cashHttp(req, async () => {
    const q = new URL(req.url).searchParams, tenantId = uuid(q.get("tenantId"));
    return response(await withTenant(tenantId, tx => fn(tx, tenantId, q)));
  });
}
export function cashWrite(req: NextRequest, kind: string, fn: (tx: CashTx, b: ActionInput) => Promise<unknown>) {
  return cashHttp(req, async () => {
    const b = envelope(await req.json(), req.headers.get("Idempotency-Key"));
    const result = await cashAction(kind, b, tx => fn(tx, b));
    return response(result.body, result.status);
  });
}
export { response as cashResponse };
