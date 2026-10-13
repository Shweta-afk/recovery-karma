// One page of debtors at a time, for the Debtors page and Call Queue.
//
// Both screens used to download the caller's whole book first — scoped-debtors.ts's
// refreshScopedPortfolios() at 1,000 rows per request, and for an admin the full
// refreshPortfolios() sync (29,800 rows for the largest company on 2026-10-13) — and then filter,
// sort and page in the browser. Every upload made them slower. Now the database does the
// filtering, sorting, paging and counting (debtor_list(), migrations/20261013_debtor_list_page.sql)
// and the browser holds only what is on screen:
//
//   rows   — one page (≤100) for the current filters and sort
//   count  — how many rows match the current filters (the pager and "N debtors")
//   facets — counts grouped by a few dimensions over the whole scope (dropdown counts, KPI cards)
//
// The three are separate requests so the first page paints without waiting for the counts, which
// still have to look at every row in scope. debtor_list is SECURITY INVOKER: RLS decides what
// exists, and the scope here only narrows it.
//
// Usual store shape: get*() reads the in-memory cache, refresh*() fetches and dispatches
// DEBTOR_PAGE_UPDATED. In memory only (not localStorage), like scoped-debtors.ts. useDebtorList()
// wires one screen's query to the cache and re-fetches on the app's `*-updated` events so a write
// anywhere (a disposition, a reassignment, an upload) shows up without a reload.
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { slimExtraFromRow } from "./debtor-extra";
import { loadAgentEmails } from "./scoped-debtors";
import { INSIGHT_FLAGS_UPDATED } from "./insight-request-store";
import {
  debtorFromRow,
  dpd2bucket,
  DEFAULT_PORTFOLIO_SETTINGS,
  PRODUCT_ENUM_TO_LABEL,
  type UploadedDebtor,
  type UploadedPortfolio,
} from "./portfolio-store";
import type { DPDBucket } from "./mock-debtors";
import type { CallOutcome, QueueDebtor } from "./call-queue/types";

export const DEBTOR_PAGE_UPDATED = "debtor-page-updated";
export const PAGE_SIZE = 100;

/** Events after which what is on screen may be stale. Writes elsewhere in the app already fire
 * these (portfolio-store, scoped-debtors, disposition-store, insight flags). */
const LIVE_EVENTS = [
  "portfolios-updated",
  "scoped-portfolios-updated",
  "dispositions-updated",
  INSIGHT_FLAGS_UPDATED,
];

export type InsightFilterValue = "requested" | "traced" | "none";
export type QueueStatus = QueueDebtor["queueStatus"];
export type FacetDim =
  | "portfolio_id"
  | "assigned_agent_id"
  | "insight"
  | "bucket"
  | "retained"
  | "queue_status"
  | "own_outcome"
  | "own_reason";

/** Everything that decides WHICH rows are in the list, minus paging. Agents are named by
 * account email, as everywhere else in the app; the store resolves them to ids. */
export interface DebtorQuery {
  /** Assigned to one of these agents (emails). */
  agents?: string[];
  /** In one of these portfolios. */
  portfolioIds?: string[];
  /** Only these debtors. */
  ids?: string[];
  /** Drop closed / past-end-date portfolios (isPortfolioEnded). */
  openOnly?: boolean;
  /** Drop status 'paid' (Call Queue — a bank paid-file moved them out of the active queue). */
  excludePaid?: boolean;
  /** Call Queue: adds queue status / PTP / own outcome per row and the filters on them. */
  queue?: boolean;
  /** Also return the first 25 bank-file columns per row (Call Queue's extra columns). */
  extraHead?: boolean;

  portfolioId?: string;
  search?: string;
  bucket?: DPDBucket;
  /** An agent email, or "unassigned". */
  assignee?: string;
  insight?: InsightFilterValue;
  contactedFrom?: string;
  contactedTo?: string;
  retained?: boolean;
  queueStatuses?: QueueStatus[];
  ownOutcome?: string;
  ownReason?: string;
  outstanding?: "lt1L" | "1to5L" | "gt5L";
  dpdBand?: "lt30" | "30to60" | "61to90" | "gt90";
  scoreBand?: "high" | "mid" | "low";
  sort?: string;
  dir?: "asc" | "desc";
}

