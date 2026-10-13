// A narrow alternative to portfolio-store.ts's refreshPortfolios(), used by Call Queue and the
// Debtors page.
//
// refreshPortfolios() downloads EVERY debtor visible to the signed-in user — for a manager
// that's every account their team can see — across five-plus separate full-table queries.
// Measured directly against production (2026-09-22): the main query alone took 1.3s in
// Postgres for one manager's 6,646 visible rows, because RLS can only narrow the search to
// "this client's debtors" (client_id) before checking the assignment condition row by row;
// there is no index that lets it jump straight to "this agent's rows" or "this portfolio's
// rows". The `extra` column (the bank file's ~150 unmapped columns) adds ~1.4KB/row on top —
// 9MB+ before JSON encoding for that one manager. It is also the reason this project has
// already hit localStorage's ~5-10MB quota twice (see recoveryai-localstorage-cache-limit).
// (2026-09-23: `extra` is no longer selected in full — see debtor-extra.ts.)
//
// This module fetches only the rows the CALLER actually needs — one agent's book, or one
// manager's active team's portfolios — filtered server-side so Postgres can use
// idx_debtors_agent_id / idx_debtors_portfolio_id directly instead of scanning the client's
// whole debtor set.
//
// In-memory only, deliberately NOT localStorage: the fetch is now cheap enough to just repeat
// on load, and a manager clicking through many agents in Agent Live View would otherwise leave
// one localStorage entry per agent behind, drifting back toward the same quota problem this
// module exists to avoid.
//
// Scope: Messages, Reports, Portfolio Overview (scoped-portfolio-overview.ts) and Manual Dial's
// Loan ID lookup. Call Queue and the Debtors page no longer use it (2026-10-13): they ask the
// database for one page at a time — see debtor-page-store.ts.
import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";
import { selectWithSlimExtra, slimExtraFromRow } from "./debtor-extra";
import {
  dpd2bucket,
  isPortfolioEnded,
  DEFAULT_PORTFOLIO_SETTINGS,
  PRODUCT_ENUM_TO_LABEL,
  type UploadedPortfolio,
  type UploadedDebtor,
  type PortfolioSettings,
} from "./portfolio-store";

/** Which slice of the debtors table to fetch.
 *
 * - `agents` filters by assigned_agent_id — a Call Queue's natural scope, and an agent's own
 *   Debtors/Messages book.
 * - `portfolios` filters by portfolio_id — a manager's Debtors page, where an unassigned
 *   account in a visible portfolio must still show. `portfolioIds` is resolved by the caller
 *   via getVisiblePortfolioMeta() so a closed or out-of-team portfolio is never even queried.
 * - `visible` adds no extra filter at all beyond what debtors_select already restricts the
 *   caller to — for a page like Messages that has always shown a manager's (or admin's) WHOLE
 *   visible book, not just their active team's. Still a real improvement over the old
 *   five-plus-query full sync: one query instead of several, and no supplementary full-table
 *   scans for alt_phones/principal_amount/etc. — but, unlike the other two, the RESULT size for
 *   a manager or admin doesn't shrink, since RLS was already the only thing scoping it. */
export type DebtorScope = (
  | { kind: "agents"; agentIds: string[] }
  | { kind: "portfolios"; portfolioIds: string[] }
  | { kind: "visible" }
  /** One Loan/Account ID, matched case-insensitively — Manual Dial's lookup (loan-ref-lookup.ts).
   * `loanRef` must already be trimmed and free of LIKE wildcards; see that module. */
  | { kind: "loanRef"; loanRef: string }
) & {
  /** Also fetch the first 25 bank-file columns per row (`extra_head`) — Call Queue renders
   * them as table columns. Everyone else gets only the named sub-fields; see debtor-extra.ts.
   * Part of the cache key, so a Call Queue and a Debtors page on the same scope never hand
   * each other the wrong-sized rows. */
  extraColumns?: boolean;
};

