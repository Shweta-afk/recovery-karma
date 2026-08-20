import { getPortfolios, getAgentDebtorIds, debtorFromRow } from "@/lib/portfolio-store";
import type { QueueDebtor } from "./types";

/** Build a queue from portfolios assigned to this agent; returns empty if none assigned */
export function buildAssignedQueue(agentId: string): QueueDebtor[] {
  const slices = getAgentDebtorIds(agentId);
  if (!slices.length) return [];
  const allPortfolios = getPortfolios();
  const result: QueueDebtor[] = [];
  for (const { portfolioId, debtorIds } of slices) {
    const portfolio = allPortfolios.find((p) => p.id === portfolioId);
    if (!portfolio) continue;
    // A closed portfolio's cycle is over — whoever wasn't carried forward via an approved
    // retention request (see reconcileRetainedDebtors in portfolio-store.ts) was recalled by
    // the bank, so it drops out of the active queue. Anyone who WAS carried forward already
    // has their portfolio_id pointed at the new, non-closed portfolio, so they still show up.
    if (portfolio.closedAt) continue;
    const idSet = new Set(debtorIds);
    for (const row of portfolio.rows) {
      if (!idSet.has(row.id)) continue;
      // A bank paid-file upload (applyBulkPaidFile) moves status to 'paid' directly, without
      // an agent ever dispositioning the call — drop them from the active queue the same way
      // an already-'removed' debtor never made it into portfolio.rows at all.
      if (row.status === "paid") continue;
      result.push({
        // debtorFromRow() is the same conversion the debtor profile page uses — keeps this
        // queue's debtor info (address, employer, DOB, lender, alt numbers, etc.) from
        // silently dropping fields the way the old inline object literal here used to.
        ...debtorFromRow(row, portfolio),
        loanReference: row.loanReference,
        portfolioId: portfolio.id,
        queueStatus: "fresh",
        scheduledAt: "—",
        ptpAmount: 0,
      });
    }
  }
  return result;
}