/** The fields of a query that only narrow within the scope — dropped for facets, which count
 * the whole scope. */
const FILTER_KEYS: (keyof DebtorQuery)[] = [
  "portfolioId",
  "search",
  "bucket",
  "assignee",
  "insight",
  "contactedFrom",
  "contactedTo",
  "retained",
  "queueStatuses",
  "ownOutcome",
  "ownReason",
  "outstanding",
  "dpdBand",
  "scoreBand",
  "sort",
  "dir",
];

/** One row as debtor_list returns it. */
interface RawRow {
  id: string;
  portfolio_id: string;
  portfolio_name: string | null;
  lender_name: string | null;
  product_type: string | null;
  name: string;
  phone_primary: string;
  email: string | null;
  loan_amount: number | string | null;
  dpd: number | null;
  loan_reference: string | null;
  assigned_agent_id: string | null;
  status: string | null;
  alt_phones: string[] | null;
  principal_amount: number | string | null;
  emi_amount: number | string | null;
  product_code: string | null;
  retained_from_portfolio_id: string | null;
  retained_from_name: string | null;
  last_contacted_at: string | null;
  extra_named?: Record<string, string> | null;
  extra_head?: Record<string, string> | null;
  last_outcome?: string | null;
  ptp_amount?: number | string | null;
  ptp_date?: string | null;
  own_outcome?: string | null;
  own_reason?: string | null;
}

/** A listed debtor: the Debtor shape every screen and the profile sheet already use, plus the
 * queue fields (fresh/0 when the query is not a queue query). */
export type ListedDebtor = QueueDebtor & {
  /** Latest outcome logged by one of the query's agents — Call Queue's Disposition filter. */
  ownOutcome?: CallOutcome;
  ownReason?: string;
};

export interface FacetGroup {
  portfolio_id?: string;
  assigned_agent_id?: string | null;
  insight?: InsightFilterValue;
  bucket?: DPDBucket;
  retained?: boolean;
  queue_status?: QueueStatus;
  own_outcome?: string | null;
  own_reason?: string | null;
  n: number;
  loan_sum: number;
  ptp_sum?: number;
  contacted_today: number;
}

// ── Agent email <-> id ───────────────────────────────────────────────────────────────────────

let agentMap: Promise<Awaited<ReturnType<typeof loadAgentEmails>>> | null = null;
let agentMapAt = 0;