function scopeKey(scope: DebtorScope): string {
  const head = scope.extraColumns ? "+head" : "";
  if (scope.kind === "agents")
    return `agents:${[...new Set(scope.agentIds)].sort().join(",")}${head}`;
  if (scope.kind === "portfolios")
    return `portfolios:${[...new Set(scope.portfolioIds)].sort().join(",")}${head}`;
  if (scope.kind === "loanRef") return `loanRef:${scope.loanRef.toLowerCase()}${head}`;
  return `visible${head}`;
}

const portfolioCache = new Map<string, UploadedPortfolio[]>();

export function getScopedPortfolios(scope: DebtorScope): UploadedPortfolio[] {
  return portfolioCache.get(scopeKey(scope)) ?? [];
}

function notify(scopeKeyStr: string) {
  window.dispatchEvent(
    new CustomEvent("scoped-portfolios-updated", { detail: { scopeKey: scopeKeyStr } }),
  );
}

// Everything portfolio-store.ts's refreshPortfolios() gathers across its main select plus the
// alt_phones / principal_amount+emi_amount+product_code "best-effort" follow-up queries — all
// confirmed live on the debtors table (information_schema, 2026-09-22), so unlike that older
// code this can read them in the one query without a migration-not-applied-yet fallback.
//
// `extra` is NOT in this list: selectWithSlimExtra() appends the slim computed columns instead
// (debtor-extra.ts), so a row's `extra` here is a subset of the real bag.
const DEBTOR_COLUMNS =
  "id, portfolio_id, name, phone_primary, email, loan_amount, dpd, loan_reference, " +
  "assigned_agent_id, status, alt_phones, principal_amount, emi_amount, product_code, " +
  "retained_from_portfolio_id";

interface DebtorRow {
  id: string;
  portfolio_id: string | null;
  name: string;
  phone_primary: string;
  email: string | null;
  loan_amount: number | string | null;
  dpd: number | null;
  loan_reference: string | null;
  extra?: Record<string, string> | null;
  extra_named?: Record<string, string> | null;
  extra_head?: Record<string, string> | null;
  assigned_agent_id: string | null;
  status: string | null;
  alt_phones: string[] | null;
  principal_amount: number | string | null;
  emi_amount: number | string | null;
  product_code: string | null;
  retained_from_portfolio_id: string | null;
}

interface PortfolioRow {
  id: string;
  name: string;
  lender_name: string | null;
  product_type: string | null;
  uploaded_at: string | null;
  settings: unknown;
  team_id: string | null;
  manager_id: string | null;
  closed_at: string | null;
  end_date: string | null;
}

/** id -> email, the small agents table (RLS already scopes it to who the caller may see). Not
 * cached across calls: it is cheap (an org's agent count, not its debtor count) and every
 * caller here already accepts one query per refresh in exchange for a much smaller one. */
export async function loadAgentEmails(): Promise<{
  idByEmail: Map<string, string>;
  emailById: Map<string, string>;
}> {
  const { data } = await supabase.from("agents").select("id, email");
  const rows = (data ?? []) as { id: string; email: string }[];
  return {
    idByEmail: new Map(rows.map((a) => [a.email, a.id])),
    emailById: new Map(rows.map((a) => [a.id, a.email])),
  };
}

/** fetchAllRows()'s shape for a query that is known to fit one page. */
async function fetchOnePage<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const { data, error } = await page(0, 49);
  return { data: data ?? [], error };
}

