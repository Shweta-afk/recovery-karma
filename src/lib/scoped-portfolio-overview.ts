// A scoped alternative to portfolio-store.ts's refreshPortfolios() for Portfolio Overview
// (manager.portfolio.tsx). Unlike Call Queue/Debtors/Messages (see scoped-debtors.ts),
// Portfolio Overview genuinely needs more than a plain debtor-rows fetch: it shows CLOSED
// portfolios too (with their last-known stats, not their now-empty rows), per-agent monthly
// targets, and portfolio-wide aggregates — so it gets its own module built on top of
// scoped-debtors.ts's pieces rather than reusing DebtorScope directly.
//
// The other real cost here isn't the debtor rows at all: portfolio_debtor_aggregates(), the
// RPC every portfolio's stats come from, takes no arguments and always scans every debtor the
// caller's RLS lets them see before grouping — measured directly against production
// (2026-09-22): 2.27s for one manager, on top of the already-fixed full debtor sync. See
// migrations/20260923_portfolio_debtor_aggregates_scoped.sql for the portfolio-scoped
// replacement (portfolio_debtor_aggregates_for). Falls back to the original, unscoped RPC if
// that migration hasn't been applied yet — best-effort, same convention portfolio-store.ts
// already uses for a migration that may be ahead of the deployed code.
import { supabase } from "./supabase";
import {
  getScopedPortfolios,
  refreshScopedPortfolios,
  loadAgentEmails,
  getVisiblePortfolioMeta,
  type PortfolioMeta,
} from "./scoped-debtors";
import {
  DEFAULT_PORTFOLIO_SETTINGS,
  type UploadedPortfolio,
  type AgentTarget,
  type PortfolioClosedAggregate,
} from "./portfolio-store";

function overviewKey(portfolioIds: string[]): string {
  return [...new Set(portfolioIds)].sort().join(",");
}

const overviewCache = new Map<string, UploadedPortfolio[]>();

export function getPortfolioOverview(portfolioIds: string[]): UploadedPortfolio[] {
  return overviewCache.get(overviewKey(portfolioIds)) ?? [];
}

interface AggregateRow {
  portfolio_id: string | null;
  total_accounts: number | string | null;
  total_outstanding: number | string | null;
  total_principal: number | string | null;
  assigned_accounts: number | string | null;
  agent_ids: string[] | null;
  retained_accounts: number | string | null;
  retained_amount: number | string | null;
  bucket_x: number | string | null;
  bucket_1: number | string | null;
  bucket_2: number | string | null;
  bucket_npa: number | string | null;
  bucket_writeoff: number | string | null;
}

function isMissingFunctionError(e: { message?: string; code?: string } | null): boolean {
  if (!e) return false;
  // PGRST202 = PostgREST "could not find the function in the schema cache"; 42883 =
  // undefined_function — the two ways "migration not applied yet" shows up here, mirroring
  // isMissingTableError() in portfolio-store.ts for the same class of problem.
  return e.code === "PGRST202" || e.code === "42883" || /schema cache/i.test(e.message ?? "");
}

async function fetchAggregates(portfolioIds: string[]): Promise<AggregateRow[]> {
  const scoped = await supabase.rpc("portfolio_debtor_aggregates_for", {
    p_portfolio_ids: portfolioIds,
  });
  if (!scoped.error) return (scoped.data ?? []) as unknown as AggregateRow[];
  if (!isMissingFunctionError(scoped.error)) {
    console.error("[portfolio-overview] scoped aggregate RPC failed:", scoped.error.message);
    return [];
  }
  // migrations/20260923_portfolio_debtor_aggregates_scoped.sql not applied yet — fall back to
  // the original, unscoped function and filter client-side. Slower (it's the exact cost this
  // module exists to avoid), but correct, and self-heals the moment the migration lands.
  const all = await supabase.rpc("portfolio_debtor_aggregates");
  if (all.error) {
    console.error("[portfolio-overview] fallback aggregate RPC failed:", all.error.message);
    return [];
  }
  const wanted = new Set(portfolioIds);
  return ((all.data ?? []) as unknown as AggregateRow[]).filter(
    (r) => r.portfolio_id && wanted.has(r.portfolio_id),
  );
}

