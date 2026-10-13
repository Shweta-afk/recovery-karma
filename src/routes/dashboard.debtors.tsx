import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Search, X, ChevronRight, ChevronDown, FileDown, Upload, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { DateRangeFilter } from "@/components/date-range-filter";
import { EMPTY_RANGE, type DateRange } from "@/lib/date-filter";
import {
  bucketOf,
  formatINR,
  displayId,
  type Debtor,
  type DPDBucket,
  BUCKET_META,
} from "@/lib/mock-debtors";
import { useActiveTeam } from "@/lib/active-team-store";
import { useRoster } from "@/lib/team-store";
import {
  getVisiblePortfolioMeta,
  refreshVisiblePortfolioMeta,
  isPortfolioEnded,
} from "@/lib/scoped-debtors";
import {
  countBy,
  fetchAllDebtorRows,
  fetchDebtorRows,
  sumFacets,
  useDebtorList,
  type DebtorQuery,
  type FacetDim,
} from "@/lib/debtor-page-store";
import { useAuth } from "@/lib/auth";
import { AssignedAgentLine } from "@/components/assigned-agent";
import { DebtorProfile } from "@/components/debtor-profile";
import { ListPager, serverPaged, useServerPage } from "@/components/list-pager";
import {
  INSIGHT_FLAGS_UPDATED,
  getInsightFlag,
  refreshInsightFlags,
  type InsightFlag,
} from "@/lib/insight-request-store";

/** Insights filter: a flag, "none" = never looked up and not requested, "all" = no filter. */
type InsightFilter = InsightFlag | "none" | "all";

const INSIGHT_FILTER_OPTIONS: { key: Exclude<InsightFilter, "all">; label: string }[] = [
  { key: "requested", label: "Insights requested" },
  { key: "traced", label: "Insights run" },
  { key: "none", label: "Not looked up" },
];

/** Card tint by Insights state: amber = an agent has asked a manager for a lookup that hasn't
 *  been run yet, emerald = a lookup has already come back, plain = neither. */
const INSIGHT_FLAG_META: Record<InsightFlag, { card: string; dot: string; label: string }> = {
  requested: {
    card: "border-amber-400/60 bg-amber-50 dark:bg-amber-500/10",
    dot: "bg-amber-500",
    label: "Insights requested",
  },
  traced: {
    card: "border-emerald-400/60 bg-emerald-50 dark:bg-emerald-500/10",
    dot: "bg-emerald-500",
    label: "Insights run",
  },
};

/** Filter value standing for "nobody owns this account". A sentinel rather than `undefined`
 * so the dropdown can round-trip it as a plain string alongside real agent emails; the "@" makes
 * it impossible to collide with one. */
const UNASSIGNED = "@unassigned";

export const Route = createFileRoute("/dashboard/debtors")({
  head: () => ({ meta: [{ title: "Debtor Profiles · SamvadX" }] }),
  // Deep links from the manager dashboard's Insights Requests card: `insights` pre-sets the
  // Insights filter, `debtor` opens that debtor's profile once the list has loaded.
  validateSearch: (
    search: Record<string, unknown>,
  ): { debtor?: string; insights?: InsightFlag | "none" } => {
    const out: { debtor?: string; insights?: InsightFlag | "none" } = {};
    if (typeof search.debtor === "string" && search.debtor) out.debtor = search.debtor;
    if (
      search.insights === "requested" ||
      search.insights === "traced" ||
      search.insights === "none"
    )
      out.insights = search.insights;
    return out;
  },
  component: DebtorsPage,
});

// ─── Constants ────────────────────────────────────────────────────────────────

const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

/** Counts the dropdowns show, over the whole book. */
const FACET_DIMS: FacetDim[] = ["portfolio_id", "assigned_agent_id", "insight"];