export async function refreshScopedPortfolios(scope: DebtorScope): Promise<void> {
  const key = scopeKey(scope);
  const { idByEmail, emailById } = await loadAgentEmails();

  // Resolves the scope down to the one extra .in(...) filter (if any) to apply on top of the
  // status filter every branch shares — RLS itself is always the outer boundary regardless.
  let uuids: string[] | undefined;
  if (scope.kind === "agents") {
    uuids = scope.agentIds.map((email) => idByEmail.get(email)).filter((x): x is string => !!x);
    if (!uuids.length) {
      portfolioCache.set(key, []);
      notify(key);
      return;
    }
  } else if (scope.kind === "portfolios" && !scope.portfolioIds.length) {
    portfolioCache.set(key, []);
    notify(key);
    return;
  }

  // A Loan ID names one account (a handful at most across portfolios), so it is one request —
  // fetchAllRows always fires several pages at once, which is wasted on a lookup.
  const pageRange = (from: number, to: number) =>
    scope.kind === "loanRef" ? ([0, 49] as const) : ([from, to] as const);
  const fetchPages = scope.kind === "loanRef" ? fetchOnePage : fetchAllRows;
  const { data, error } = await selectWithSlimExtra(!!scope.extraColumns, (extraColumns) =>
    fetchPages<DebtorRow>((from, to) => {
      let q = supabase
        .from("debtors")
        .select(`${DEBTOR_COLUMNS}, ${extraColumns}`)
        .neq("status", "removed");
      if (scope.kind === "agents") q = q.in("assigned_agent_id", uuids as string[]);
      else if (scope.kind === "portfolios") q = q.in("portfolio_id", scope.portfolioIds);
      else if (scope.kind === "loanRef") q = q.ilike("loan_reference", scope.loanRef);
      // scope.kind === "visible": no extra filter — RLS alone decides what comes back.
      return q.range(...pageRange(from, to)) as unknown as PromiseLike<{
        data: DebtorRow[] | null;
        error: { message: string } | null;
      }>;
    }),
  );
  // Silently keep the previous cache rather than clearing it on a transient failure — the same
  // choice refreshPortfolios() makes, so a flaky request doesn't blank a working screen.
  if (error) return;
  const debtorRows = data;

  // Portfolios referenced either directly (portfolio_id) or as the OLD cycle a retained debtor
  // came from (retained_from_portfolio_id, for the "Retained from X" label) — a superset of
  // scope.portfolioIds when scope.kind is "portfolios", since a retained-from portfolio can be
  // a closed one outside the caller's pre-resolved, open-only list.
  const portfolioIds = new Set<string>();
  for (const r of debtorRows) {
    if (r.portfolio_id) portfolioIds.add(r.portfolio_id);
    if (r.retained_from_portfolio_id) portfolioIds.add(r.retained_from_portfolio_id);
  }

  let portfolioRows: PortfolioRow[] = [];
  if (portfolioIds.size) {
    const { data, error } = await supabase
      .from("portfolios")
      .select(
        "id, name, lender_name, product_type, uploaded_at, settings, team_id, manager_id, closed_at, end_date",
      )
      .in("id", [...portfolioIds]);
    if (error) return;
    portfolioRows = (data ?? []) as unknown as PortfolioRow[];
  }
  const portfolioNameById = new Map(portfolioRows.map((p) => [p.id, p.name]));

  const byPortfolio = new Map<string, UploadedDebtor[]>();
  for (const d of debtorRows) {
    // An ad-hoc manual-dial debtor (createAdHocDebtor) has no portfolio — neither Call Queue
    // nor the Debtors page shows those today via the portfolio-rows path, so this matches.
    if (!d.portfolio_id) continue;
    const retainedFromPortfolioId = d.retained_from_portfolio_id ?? undefined;
    const list = byPortfolio.get(d.portfolio_id) ?? [];
    list.push({
      id: d.id,
      loanReference: d.loan_reference ?? d.id,
      name: d.name,
      phone: d.phone_primary,
      loanAmount: Number(d.loan_amount ?? 0),
      principalAmount: Number(d.principal_amount ?? 0),
      emiAmount: Number(d.emi_amount ?? 0),
      productCode: d.product_code ?? "",
      dpd: d.dpd ?? 0,
      bucket: dpd2bucket(d.dpd ?? 0),
      email: d.email ?? "",
      assignedAgentId: d.assigned_agent_id ? emailById.get(d.assigned_agent_id) : undefined,
      status: d.status ?? undefined,
      extra: slimExtraFromRow(d),
      altPhones: d.alt_phones ?? [],
      retained: !!retainedFromPortfolioId,
      retainedFrom: retainedFromPortfolioId
        ? portfolioNameById.get(retainedFromPortfolioId)
        : undefined,
    });
    byPortfolio.set(d.portfolio_id, list);
  }

  const portfolios: UploadedPortfolio[] = portfolioRows
    // Only portfolios that actually contributed a row in this scope — for scope.kind ===
    // "portfolios" the caller already excluded closed ones, so this mainly drops a
    // retained-from portfolio with no OTHER row in scope; buildQueueFromPortfolios /
    // dashboard.debtors.tsx only ever read `.rows`, so an empty-shell entry would add nothing.
    .filter((p) => byPortfolio.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      lender: p.lender_name ?? "",
      product: p.product_type ? (PRODUCT_ENUM_TO_LABEL[p.product_type] ?? p.product_type) : "",
      uploadedAt: p.uploaded_at ?? "",
      managerId: p.manager_id ? emailById.get(p.manager_id) : undefined,
      teamId: p.team_id ?? undefined,
      settings: (p.settings as unknown as PortfolioSettings) ?? DEFAULT_PORTFOLIO_SETTINGS,
      // Per-agent monthly targets are not shown on Call Queue or the Debtors page (only on
      // Portfolio Overview / Reports, which keep using the full portfolio-store.ts cache), so
      // there is nothing to lose by not fetching portfolio_agent_targets here.
      agentTargets: {},
      closedAt: p.closed_at ?? undefined,
      endDate: p.end_date ?? undefined,
      rows: byPortfolio.get(p.id) ?? [],
    }));

  portfolioCache.set(key, portfolios);
  notify(key);
}