/** The agents roster, reused for a minute so a page turn is one request, not two. */
function agents() {
  if (!agentMap || Date.now() - agentMapAt > 60_000) {
    agentMapAt = Date.now();
    agentMap = loadAgentEmails().catch((e) => {
      agentMap = null;
      throw e;
    });
  }
  return agentMap;
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────

class ScopeEmpty extends Error {}

async function toParams(q: DebtorQuery): Promise<Record<string, unknown>> {
  const needsAgents = !!q.agents || (q.assignee && q.assignee !== "unassigned");
  const { idByEmail } = needsAgents ? await agents() : { idByEmail: new Map<string, string>() };
  const p: Record<string, unknown> = {
    queue: !!q.queue,
    open_only: !!q.openOnly,
    exclude_paid: !!q.excludePaid,
    extra_head: !!q.extraHead,
  };
  if (q.agents) {
    const ids = q.agents.map((e) => idByEmail.get(e)).filter((x): x is string => !!x);
    if (!ids.length) throw new ScopeEmpty();
    p.agent_ids = ids;
  }
  if (q.portfolioIds) {
    if (!q.portfolioIds.length) throw new ScopeEmpty();
    p.portfolio_ids = q.portfolioIds;
  }
  if (q.ids) {
    if (!q.ids.length) throw new ScopeEmpty();
    p.ids = q.ids;
  }
  if (q.portfolioId) p.portfolio_id = q.portfolioId;
  if (q.search?.trim()) p.search = q.search.trim();
  if (q.bucket) p.bucket = q.bucket;
  if (q.assignee === "unassigned") p.assignee = "unassigned";
  else if (q.assignee) {
    const id = idByEmail.get(q.assignee);
    if (!id) throw new ScopeEmpty();
    p.assignee = id;
  }
  if (q.insight) p.insight = q.insight;
  if (q.contactedFrom) p.contacted_from = q.contactedFrom;
  if (q.contactedTo) p.contacted_to = q.contactedTo;
  if (q.retained) p.retained = true;
  if (q.queueStatuses) p.queue_statuses = q.queueStatuses;
  if (q.ownOutcome) p.own_outcome = q.ownOutcome;
  if (q.ownReason) p.own_reason = q.ownReason;
  if (q.outstanding) p.outstanding = q.outstanding;
  if (q.dpdBand) p.dpd_band = q.dpdBand;
  if (q.scoreBand) p.score_band = q.scoreBand;
  if (q.sort) p.sort = q.sort;
  if (q.dir) p.dir = q.dir;
  return p;
}

async function call<T>(params: Record<string, unknown>): Promise<T> {
  // debtor_list is newer than the generated Database types.
  const rpc = supabase.rpc as unknown as (
    fn: string,
    args: { p: Record<string, unknown> },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc("debtor_list", { p: params });
  if (error) throw new Error(error.message);
  return data as T;
}

function toListed(r: RawRow, emailById: Map<string, string>): ListedDebtor {
  const row: UploadedDebtor = {
    id: r.id,
    loanReference: r.loan_reference ?? r.id,
    name: r.name,
    phone: r.phone_primary,
    loanAmount: Number(r.loan_amount ?? 0),
    principalAmount: Number(r.principal_amount ?? 0),
    emiAmount: Number(r.emi_amount ?? 0),
    productCode: r.product_code ?? "",
    dpd: r.dpd ?? 0,
    bucket: dpd2bucket(r.dpd ?? 0),
    email: r.email ?? "",
    assignedAgentId: r.assigned_agent_id ? emailById.get(r.assigned_agent_id) : undefined,
    status: r.status ?? undefined,
    extra: slimExtraFromRow(r),
    altPhones: r.alt_phones ?? [],
    retained: !!r.retained_from_portfolio_id,
    retainedFrom: r.retained_from_name ?? undefined,
  };
  // debtorFromRow reads only these portfolio fields; the rest is the list's business, not the
  // row's.
  const portfolio = {
    id: r.portfolio_id,
    name: r.portfolio_name ?? "Portfolio",
    lender: r.lender_name ?? "",
    product: r.product_type ? (PRODUCT_ENUM_TO_LABEL[r.product_type] ?? r.product_type) : "",
    uploadedAt: "",
    settings: DEFAULT_PORTFOLIO_SETTINGS,
    agentTargets: {},
    rows: [],
  } as UploadedPortfolio;
  const promised = r.last_outcome === "promised";
  return {
    ...debtorFromRow(row, portfolio),
    loanReference: row.loanReference,
    portfolioId: r.portfolio_id,
    // The same mapping build-queue.ts applied to the latest disposition.
    queueStatus:
      r.last_outcome === "promised"
        ? "ptp"
        : r.last_outcome === "callback"
          ? "callback"
          : r.last_outcome === "no_answer"
            ? "no_answer"
            : "fresh",
    scheduledAt: promised && r.ptp_date ? r.ptp_date : "—",
    ptpAmount: promised ? Number(r.ptp_amount ?? 0) : 0,
    ownOutcome: (r.own_outcome as CallOutcome | null) ?? undefined,
    ownReason: r.own_reason ?? undefined,
  };
}

/** Rows `offset .. offset+limit` for a query, already in the screens' Debtor shape. */
export async function fetchDebtorRows(
  q: DebtorQuery,
  offset: number,
  limit: number,
): Promise<ListedDebtor[]> {
  let params: Record<string, unknown>;
  try {
    params = await toParams(q);
  } catch (e) {
    if (e instanceof ScopeEmpty) return [];
    throw e;
  }
  const [{ rows }, { emailById }] = await Promise.all([
    call<{ rows: RawRow[] }>({ ...params, mode: "rows", offset, limit }),
    agents(),
  ]);
  return rows.map((r) => toListed(r, emailById));
}

/** Every row of a query, a thousand at a time — for actions that need the whole filtered list
 * (CSV export, starting the dialer), never for rendering. Slim: no bank-file columns. */
export async function fetchAllDebtorRows(q: DebtorQuery, cap = 20_000): Promise<ListedDebtor[]> {
  const slim = { ...q, extraHead: false };
  const out: ListedDebtor[] = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    const page = await fetchDebtorRows(slim, offset, Math.min(1000, cap - offset));
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// ── Cache ────────────────────────────────────────────────────────────────────────────────────

const rowsCache = new Map<string, ListedDebtor[]>();
const countCache = new Map<string, number>();
const facetCache = new Map<string, FacetGroup[]>();

function scopeOnly(q: DebtorQuery): DebtorQuery {
  const s = { ...q };
  for (const k of FILTER_KEYS) delete s[k];
  return s;
}

export function queryKey(q: DebtorQuery): string {
  return JSON.stringify(q, Object.keys(q).sort());
}
const pageKey = (q: DebtorQuery, page: number) => `${queryKey(q)}#${page}`;
const facetKey = (q: DebtorQuery, dims: FacetDim[]) =>
  `${queryKey(scopeOnly(q))}#${dims.join(",")}`;

function notify(kind: "rows" | "count" | "facets") {
  window.dispatchEvent(new CustomEvent(DEBTOR_PAGE_UPDATED, { detail: { kind } }));
}

export function getDebtorPage(q: DebtorQuery, page: number): ListedDebtor[] | undefined {
  return rowsCache.get(pageKey(q, page));
}
export async function refreshDebtorPage(q: DebtorQuery, page: number): Promise<void> {
  const rows = await fetchDebtorRows(q, page * PAGE_SIZE, PAGE_SIZE);
  rowsCache.set(pageKey(q, page), rows);
  notify("rows");
}

export function getDebtorCount(q: DebtorQuery): number | undefined {
  return countCache.get(queryKey(q));
}
export async function refreshDebtorCount(q: DebtorQuery): Promise<void> {
  let total = 0;
  try {
    total = (await call<{ total: number }>({ ...(await toParams(q)), mode: "count" })).total;
  } catch (e) {
    if (!(e instanceof ScopeEmpty)) throw e;
  }
  countCache.set(queryKey(q), total);
  notify("count");
}

export function getDebtorFacets(q: DebtorQuery, dims: FacetDim[]): FacetGroup[] | undefined {
  return facetCache.get(facetKey(q, dims));
}
export async function refreshDebtorFacets(q: DebtorQuery, dims: FacetDim[]): Promise<void> {
  let groups: FacetGroup[] = [];
  try {
    const params = await toParams(scopeOnly(q));
    const { emailById } = await agents();
    groups = (await call<{ groups: FacetGroup[] }>({ ...params, mode: "facets", dims })).groups;
    // Agent ids come back as uuids; the app keys agents by email.
    for (const g of groups) {
      if (g.assigned_agent_id) g.assigned_agent_id = emailById.get(g.assigned_agent_id) ?? null;
      g.n = Number(g.n);
      g.loan_sum = Number(g.loan_sum ?? 0);
      g.ptp_sum = Number(g.ptp_sum ?? 0);
      g.contacted_today = Number(g.contacted_today ?? 0);
    }
  } catch (e) {
    if (!(e instanceof ScopeEmpty)) throw e;
  }
  facetCache.set(facetKey(q, dims), groups);
  notify("facets");
}

/** Sums facet groups that pass `keep`. */
export function sumFacets(
  groups: FacetGroup[] | undefined,
  keep: (g: FacetGroup) => boolean = () => true,
) {
  const t = { n: 0, loan: 0, ptp: 0, contactedToday: 0 };
  for (const g of groups ?? []) {
    if (!keep(g)) continue;
    t.n += g.n;
    t.loan += g.loan_sum;
    t.ptp += g.ptp_sum ?? 0;
    t.contactedToday += g.contacted_today;
  }
  return t;
}

/** Counts per value of one dimension. */
export function countBy<K extends FacetDim>(
  groups: FacetGroup[] | undefined,
  dim: K,
  keep: (g: FacetGroup) => boolean = () => true,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups ?? []) {
    if (!keep(g)) continue;
    const k = String(g[dim] ?? "");
    out.set(k, (out.get(k) ?? 0) + g.n);
  }
  return out;
}

// ── Hook ─────────────────────────────────────────────────────────────────────────────────────

export interface DebtorList {
  rows: ListedDebtor[];
  /** True until the first response for this query + page arrives. */
  loading: boolean;
  /** Undefined while the count is still on its way. */
  total: number | undefined;
  facets: FacetGroup[] | undefined;
  error: string | null;
}

/**
 * One screen's list. `query` null = not ready to ask yet (e.g. a manager's portfolios are
 * still being resolved). Fetches the page first, then the count and facets; re-fetches all
 * three on LIVE_EVENTS, debounced so one save that fires several events costs one round.
 * A page refresh after a write keeps the same page — an agent on page 3 stays on page 3.
 */
export function useDebtorList(
  query: DebtorQuery | null,
  page: number,
  dims: FacetDim[] = [],
): DebtorList {
  const key = query ? queryKey(query) : "";
  const dimsKey = dims.join(",");
  const [, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(DEBTOR_PAGE_UPDATED, bump);
    return () => window.removeEventListener(DEBTOR_PAGE_UPDATED, bump);
  }, []);

  // Facets: scope only, so they are not re-fetched when a filter, the sort or the page changes.
  const scopeKey = query ? queryKey(scopeOnly(query)) : "";
  useEffect(() => {
    if (!query || !dims.length) return;
    const run = () =>
      refreshDebtorFacets(query, dims).catch((e) => console.error("[debtor-list] facets", e));
    run();
    let t: ReturnType<typeof setTimeout> | undefined;
    const onLive = () => {
      clearTimeout(t);
      t = setTimeout(run, 400);
    };
    for (const ev of LIVE_EVENTS) window.addEventListener(ev, onLive);
    return () => {
      clearTimeout(t);
      for (const ev of LIVE_EVENTS) window.removeEventListener(ev, onLive);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, dimsKey]);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const run = async (withCount: boolean) => {
      try {
        // Page first: it is what paints. The count has to visit every matching row.
        await refreshDebtorPage(query, page);
        if (!cancelled) setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      if (withCount)
        refreshDebtorCount(query).catch((e) => console.error("[debtor-list] count", e));
    };
    void run(getDebtorCount(query) === undefined);
    let t: ReturnType<typeof setTimeout> | undefined;
    const onLive = () => {
      clearTimeout(t);
      t = setTimeout(() => void run(true), 400);
    };
    for (const ev of LIVE_EVENTS) window.addEventListener(ev, onLive);
    return () => {
      cancelled = true;
      clearTimeout(t);
      for (const ev of LIVE_EVENTS) window.removeEventListener(ev, onLive);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page]);

  // Read straight from the module caches on every render; DEBTOR_PAGE_UPDATED re-renders.
  const cached = query ? getDebtorPage(query, page) : undefined;
  return {
    rows: cached ?? [],
    loading: !!query && cached === undefined && !error,
    total: query ? getDebtorCount(query) : 0,
    facets: query && dims.length ? getDebtorFacets(query, dims) : undefined,
    error,
  };
}