type SortKey =
  "dpd_asc" | "dpd_desc" | "outstanding_desc" | "outstanding_asc" | "score_desc" | "name_asc";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "dpd_desc", label: "DPD — High first" },
  { key: "dpd_asc", label: "DPD — Low first" },
  { key: "outstanding_desc", label: "Outstanding — High first" },
  { key: "outstanding_asc", label: "Outstanding — Low first" },
  { key: "score_desc", label: "AI Score — Best first" },
  { key: "name_asc", label: "Name — A to Z" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

function DebtorsPage() {
  const { user } = useAuth();
  const agentId = user?.email ?? user?.id ?? "";
  // Managers and admins have no debtors assigned to them personally, so the assigned-slices
  // path below would hand them an empty book. They get the whole open portfolio instead —
  // for a manager, scoped to the team they are currently working (the same scope Portfolio
  // Overview uses); for an admin, everything RLS already lets them see.
  const isSupervisor = user?.role === "manager" || user?.role === "admin";
  const { activeTeam } = useActiveTeam(agentId);
  const activeTeamId = activeTeam?.id;

  // Only supervisors see (and so only they fetch) the roster — it exists purely to put a name
  // and agent code against the emails stored on each debtor.
  const roster = useRoster(isSupervisor);
  const agentLabel = useCallback(
    (email: string) => {
      const a = roster.find((r) => r.id === email);
      if (!a) return email; // roster still loading, or the agent has since been removed
      return a.agentCode ? `${a.name} · ${a.agentCode}` : a.name;
    },
    [roster],
  );

  const [search, setSearch] = useState("");
  // Filters on LAST CONTACTED, the only date a debtor row carries — i.e. "who did I last
  // speak to in this window", and with an open `to`, "who has gone cold since".
  const [contactedRange, setContactedRange] = useState<DateRange>(EMPTY_RANGE);
  const [bucket, setBucket] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [portfolio, setPortfolio] = useState<string>("all");
  const [portfolioDropOpen, setPortfolioDropOpen] = useState(false);
  // Supervisors only — an agent's book is by definition all their own, so the control is not
  // rendered for them. "all" = no filter, UNASSIGNED = accounts nobody is working yet,
  // anything else = that agent's account email.
  const [assignee, setAssignee] = useState<string>("all");
  const [assigneeDropOpen, setAssigneeDropOpen] = useState(false);
  const linkSearch = Route.useSearch();
  const [insightFilter, setInsightFilter] = useState<InsightFilter>(linkSearch.insights ?? "all");
  const [insightDropOpen, setInsightDropOpen] = useState(false);
  const [sort, setSort] = useState<SortKey>("dpd_desc");
  const [sortOpen, setSortOpen] = useState(false);
  const [selected, setSelected] = useState<Debtor | null>(null);
  // Bumped whenever the Insights flags change so the cards re-read getInsightFlag() (a module
  // cache, so nothing else would re-run them).
  const [, setFlagsVersion] = useState(0);
  useEffect(() => {
    const onFlags = () => setFlagsVersion((n) => n + 1);
    window.addEventListener(INSIGHT_FLAGS_UPDATED, onFlags);
    refreshInsightFlags();
    return () => window.removeEventListener(INSIGHT_FLAGS_UPDATED, onFlags);
  }, []);

  // Portfolio metadata (the small portfolios table, no debtor rows): names for the Portfolio
  // dropdown, and which portfolios make up a supervisor's book.
  const [portfolioMeta, setPortfolioMeta] = useState(() => getVisiblePortfolioMeta());
  const [metaLoaded, setMetaLoaded] = useState(false);
  useEffect(() => {
    const load = () => {
      setPortfolioMeta(getVisiblePortfolioMeta());
      setMetaLoaded(true);
    };
    const refetch = () => void refreshVisiblePortfolioMeta();
    window.addEventListener("visible-portfolio-meta-updated", load);
    // A portfolio created/closed/moved to another team changes whose book is whose.
    window.addEventListener("portfolios-updated", refetch);
    refetch();
    return () => {
      window.removeEventListener("visible-portfolio-meta-updated", load);
      window.removeEventListener("portfolios-updated", refetch);
    };
  }, []);

  // WHICH debtors this screen is about. The database pages, filters, sorts and counts them
  // (debtor-page-store.ts) — this page never holds more than the 100 on screen. It used to
  // download the whole book first: an agent's ~5,000 rows, a manager's team, and for an admin
  // every debtor in the company (29,800 for the largest one on 2026-10-13).
  //
  // - agent: their own accounts, open portfolios only (closed / past end date drop out, as on
  //   Call Queue).
  // - manager: every account in their active team's open portfolios — including ones nobody
  //   has picked up yet. Same rule as visibleToTeam() in manager.portfolio.tsx; keep in sync.
  // - admin: every portfolio that isn't closed (a closed portfolio's rows were never listed).
  const scope = useMemo<DebtorQuery | null>(() => {
    if (!user) return null;
    if (!isSupervisor) return { agents: [agentId], openOnly: true };
    if (!metaLoaded) return null;
    if (user.role === "admin")
      return { portfolioIds: portfolioMeta.filter((p) => !p.closedAt).map((p) => p.id) };
    return {
      portfolioIds: portfolioMeta
        .filter(
          (p) =>
            !isPortfolioEnded(p) &&
            (p.teamId === activeTeamId || (!p.teamId && !!agentId && p.managerId === agentId)),
        )
        .map((p) => p.id),
    };
  }, [user, isSupervisor, agentId, metaLoaded, portfolioMeta, activeTeamId]);

  // Typing shouldn't send a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = useMemo<DebtorQuery | null>(() => {
    if (!scope) return null;
    const from = contactedRange.from;
    const to = contactedRange.to;
    return {
      ...scope,
      search: debouncedSearch.trim() || undefined,
      // Both ends set but backwards is a typo mid-entry — swap, as date-filter.ts does.
      contactedFrom: (from && to && from > to ? to : from) || undefined,
      contactedTo: (from && to && from > to ? from : to) || undefined,
      bucket: bucket === "all" ? undefined : bucket,
      portfolioId: portfolio === "all" ? undefined : portfolio,
      assignee: assignee === "all" ? undefined : assignee === UNASSIGNED ? "unassigned" : assignee,
      insight: insightFilter === "all" ? undefined : insightFilter,
      sort,
    };
  }, [scope, debouncedSearch, contactedRange, bucket, portfolio, assignee, insightFilter, sort]);

  const [page, setPage] = useServerPage(
    JSON.stringify([
      debouncedSearch,
      contactedRange,
      bucket,
      portfolio,
      assignee,
      insightFilter,
      sort,
      scope,
    ]),
  );
  const list = useDebtorList(query, page, FACET_DIMS);
  const debtorsPaged = serverPaged<Debtor>(list.rows, page, setPage, list.total);
  // The list shrank under us (a reassignment, a filter elsewhere): back to the last page.
  useEffect(() => {
    if (list.total !== undefined && page > 0 && page >= debtorsPaged.pageCount)
      setPage(debtorsPaged.pageCount - 1);
  }, [list.total, page, debtorsPaged.pageCount, setPage]);
  const gridRef = useRef<HTMLDivElement>(null);

  // Whole-book counts for the dropdowns, from the database's facet counts.
  const bookTotal = sumFacets(list.facets).n;
  const portfolioCounts = useMemo(() => countBy(list.facets, "portfolio_id"), [list.facets]);
  const portfolioName = useCallback(
    (id: string) => portfolioMeta.find((p) => p.id === id)?.name ?? "Portfolio",
    [portfolioMeta],
  );
  const portfolioOptions = useMemo(
    () =>
      Array.from(portfolioCounts, ([id, count]) => ({ id, count, name: portfolioName(id) })).sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    [portfolioCounts, portfolioName],
  );

  // ?debtor=<id>: open that profile. Fetched by id (within this screen's scope) rather than
  // looked for in a loaded book, since only one page is ever loaded. Once per link, so closing
  // the sheet doesn't immediately reopen it.
  const openedFromLink = useRef<string | null>(null);
  useEffect(() => {
    const id = linkSearch.debtor;
    if (!id || !scope || openedFromLink.current === id) return;
    openedFromLink.current = id;
    fetchDebtorRows({ ...scope, ids: [id] }, 0, 1)
      .then(([d]) => d && setSelected(d))
      .catch(() => {});
  }, [linkSearch.debtor, scope]);

  // Owners of the book, each with a headcount — from the debtors themselves rather than the
  // whole roster, so the list never offers an agent who has nothing in this book and comes back
  // empty. Unassigned accounts get their own entry (the gap a manager most wants to find),
  // listed last.
  const assigneeOptions = useMemo(() => {
    const counts = countBy(list.facets, "assigned_agent_id");
    const named = Array.from(counts.entries())
      .filter(([id]) => id !== "")
      .map(([id, count]) => ({ id, label: agentLabel(id), count }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const unassigned = counts.get("");
    return unassigned
      ? [...named, { id: UNASSIGNED, label: "Unassigned", count: unassigned }]
      : named;
  }, [list.facets, agentLabel]);

  // A manager switching teams (or a reassignment landing) can retire the agent or portfolio
  // being filtered on. Left alone that reads as "zero accounts"; drop back to All instead.
  useEffect(() => {
    if (!list.facets) return;
    if (assignee !== "all" && !assigneeOptions.some((o) => o.id === assignee)) setAssignee("all");
    if (portfolio !== "all" && !portfolioCounts.has(portfolio)) setPortfolio("all");
  }, [assignee, assigneeOptions, portfolio, portfolioCounts, list.facets]);

  // Per-option counts for the Insights dropdown, over the whole book.
  const insightCounts = useMemo(() => {
    const c = countBy(list.facets, "insight");
    return {
      requested: c.get("requested") ?? 0,
      traced: c.get("traced") ?? 0,
      none: c.get("none") ?? 0,
    } as Record<Exclude<InsightFilter, "all">, number>;
  }, [list.facets]);

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (!query) return;
    setExporting(true);
    try {
      // The whole filtered list, fetched only now — never held for rendering.
      const all = await fetchAllDebtorRows(query);
      const sanitize = (v: string | number | null | undefined) => {
        const s = String(v ?? "");
        const safe = /^[=+\-@]/.test(s) ? `\t${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const headers = [
        "Name",
        "Loan ID",
        "Phone",
        "Loan Amount",
        "DPD",
        "AI Score",
        "Portfolio",
        "Language",
        "Last Contacted",
        // Only a supervisor's export spans more than one agent, so only theirs needs to say
        // who each account belongs to.
        ...(isSupervisor ? ["Assigned To"] : []),
      ];
      const rows = all.map((d) => [
        d.name,
        displayId(d),
        d.phone,
        d.loanAmount,
        d.dpd,
        d.aiScore,
        d.portfolio,
        d.language,
        d.lastContacted,
        ...(isSupervisor ? [d.assignedAgentId ? agentLabel(d.assignedAgentId) : "Unassigned"] : []),
      ]);
      const csv = "\uFEFF" + [headers, ...rows].map((r) => r.map(sanitize).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "debtors.csv";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const currentSortLabel = SORT_OPTIONS.find((s) => s.key === sort)?.label ?? "";

  return (
    <>
      <div className="space-y-4">
        <div className="animate-in fade-in slide-in-from-top-4 duration-500">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Debtor Profiles</h1>
          <p className="text-sm text-muted-foreground">
            Click any debtor to view full loan details, call history, and payment records.
          </p>
        </div>

        {/* ── Search + filters ── */}
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeFilter value={contactedRange} onChange={setContactedRange} />
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search name or loan ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Bucket dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setBucketDropOpen((o) => !o);
                setPortfolioDropOpen(false);
                setSortOpen(false);
                setAssigneeDropOpen(false);
                setInsightDropOpen(false);
              }}
              className={cn(
                "flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-xs transition-all",
                bucket !== "all"
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              {bucket === "all" ? "Bucket" : BUCKET_META[bucket].label}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {bucketDropOpen && (
              <div className="absolute left-0 top-full mt-1 z-30 w-44 rounded-lg border border-border bg-card shadow-lg py-1">
                <button
                  type="button"
                  onClick={() => {
                    setBucket("all");
                    setBucketDropOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                    bucket === "all" ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span>All Buckets</span>
                  <span className="opacity-50">{bookTotal}</span>
                </button>
                {BUCKET_ORDER.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => {
                      setBucket(b);
                      setBucketDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                      bucket === b ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span>{BUCKET_META[b].label}</span>
                    <span className="opacity-50 text-[10px]">
                      {BUCKET_META[b].description.split("—")[0].trim()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Portfolio dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setPortfolioDropOpen((o) => !o);
                setBucketDropOpen(false);
                setSortOpen(false);
                setAssigneeDropOpen(false);
                setInsightDropOpen(false);
              }}
              className={cn(
                "flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-xs transition-all",
                portfolio !== "all"
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              {portfolio === "all" ? "Portfolio" : portfolioName(portfolio)}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {portfolioDropOpen && (
              <div className="absolute left-0 top-full mt-1 z-30 w-52 rounded-lg border border-border bg-card shadow-lg py-1">
                <button
                  type="button"
                  onClick={() => {
                    setPortfolio("all");
                    setPortfolioDropOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                    portfolio === "all" ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span>All Portfolios</span>
                  <span className="opacity-50">{bookTotal}</span>
                </button>
                {portfolioOptions.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setPortfolio(p.id);
                      setPortfolioDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                      portfolio === p.id ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span>{p.name}</span>
                    <span className="opacity-50">{p.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Assigned-to dropdown — supervisors only; an agent's book is all their own. */}
          {isSupervisor && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setAssigneeDropOpen((o) => !o);
                  setBucketDropOpen(false);
                  setPortfolioDropOpen(false);
                  setSortOpen(false);
                  setInsightDropOpen(false);
                }}
                className={cn(
                  "flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-xs transition-all",
                  assignee !== "all"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                <UserRound className="h-3 w-3 opacity-70" />
                {assignee === "all"
                  ? "Assigned to"
                  : assignee === UNASSIGNED
                    ? "Unassigned"
                    : agentLabel(assignee)}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
              {assigneeDropOpen && (
                <div className="absolute left-0 top-full mt-1 z-30 w-60 max-h-72 overflow-y-auto rounded-lg border border-border bg-card shadow-lg py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setAssignee("all");
                      setAssigneeDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between gap-2",
                      assignee === "all" ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span>All Agents</span>
                    <span className="opacity-50">{bookTotal}</span>
                  </button>
                  {assigneeOptions.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => {
                        setAssignee(o.id);
                        setAssigneeDropOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between gap-2",
                        assignee === o.id ? "font-medium text-foreground" : "text-muted-foreground",
                        o.id === UNASSIGNED && "italic",
                      )}
                    >
                      <span className="truncate">{o.label}</span>
                      <span className="opacity-50 flex-shrink-0">{o.count}</span>
                    </button>
                  ))}
                  {assigneeOptions.length === 0 && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      No accounts in this book yet.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Insights dropdown — requested / already run / never looked up. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setInsightDropOpen((o) => !o);
                setBucketDropOpen(false);
                setPortfolioDropOpen(false);
                setAssigneeDropOpen(false);
                setSortOpen(false);
              }}
              className={cn(
                "flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-xs transition-all",
                insightFilter !== "all"
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              {insightFilter === "all"
                ? "Insights"
                : INSIGHT_FILTER_OPTIONS.find((o) => o.key === insightFilter)?.label}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {insightDropOpen && (
              <div className="absolute left-0 top-full mt-1 z-30 w-52 rounded-lg border border-border bg-card shadow-lg py-1">
                <button
                  type="button"
                  onClick={() => {
                    setInsightFilter("all");
                    setInsightDropOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                    insightFilter === "all"
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <span>All</span>
                  <span className="opacity-50">{bookTotal}</span>
                </button>
                {INSIGHT_FILTER_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => {
                      setInsightFilter(o.key);
                      setInsightDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between gap-2",
                      insightFilter === o.key
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "h-2 w-2 rounded-full",
                          o.key === "none"
                            ? "border border-border bg-card"
                            : INSIGHT_FLAG_META[o.key].dot,
                        )}
                      />
                      {o.label}
                    </span>
                    <span className="opacity-50">{insightCounts[o.key]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sort dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setSortOpen((o) => !o);
                setBucketDropOpen(false);
                setPortfolioDropOpen(false);
                setAssigneeDropOpen(false);
                setInsightDropOpen(false);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 h-8 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-all"
            >
              <span>{currentSortLabel}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {sortOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-border bg-card shadow-lg py-1">
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => {
                      setSort(o.key);
                      setSortOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 text-xs transition-colors hover:bg-muted/50",
                      sort === o.key
                        ? "text-foreground font-medium bg-muted/30"
                        : "text-muted-foreground",
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden md:flex items-center gap-3 mr-1">
              {(Object.keys(INSIGHT_FLAG_META) as InsightFlag[]).map((f) => (
                <span key={f} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-full", INSIGHT_FLAG_META[f].dot)} />
                  {INSIGHT_FLAG_META[f].label}
                </span>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {list.total === undefined
                ? "Counting…"
                : `${list.total.toLocaleString("en-IN")} debtor${list.total !== 1 ? "s" : ""}`}
            </span>
            <button
              type="button"
              disabled={exporting || !list.total}
              onClick={() => void exportCsv()}
              className="inline-flex items-center gap-1 h-7 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
            >
              <FileDown className="h-3.5 w-3.5" />
              {exporting ? "Exporting…" : "Export"}
            </button>
          </div>
        </div>

        {/* ── Card grid ── */}
        <div
          ref={gridRef}
          className="grid grid-cols-1 gap-3 scroll-mt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {debtorsPaged.pageItems.map((d, i) => (
            <DebtorCard
              key={d.id}
              d={d}
              index={i}
              flag={getInsightFlag(d.id)}
              onView={() => setSelected(d)}
              assignedTo={
                isSupervisor ? (d.assignedAgentId ? agentLabel(d.assignedAgentId) : "") : undefined
              }
            />
          ))}
          {list.loading && (
            <p className="col-span-full py-16 text-center text-sm text-muted-foreground">
              Loading accounts…
            </p>
          )}
          {list.error && (
            <p className="col-span-full py-16 text-center text-sm text-destructive">
              Couldn't load accounts: {list.error}
            </p>
          )}
          {!list.loading && !list.error && list.rows.length === 0 && (
            <div className="col-span-full py-16 text-center space-y-2">
              {bookTotal === 0 && list.facets !== undefined ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {isSupervisor
                      ? "No accounts in this book yet."
                      : "No accounts assigned to you yet."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <Upload className="inline h-3 w-3 mr-1" />
                    {isSupervisor
                      ? "Upload a portfolio to start assigning accounts."
                      : "Ask your manager to upload a portfolio and assign you accounts."}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No debtors match the selected filters.
                </p>
              )}
            </div>
          )}
        </div>
        <ListPager paged={debtorsPaged} scrollTo={gridRef} noun="accounts" />
      </div>

      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full max-w-2xl p-0 overflow-hidden flex flex-col sm:max-w-2xl"
        >
          {selected && <DebtorProfile d={selected} onClose={() => setSelected(null)} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

// ─── Debtor card ──────────────────────────────────────────────────────────────

function DebtorCard({
  d,
  index,
  flag,
  onView,
  assignedTo,
}: {
  d: Debtor;
  index: number;
  flag: InsightFlag | null;
  onView: () => void;
  /** Resolved owner name, shown to supervisors so a filtered list says whose it is. Undefined
   * for agents, whose whole book is their own and would just repeat their name on every card. */
  assignedTo?: string;
}) {
  const b = bucketOf(d.dpd);
  const bucketMeta = BUCKET_META[b];
  const flagMeta = flag ? INSIGHT_FLAG_META[flag] : null;

  return (
    <Card
      className={cn(
        "animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both cursor-pointer hover:shadow-md transition-shadow duration-200",
        flagMeta?.card,
      )}
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
      onClick={onView}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-sm font-semibold text-muted-foreground flex-shrink-0">
              {d.name
                .split(" ")
                .map((n) => n[0])
                .slice(0, 2)
                .join("")}
            </div>
            <div>
              <div className="font-medium text-sm text-foreground leading-tight">{d.name}</div>
              <div className="text-[11px] text-muted-foreground">{displayId(d)}</div>
            </div>
          </div>
          <Badge variant="outline" className={cn("text-[10px] flex-shrink-0", bucketMeta.color)}>
            {bucketMeta.label}
          </Badge>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Outstanding</span>
            <span className="font-semibold text-foreground">{formatINR(d.loanAmount)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">DPD</span>
            <span className="text-foreground">{d.dpd}d</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Language</span>
            <span className="text-foreground text-xs">{d.language}</span>
          </div>
        </div>

        {flagMeta && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
            <span className={cn("h-2 w-2 rounded-full", flagMeta.dot)} />
            {flagMeta.label}
          </div>
        )}

        <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground truncate">{d.portfolio}</span>
          <span className="text-[11px] text-muted-foreground flex-shrink-0">
            Score {d.aiScore}/10
          </span>
        </div>

        {assignedTo !== undefined && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
            <UserRound className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            {d.assignedAgentId ? (
              <span className="text-muted-foreground truncate">{assignedTo}</span>
            ) : (
              <span className="text-muted-foreground italic">Unassigned</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
