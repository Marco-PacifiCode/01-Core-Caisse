import { CashContractError, requireCash, xpfInteger, type JsonRecord } from "./cash-day-projection.ts";

export function revisionOf(value: unknown): number {
  requireCash(Number.isSafeInteger(value) && Number(value) >= 0); return Number(value);
}
export function canChange(row: { revision: number; status: string; claimedByDevice: string | null }, b: JsonRecord & { deviceId: string }, claim = false, order = false) {
  if (row.revision !== revisionOf(b.baseRevision)) throw new CashContractError("REVISION_CONFLICT", 409, row);
  requireCash(!(order ? ["RETIREE", "ANNULEE", "PERDUE"] : ["CONSUMED", "DELETED"]).includes(row.status), "TERMINAL_STATE", 409);
  requireCash(!row.claimedByDevice || row.claimedByDevice === b.deviceId, "ALREADY_CLAIMED", 409);
  if (claim) return;
  if (!order && b.status === "CONSUMED") requireCash(row.claimedByDevice === b.deviceId, "CLAIM_REQUIRED", 409);
  if (order) requireCash(b.status !== "RETIREE", "SALE_REQUIRED", 409);
}
export function frozenLines(value: unknown, importMode = false): { lines: JsonRecord[]; total: bigint | null } {
  requireCash(Array.isArray(value) && value.length > 0 && value.length <= 1000);
  let total: bigint | null = 0n;
  const lines = value.map(raw => {
    requireCash(raw && typeof raw === "object" && !Array.isArray(raw));
    const line = raw as JsonRecord;
    requireCash(Number.isSafeInteger(line.qty) && Number(line.qty) > 0);
    if (line.lineXpf === undefined && importMode) { total = null; return line; }
    const amount = xpfInteger(line.lineXpf, true);
    if (line.unitXpf !== undefined) requireCash(xpfInteger(line.unitXpf, true) * BigInt(Number(line.qty)) === amount);
    if (line.tgcRatePpm !== undefined && line.tgcRatePpm !== null) requireCash(Number.isInteger(line.tgcRatePpm) && Number(line.tgcRatePpm) >= 0 && Number(line.tgcRatePpm) <= 1000000);
    if (total !== null) total += amount;
    return line;
  });
  return { lines, total };
}
