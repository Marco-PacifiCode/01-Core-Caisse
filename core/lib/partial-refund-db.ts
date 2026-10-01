import type { Prisma } from "@prisma/client";
import type { ComptaClient } from "./clients";
import { partialRefundMovementRef } from "./cash-movement.ts";
import { planPartialRefund, refundFingerprint, refuse, runPartialRefund, type RefundInput, type RefundPlan, type RefundResult, type RefundSuccess, type RefundReservation } from "./partial-refund.ts";

type Tx = Prisma.TransactionClient;
// Même adaptateur exécuté en production et par les tests avec transactions simulées.
export async function partialRefundWithPorts(tenantId: string, saleId: string, input: RefundInput, deps: {
  transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  lockSale(tx: Tx): Promise<boolean>;
  lockAction(tx: Tx): Promise<void>;
  compta: ComptaClient;
}): Promise<RefundResult> {
  const key = { tenantId_actionId: { tenantId, actionId: input.actionId } };
  const readExisting = async (tx: Tx): Promise<RefundReservation | ReturnType<typeof refuse> | null> => {
    const r = await tx.partialRefund.findUnique({ where: key });
    if (!r) return null;
    if (r.saleId !== saleId || refundFingerprint(r.input as unknown as RefundInput) !== refundFingerprint(input)) return refuse("ACTION_ID_CONFLICT");
    return { input: r.input as unknown as RefundInput, plan: r.plan as unknown as RefundPlan,
      ...(r.status === "DONE" ? { outcome: r.outcome as unknown as RefundSuccess } : {}) };
  };
  const openSession = async (tx: Tx, posteId: string | null) => tx.cashSession.findFirst({
    where: { tenantId, posteId, status: "OPEN" }, orderBy: { openedAt: "desc" },
  });
  return runPartialRefund({ tenantId, saleId,
    creditNote: value => deps.compta.creditNote(value),
    async prepare() {
      // Rejouer une réservation ne relit pas Compta et conserve exactement son plan.
      const existing = await deps.transact(async tx => {
        await deps.lockAction(tx);
        if (!await deps.lockSale(tx)) return refuse("SALE_NOT_FOUND", 404);
        return readExisting(tx);
      });
      if (existing) return existing;
      const sale = await deps.transact(tx => tx.sale.findFirst({ where: { id: saleId, tenantId }, include: { lines: true } }));
      if (!sale) return refuse("SALE_NOT_FOUND", 404);
      if (sale.status !== "PAID") return refuse("SALE_NOT_PAID");
      if (!sale.invoiceId || !deps.compta.invoiceDetail) return refuse("INVOICE_NOT_READY");
      let invoice;
      try { invoice = await deps.compta.invoiceDetail(tenantId, sale.invoiceId); }
      catch { return refuse("INVOICE_READ_FAILED", 502); }
      return deps.transact(async tx => {
        await deps.lockAction(tx);
        if (!await deps.lockSale(tx)) return refuse("SALE_NOT_FOUND", 404);
        const replay = await readExisting(tx);
        if (replay) return replay;
        const current = await tx.sale.findFirst({ where: { id: saleId, tenantId }, include: { lines: true } });
        if (!current) return refuse("SALE_NOT_FOUND", 404);
        const refunds = await tx.partialRefund.findMany({ where: { tenantId, saleId } });
        if (refunds.some(r => r.status === "PENDING")) return refuse("REFUND_IN_PROGRESS");
        const plan = planPartialRefund(current, invoice, input, refunds.map(r => r.plan as unknown as RefundPlan));
        if ("ok" in plan) return plan;
        const session = input.refundMethod === "CASH" ? await openSession(tx, current.posteId) : null;
        if (input.refundMethod === "CASH" && !session) return refuse("NO_OPEN_SESSION");
        if (input.refundMethod === "CASH" && await tx.cashMovement.findFirst({ where: { tenantId, ref: partialRefundMovementRef(input.actionId) } })) return refuse("REFUND_REF_CONFLICT");
        await tx.partialRefund.create({ data: { tenantId, saleId, actionId: input.actionId, sessionId: session?.id,
          input: input as unknown as Prisma.InputJsonValue, plan: plan as unknown as Prisma.InputJsonValue } });
        return { input, plan };
      });
    },
    async finalize(reservation, creditNoteId) {
      return deps.transact(async tx => {
        await deps.lockAction(tx);
        if (!await deps.lockSale(tx)) return refuse("SALE_NOT_FOUND", 404);
        const replay = await readExisting(tx);
        if (!replay) return refuse("REFUND_RESERVATION_MISSING");
        if ("ok" in replay) return replay;
        if (replay.outcome) return replay.outcome;
        const sale = await tx.sale.findFirst({ where: { id: saleId, tenantId } });
        if (!sale || sale.status !== "PAID" || sale.invoiceId !== reservation.plan.invoiceId) return refuse("REFUND_RETRY_SALE_CHANGED");
        if (input.refundMethod === "CASH") {
          const action = await tx.partialRefund.findUniqueOrThrow({ where: key });
          // Le rejeu après clôture peut utiliser la nouvelle session du même poste.
          const session = await openSession(tx, sale.posteId);
          if (!session) return refuse("NO_OPEN_SESSION");
          // UPDATE prend le verrou de ligne aussi utilisé par la clôture; si CLOSED
          // a gagné la course, rien n'est écrit et l'action reste rejouable.
          const locked = await tx.cashSession.updateMany({ where: { id: session.id, tenantId, status: "OPEN" }, data: { status: "OPEN" } });
          if (locked.count !== 1) return refuse("SESSION_CLOSED");
          const movement = await tx.cashMovement.findFirst({ where: { tenantId, ref: partialRefundMovementRef(input.actionId) } });
          if (movement) return refuse("REFUND_REF_CONFLICT");
          if (!movement) await tx.cashMovement.create({ data: { tenantId, sessionId: session.id, kind: "REFUND", ref: partialRefundMovementRef(input.actionId),
            amountXpf: BigInt(reservation.plan.amountXpf), reason: input.reason, createdBy: input.createdBy, createdByName: input.createdByName } });
          await tx.partialRefund.update({ where: { id: action.id }, data: { sessionId: session.id } });
        }
        const outcome: RefundSuccess = { ok: true, actionId: input.actionId, creditNoteId, refundMethod: input.refundMethod, plan: reservation.plan };
        await tx.partialRefund.update({ where: key, data: { status: "DONE", creditNoteId, outcome: outcome as unknown as Prisma.InputJsonValue } });
        if (reservation.plan.fullyRefunded) await tx.sale.update({ where: { id: saleId }, data: { fullyRefundedAt: new Date() } });
        return outcome;
      });
    },
  });
}