// ── Portfolio metadata only, no debtor rows — for resolving "which portfolios is my active
// team's book in" before fetching any debtors. The portfolios table itself is small (an org's
// portfolio count, not its debtor count) and carries no `extra`-sized column, so fetching it
// in full is cheap; RLS already scopes it to what the caller may see. ──────────────────────

export interface PortfolioMeta {
  id: string;
  name: string;
  teamId?: string;
  managerId?: string;
  closedAt?: string;
  endDate?: string;
  // Everything below is extra beyond what dashboard.debtors.tsx's manager path reads — added
  // for scoped-portfolio-overview.ts, which needs the full UploadedPortfolio shape. Kept on
  // this one shared fetch rather than a second near-identical portfolios query.
  lender?: string;
  product?: string;
  uploadedAt?: string;
  settings?: PortfolioSettings;
  replacesPortfolioId?: string;
  storedTotalAccounts?: number;
}

let portfolioMeta: PortfolioMeta[] = [];

export function getVisiblePortfolioMeta(): PortfolioMeta[] {
  return portfolioMeta;
}

const PORTFOLIO_META_COLUMNS =
  "id, name, lender_name, product_type, uploaded_at, settings, team_id, manager_id, " +
  "closed_at, end_date, replaces_portfolio_id, total_accounts";

export async function refreshVisiblePortfolioMeta(): Promise<void> {
  const [{ data, error }, { emailById }] = await Promise.all([
    // Deleted-but-kept portfolios (deletePortfolio) are hidden from every portfolio list.
    supabase.from("portfolios").select(PORTFOLIO_META_COLUMNS).is("deleted_at", null),
    loadAgentEmails(),
  ]);
  if (error || !data) return;
  portfolioMeta = (
    data as unknown as (PortfolioRow & {
      replaces_portfolio_id: string | null;
      total_accounts: number | null;
    })[]
  ).map((p) => ({
    id: p.id,
    name: p.name,
    teamId: p.team_id ?? undefined,
    managerId: p.manager_id ? emailById.get(p.manager_id) : undefined,
    closedAt: p.closed_at ?? undefined,
    endDate: p.end_date ?? undefined,
    lender: p.lender_name ?? "",
    product: p.product_type ? (PRODUCT_ENUM_TO_LABEL[p.product_type] ?? p.product_type) : "",
    uploadedAt: p.uploaded_at ?? "",
    settings: (p.settings as unknown as PortfolioSettings) ?? DEFAULT_PORTFOLIO_SETTINGS,
    replacesPortfolioId: p.replaces_portfolio_id ?? undefined,
    storedTotalAccounts: p.total_accounts ?? undefined,
  }));
  window.dispatchEvent(new CustomEvent("visible-portfolio-meta-updated"));
}

/** True once a portfolio's cycle is over — same rule as portfolio-store.ts's isPortfolioEnded,
 * re-exported here so callers resolving a manager's visible portfolio ids don't need to import
 * both modules for one check. */
export { isPortfolioEnded };
