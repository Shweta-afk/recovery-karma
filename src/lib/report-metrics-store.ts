import { supabase } from "./supabase";

/**
 * Account counts for the report pages, aggregated in Postgres rather than by counting cached
 * debtor rows in the browser.
 *
 * portfolio-store.ts caches every portfolio AND every debtor in localStorage; at 10,436 live
 * debtors (26 MB, measured 2026-08-21) that exceeds the ~5 MB per-origin quota, so a partial
 * snapshot is served and anything counted from it is wrong — admin/reports showed
 * "1 active portfolio" and 1,449 accounts against a real 8 and 10,436. These RPCs return a
 * handful of aggregate rows whatever the dataset size, so the numbers stay correct and the
 * payload stays small.
 *
 * The RPCs are SECURITY INVOKER, so RLS still scopes them: an agent's counts cover only their
 * own debtors, a manager's only their team's. Requires
 * migrations/20260821_report_count_rpcs.sql.
 *
 * Same cache-first + refresh + CustomEvent shape as every other store in this directory.
 */

export interface AgentAccountCount {
  /** Agent email — the identity used everywhere else (AgentRef.id, teams.agentIds). */
  agentEmail: string;
  /** Open portfolio, not already settled — the dialer's definition of a live account. */
  activeAssigned: number;
  /** Every row ever assigned, including closed cycles and paid-off accounts. */
  totalAssigned: number;
}

export interface PortfolioTotals {
  portfolioId: string;
  portfolioName: string;
  teamId?: string;
  managerId?: string;
  isOpen: boolean;
  totalRows: number;
  activeRows: number;
  assignedRows: number;
  /** Sum of loan_amount — the denominator of recovery rate. */
  placedAmount: number;
}

const AGENT_KEY = "recoveryai_report_agent_counts";
const PORTFOLIO_KEY = "recoveryai_report_portfolio_totals";

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

export function getAgentAccountCounts(): AgentAccountCount[] {
  return read<AgentAccountCount>(AGENT_KEY);
}

export function getPortfolioTotals(): PortfolioTotals[] {
  return read<PortfolioTotals>(PORTFOLIO_KEY);
}

/** Aggregate rows only — safe to cache, unlike the full debtor dataset. */
export async function refreshReportMetrics(): Promise<void> {
  const [agentRes, portfolioRes] = await Promise.all([
    supabase.rpc("report_agent_account_counts"),
    supabase.rpc("report_portfolio_totals"),
  ]);

  // Log each failure with its own name — a shared bail-out made it impossible to tell which
  // RPC was missing when the migration hadn't been applied yet.
  if (agentRes.error) {
    console.error(
      "[report-metrics] report_agent_account_counts failed — has " +
        "migrations/20260821_report_count_rpcs.sql been applied?",
      agentRes.error.message,
    );
  }
  if (portfolioRes.error) {
    console.error(
      "[report-metrics] report_portfolio_totals failed — has " +
        "migrations/20260821_report_count_rpcs.sql been applied?",
      portfolioRes.error.message,
    );
  }
  if (agentRes.error || portfolioRes.error) return;

  type AgentRow = { agent_email: string; active_assigned: number; total_assigned: number };
  type PortfolioRow = {
    portfolio_id: string;
    portfolio_name: string;
    team_id: string | null;
    manager_id: string | null;
    is_open: boolean;
    total_rows: number;
    active_rows: number;
    assigned_rows: number;
    placed_amount: number | string;
  };

  const agents: AgentAccountCount[] = ((agentRes.data ?? []) as AgentRow[]).map((r) => ({
    agentEmail: r.agent_email,
    activeAssigned: Number(r.active_assigned ?? 0),
    totalAssigned: Number(r.total_assigned ?? 0),
  }));

  const portfolios: PortfolioTotals[] = ((portfolioRes.data ?? []) as PortfolioRow[]).map((r) => ({
    portfolioId: r.portfolio_id,
    portfolioName: r.portfolio_name,
    teamId: r.team_id ?? undefined,
    managerId: r.manager_id ?? undefined,
    isOpen: r.is_open,
    totalRows: Number(r.total_rows ?? 0),
    activeRows: Number(r.active_rows ?? 0),
    assignedRows: Number(r.assigned_rows ?? 0),
    placedAmount: Number(r.placed_amount ?? 0),
  }));

  try {
    localStorage.setItem(AGENT_KEY, JSON.stringify(agents));
    localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(portfolios));
  } catch (e) {
    // Aggregates are orders of magnitude smaller than the debtor dataset, so this shouldn't
    // happen — but if the origin's quota is already full from portfolio-store's cache, don't
    // let it take the page down. The in-memory event below still delivers fresh numbers.
    console.warn("[report-metrics] could not cache aggregates", e);
  }
  window.dispatchEvent(new CustomEvent("report-metrics-updated"));
}

/** Org-wide totals — admin. `activeAccounts` counts open, unsettled rows; `allTimeAccounts`
 * includes closed cycles and paid-off accounts, shown as the subtitle so nothing is hidden. */
export function summariseTotals(totals: PortfolioTotals[]) {
  return {
    activeAccounts: totals.reduce((s, p) => s + p.activeRows, 0),
    allTimeAccounts: totals.reduce((s, p) => s + p.totalRows, 0),
    openPortfolios: totals.filter((p) => p.isOpen).length,
    placedAmount: totals.reduce((s, p) => s + p.placedAmount, 0),
  };
}
