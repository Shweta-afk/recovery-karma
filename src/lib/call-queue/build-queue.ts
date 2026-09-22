import {
  getPortfolios,
  getAgentDebtorIds,
  debtorFromRow,
  isPortfolioEnded,
  type UploadedPortfolio,
} from "@/lib/portfolio-store";
import { getLatestDispositionByDebtor } from "@/lib/disposition-store";
import type { CallOutcome, QueueDebtor } from "./types";

/** Last call outcome -> the queue's own coarser status. Only these three outcomes change where
 * a debtor sits in the Productive / Non-Productive split; everything else (refused, dispute,
 * settlement, voicemail, paid) leaves the row where a never-called row sits, because the queue
 * has no distinct bucket for them and silently folding them into "no answer" would misreport
 * a contact that did happen. */
const OUTCOME_TO_QUEUE_STATUS: Partial<Record<CallOutcome, QueueDebtor["queueStatus"]>> = {
  promised: "ptp",
  callback: "callback",
  no_answer: "no_answer",
};

/** Merges getAgentDebtorIds() across every agent in `agentIds` into one portfolio -> debtorIds
 * list — the same shape a single agent's call returns, so buildAssignedQueue below never needs
 * to know whether it's building one person's queue or a manager's whole-team combined view. */
function combinedAgentDebtorIds(
  agentIds: string[],
): { portfolioId: string; debtorIds: string[] }[] {
  const byPortfolio = new Map<string, Set<string>>();
  for (const id of agentIds) {
    for (const { portfolioId, debtorIds } of getAgentDebtorIds(id)) {
      const set = byPortfolio.get(portfolioId) ?? new Set<string>();
      for (const debtorId of debtorIds) set.add(debtorId);
      byPortfolio.set(portfolioId, set);
    }
  }
  return Array.from(byPortfolio.entries(), ([portfolioId, ids]) => ({
    portfolioId,
    debtorIds: Array.from(ids),
  }));
}

/** Build a queue from portfolios assigned to this agent (or, for a manager's combined "whole
 * team" view, every agent in the given list — each row still carries its real assignedAgentId,
 * from the debtor data itself, so who-owns-what is never lost when merging). Returns empty if
 * nobody in the list has anything assigned. */
export function buildAssignedQueue(agentId: string | string[]): QueueDebtor[] {
  const slices = Array.isArray(agentId)
    ? combinedAgentDebtorIds(agentId)
    : getAgentDebtorIds(agentId);
  if (!slices.length) return [];
  const allPortfolios = getPortfolios();
  const latest = getLatestDispositionByDebtor();
  const result: QueueDebtor[] = [];
  for (const { portfolioId, debtorIds } of slices) {
    const portfolio = allPortfolios.find((p) => p.id === portfolioId);
    if (!portfolio) continue;
    const idSet = new Set(debtorIds);
    result.push(...queueRowsForPortfolio(portfolio, latest, (row) => idSet.has(row.id)));
  }
  return result;
}

/** Same mapping as buildAssignedQueue's inner loop (isPortfolioEnded, the 'paid' skip,
 * debtorFromRow, the disposition-derived fields) — shared so the scoped path below and the
 * legacy full-cache path above can't drift apart. `keep` narrows which rows in an already
 * fetched portfolio belong to the caller; scoped-debtors.ts's portfolios need no narrowing at
 * all, since every row it returns was already fetched scoped to the caller. */
function queueRowsForPortfolio(
  portfolio: UploadedPortfolio,
  latest: ReturnType<typeof getLatestDispositionByDebtor>,
  keep: (row: UploadedPortfolio["rows"][number]) => boolean = () => true,
): QueueDebtor[] {
  // A closed (or past its manager-set end date — see isPortfolioEnded) portfolio's cycle is
  // over — whoever wasn't carried forward via an approved retention request (see
  // reconcileRetainedDebtors in portfolio-store.ts) was recalled by the bank, so it drops out
  // of the active queue. Anyone who WAS carried forward already has their portfolio_id pointed
  // at the new, non-ended portfolio, so they still show up.
  if (isPortfolioEnded(portfolio)) return [];
  const result: QueueDebtor[] = [];
  for (const row of portfolio.rows) {
    if (!keep(row)) continue;
    // A bank paid-file upload (applyBulkPaidFile) moves status to 'paid' directly, without an
    // agent ever dispositioning the call — drop them from the active queue the same way an
    // already-'removed' debtor never made it into portfolio.rows at all.
    if (row.status === "paid") continue;
    result.push({
      // debtorFromRow() is the same conversion the debtor profile page uses — keeps this
      // queue's debtor info (address, employer, DOB, lender, alt numbers, etc.) from silently
      // dropping fields the way the old inline object literal here used to.
      ...debtorFromRow(row, portfolio),
      loanReference: row.loanReference,
      portfolioId: portfolio.id,
      // Derived from the debtor's most recent call, NOT hardcoded. This used to be a literal
      // "fresh" for every row, which meant the Productive / Non-Productive breakdown could
      // only ever read 0 callbacks, 0 PTPs, 0 no-answers and "everything" under Ringing /
      // Fresh — even with PTPs sitting in the tracker directly below it.
      ...queueFieldsFor(latest.get(row.id)),
    });
  }
  return result;
}

/** Builds a queue from an ALREADY-SCOPED portfolio list (see scoped-debtors.ts), whose `.rows`
 * already contain exactly the debtors the caller is entitled to — so, unlike buildAssignedQueue
 * above, there is no separate id-set / assigned-agent filter left to apply here. */
export function buildQueueFromPortfolios(portfolios: UploadedPortfolio[]): QueueDebtor[] {
  const latest = getLatestDispositionByDebtor();
  const result: QueueDebtor[] = [];
  for (const portfolio of portfolios) result.push(...queueRowsForPortfolio(portfolio, latest));
  return result;
}

/** The three disposition-derived fields on a queue row, defaulted to the never-called state. */
function queueFieldsFor(
  last: { outcome: CallOutcome; ptpAmount?: number; ptpDate?: string } | undefined,
) {
  if (!last) return { queueStatus: "fresh" as const, scheduledAt: "—", ptpAmount: 0 };
  return {
    queueStatus: OUTCOME_TO_QUEUE_STATUS[last.outcome] ?? ("fresh" as const),
    scheduledAt: last.ptpDate ?? "—",
    ptpAmount: last.ptpAmount ?? 0,
  };
}