export async function refreshPortfolioOverview(portfolioIds: string[]): Promise<void> {
  const key = overviewKey(portfolioIds);
  if (!portfolioIds.length) {
    overviewCache.set(key, []);
    window.dispatchEvent(new CustomEvent("portfolio-overview-updated", { detail: { key } }));
    return;
  }

  const meta = getVisiblePortfolioMeta().filter((p) => portfolioIds.includes(p.id));
  // Strictly closedAt, not isPortfolioEnded — a portfolio only past its manager-set end date
  // (endDate) keeps its rows fully intact and editable (see the note on isPortfolioEnded in
  // portfolio-store.ts); only an explicit close empties them. Matches refreshPortfolios()'s own
  // `rows: closedAt ? [] : ...` exactly.
  const openIds = meta.filter((p) => !p.closedAt).map((p) => p.id);

  const [, { emailById }, targetsRes, aggRows] = await Promise.all([
    openIds.length ? refreshScopedPortfolios({ kind: "portfolios", portfolioIds: openIds }) : null,
    loadAgentEmails(),
    supabase
      .from("portfolio_agent_targets")
      .select("portfolio_id, agent_id, target_amount, target_accounts")
      .in("portfolio_id", portfolioIds),
    fetchAggregates(portfolioIds),
  ]);

  const targetsByPortfolio = new Map<string, Record<string, AgentTarget>>();
  // Best-effort, same reasoning as portfolio-store.ts: the table may not exist yet on a
  // deployment ahead of migrations/20260806_portfolio_agent_targets.sql.
  if (!targetsRes.error && targetsRes.data) {
    for (const t of targetsRes.data as unknown as {
      portfolio_id: string;
      agent_id: string;
      target_amount: number | string | null;
      target_accounts: number | null;
    }[]) {
      const email = emailById.get(t.agent_id);
      if (!email) continue;
      const forPortfolio = targetsByPortfolio.get(t.portfolio_id) ?? {};
      forPortfolio[email] = {
        targetAmount: t.target_amount != null ? Number(t.target_amount) : undefined,
        targetAccounts: t.target_accounts ?? undefined,
      };
      targetsByPortfolio.set(t.portfolio_id, forPortfolio);
    }
  }

  const aggByPortfolio = new Map<string, PortfolioClosedAggregate>();
  for (const r of aggRows) {
    if (!r.portfolio_id) continue;
    aggByPortfolio.set(r.portfolio_id, {
      totalAccounts: Number(r.total_accounts ?? 0),
      totalOutstanding: Number(r.total_outstanding ?? 0),
      totalPrincipal: Number(r.total_principal ?? 0),
      assignedAccounts: Number(r.assigned_accounts ?? 0),
      agentEmails: (r.agent_ids ?? [])
        .map((id) => emailById.get(id))
        .filter((e): e is string => !!e),
      retainedAccounts: Number(r.retained_accounts ?? 0),
      retainedAmount: Number(r.retained_amount ?? 0),
      buckets: {
        X: Number(r.bucket_x ?? 0),
        "1": Number(r.bucket_1 ?? 0),
        "2": Number(r.bucket_2 ?? 0),
        NPA: Number(r.bucket_npa ?? 0),
        WriteOff: Number(r.bucket_writeoff ?? 0),
      },
    });
  }

  const openPortfolios = openIds.length
    ? getScopedPortfolios({ kind: "portfolios", portfolioIds: openIds })
    : [];
  const rowsById = new Map(openPortfolios.map((p) => [p.id, p.rows]));

  const portfolios: UploadedPortfolio[] = meta.map((p: PortfolioMeta) => ({
    id: p.id,
    name: p.name,
    lender: p.lender ?? "",
    product: p.product ?? "",
    uploadedAt: p.uploadedAt ?? "",
    managerId: p.managerId,
    teamId: p.teamId,
    settings: p.settings ?? DEFAULT_PORTFOLIO_SETTINGS,
    agentTargets: targetsByPortfolio.get(p.id) ?? {},
    replacesPortfolioId: p.replacesPortfolioId,
    closedAt: p.closedAt,
    endDate: p.endDate,
    storedTotalAccounts: p.storedTotalAccounts,
    closedAggregate: aggByPortfolio.get(p.id),
    rows: p.closedAt ? [] : (rowsById.get(p.id) ?? []),
  }));

  overviewCache.set(key, portfolios);
  window.dispatchEvent(new CustomEvent("portfolio-overview-updated", { detail: { key } }));
}
