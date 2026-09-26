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
import { EMPTY_RANGE, inDayRange, type DateRange } from "@/lib/date-filter";
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
import { getPortfolios, refreshPortfolios, debtorFromRow } from "@/lib/portfolio-store";
import {
  getScopedPortfolios,
  refreshScopedPortfolios,
  getVisiblePortfolioMeta,
  refreshVisiblePortfolioMeta,
  isPortfolioEnded,
  type DebtorScope,
} from "@/lib/scoped-debtors";
import { useAuth } from "@/lib/auth";
import { AssignedAgentLine } from "@/components/assigned-agent";
import { DebtorProfile } from "@/components/debtor-profile";
import { ListPager, usePaged } from "@/components/list-pager";
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

// Convert uploaded debtor to the Debtor shape expected by this page — shared with the call
// queue's buildAssignedQueue() via debtorFromRow() so both surfaces show the same info.
const toDebtor = debtorFromRow;

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

function sortDebtors(list: Debtor[], key: SortKey): Debtor[] {
  return [...list].sort((a, b) => {
    if (key === "dpd_desc") return b.dpd - a.dpd;
    if (key === "dpd_asc") return a.dpd - b.dpd;
    if (key === "outstanding_desc") return b.loanAmount - a.loanAmount;
    if (key === "outstanding_asc") return a.loanAmount - b.loanAmount;
    if (key === "score_desc") return b.aiScore - a.aiScore;
    return a.name.localeCompare(b.name);
  });
}

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
  const [uploadedDebtors, setUploadedDebtors] = useState<Debtor[]>([]);
  // Bumped whenever the Insights flags change so the cards and the Insights filter re-read
  // getInsightFlag() (a module cache, so nothing else would re-run them).
  const [flagsVersion, setFlagsVersion] = useState(0);
  useEffect(() => {
    const onFlags = () => setFlagsVersion((n) => n + 1);
    window.addEventListener(INSIGHT_FLAGS_UPDATED, onFlags);
    refreshInsightFlags();
    return () => window.removeEventListener(INSIGHT_FLAGS_UPDATED, onFlags);
  }, []);

  // Load only the debtors this screen actually needs, not every debtor the signed-in user can
  // see. The old version called refreshPortfolios(), which — measured directly against
  // production, 2026-09-22 — took 1.3s in the database alone for one manager's visible set,
  // because RLS can only narrow the search to "this client's debtors" before checking
  // assignment row by row; there's no index for "this agent's rows" or "this team's rows"
  // alone. See scoped-debtors.ts for the full write-up.
  //
  // Admins are the one exception: they're org-wide by design, and scoping "everything RLS
  // lets an admin see" doesn't shrink anything, so that path keeps using the full
  // portfolio-store.ts cache unchanged.
  useEffect(() => {
    let cancelled = false;

    if (isSupervisor && user?.role === "admin") {
      const load = () => {
        const portfolios = getPortfolios();
        const result: Debtor[] = [];
        for (const p of portfolios) for (const r of p.rows) result.push(toDebtor(r, p));
        setUploadedDebtors(result);
      };
      load();
      window.addEventListener("portfolios-updated", load);
      refreshPortfolios();
      return () => window.removeEventListener("portfolios-updated", load);
    }

    if (isSupervisor) {
      // A manager's book is by PORTFOLIO (their active team's, or theirs directly), which can
      // include accounts nobody has picked up yet — not just accounts already assigned to one
      // of their agents. Resolve which portfolios that is first (a small, cheap query — the
      // portfolios table, not the debtors table), THEN fetch only those portfolios' debtors.
      let scope: DebtorScope | null = null;
      const render = () => {
        if (cancelled || !scope) return;
        const result: Debtor[] = [];
        for (const p of getScopedPortfolios(scope))
          for (const r of p.rows) result.push(toDebtor(r, p));
        setUploadedDebtors(result);
      };
      const resolveAndLoad = async () => {
        await refreshVisiblePortfolioMeta();
        if (cancelled) return;
        // Same fallback and reasoning as visibleToTeam() in manager.portfolio.tsx, which this
        // mirrors — keep the two in sync. isPortfolioEnded excludes a closed or past-end-date
        // cycle, which the old rows:[] trick handled implicitly; there is no such fallback
        // here since a closed portfolio's debtors are never fetched at all now.
        const visible = getVisiblePortfolioMeta().filter(
          (p) =>
            !isPortfolioEnded(p) &&
            (p.teamId === activeTeamId || (!p.teamId && !!agentId && p.managerId === agentId)),
        );
        scope = { kind: "portfolios", portfolioIds: visible.map((p) => p.id) };
        render();
        await refreshScopedPortfolios(scope);
        render();
      };
      void resolveAndLoad();
      // portfolios-updated covers a portfolio being created/closed/reassigned to a different
      // team — anything that could change WHICH portfolios are visible, so the whole
      // resolution re-runs; scoped-portfolios-updated covers a debtor row changing within an
      // already-resolved scope.
      window.addEventListener("portfolios-updated", resolveAndLoad);
      window.addEventListener("scoped-portfolios-updated", render);
      return () => {
        cancelled = true;
        window.removeEventListener("portfolios-updated", resolveAndLoad);
        window.removeEventListener("scoped-portfolios-updated", render);
      };
    }

    // A plain agent — their own book only, scoped by assigned_agent_id. Same scope shape Call
    // Queue uses, so the two pages share one fetch when both are open for the same agent.
    const scope: DebtorScope = { kind: "agents", agentIds: [agentId] };
    const render = () => {
      if (cancelled) return;
      const result: Debtor[] = [];
      for (const p of getScopedPortfolios(scope))
        for (const r of p.rows) result.push(toDebtor(r, p));
      setUploadedDebtors(result);
    };
    render();
    void refreshScopedPortfolios(scope).then(render);
    window.addEventListener("scoped-portfolios-updated", render);
    return () => {
      cancelled = true;
      window.removeEventListener("scoped-portfolios-updated", render);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, isSupervisor, activeTeamId, user?.role]);

  // Only the debtors assigned to this agent from uploaded portfolios — no mock data
  const allDebtors = uploadedDebtors;

  // ?debtor=<id>: open that profile once it shows up in the loaded book. Only once per link, so
  // closing the sheet doesn't immediately reopen it.
  const openedFromLink = useRef<string | null>(null);
  useEffect(() => {
    const id = linkSearch.debtor;
    if (!id || openedFromLink.current === id) return;
    const d = allDebtors.find((x) => x.id === id);
    if (d) {
      openedFromLink.current = id;
      setSelected(d);
    }
  }, [linkSearch.debtor, allDebtors]);
  const allPortfolioNames = useMemo(
    () => Array.from(new Set(allDebtors.map((d) => d.portfolio))).sort(),
    [allDebtors],
  );

  // Owners of the book actually on screen, each with a headcount — built from the debtors
  // themselves rather than the whole roster, so the list never offers an agent who has nothing
  // in this book and comes back empty. Unassigned accounts get their own entry (the gap a
  // manager most wants to find), listed last.
  const assigneeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of allDebtors) {
      const key = d.assignedAgentId ?? UNASSIGNED;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const named = Array.from(counts.entries())
      .filter(([id]) => id !== UNASSIGNED)
      .map(([id, count]) => ({ id, label: agentLabel(id), count }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const unassigned = counts.get(UNASSIGNED);
    return unassigned
      ? [...named, { id: UNASSIGNED, label: "Unassigned", count: unassigned }]
      : named;
  }, [allDebtors, agentLabel]);

  // A manager switching teams (or a reassignment landing) can retire the agent being filtered
  // on. Left alone that reads as "this agent has zero accounts"; drop back to All instead.
  useEffect(() => {
    if (assignee !== "all" && !assigneeOptions.some((o) => o.id === assignee)) setAssignee("all");
  }, [assignee, assigneeOptions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = allDebtors.filter((d) => {
      if (!inDayRange(d.lastContacted, contactedRange)) return false;
      if (bucket !== "all" && bucketOf(d.dpd) !== bucket) return false;
      if (portfolio !== "all" && d.portfolio !== portfolio) return false;
      if (assignee !== "all" && (d.assignedAgentId ?? UNASSIGNED) !== assignee) return false;
      if (insightFilter !== "all" && (getInsightFlag(d.id) ?? "none") !== insightFilter)
        return false;
      if (q && !d.name.toLowerCase().includes(q) && !displayId(d).toLowerCase().includes(q))
        return false;
      return true;
    });
    return sortDebtors(list, sort);
  }, [
    search,
    contactedRange,
    bucket,
    portfolio,
    assignee,
    insightFilter,
    sort,
    allDebtors,
    flagsVersion,
  ]);

  // Per-option counts for the Insights dropdown, over the whole book.
  const insightCounts = useMemo(() => {
    const counts: Record<Exclude<InsightFilter, "all">, number> = {
      requested: 0,
      traced: 0,
      none: 0,
    };
    for (const d of allDebtors) counts[getInsightFlag(d.id) ?? "none"]++;
    return counts;
  }, [allDebtors, flagsVersion]);

  // Paged rendering (list-pager.tsx) — a book of ~3,000 accounts used to render ~3,000 cards.
  // Counts and Export above still use the whole `filtered` list.
  const debtorsPaged = usePaged(
    filtered,
    JSON.stringify([search, contactedRange, bucket, portfolio, assignee, insightFilter, sort]),
  );
  const gridRef = useRef<HTMLDivElement>(null);

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
                  <span className="opacity-50">{allDebtors.length}</span>
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
              {portfolio === "all" ? "Portfolio" : portfolio}
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
                  <span className="opacity-50">{allDebtors.length}</span>
                </button>
                {allPortfolioNames.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setPortfolio(p);
                      setPortfolioDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                      portfolio === p ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span>{p}</span>
                    <span className="opacity-50">
                      {allDebtors.filter((d) => d.portfolio === p).length}
                    </span>
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
                    <span className="opacity-50">{allDebtors.length}</span>
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
                  <span className="opacity-50">{allDebtors.length}</span>
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
              {filtered.length} debtor{filtered.length !== 1 ? "s" : ""}
            </span>
            <button
              type="button"
              onClick={() => {
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
                  // Only a supervisor's export spans more than one agent, so only theirs needs
                  // to say who each account belongs to.
                  ...(isSupervisor ? ["Assigned To"] : []),
                ];
                const rows = filtered.map((d) => [
                  d.name,
                  displayId(d),
                  d.phone,
                  d.loanAmount,
                  d.dpd,
                  d.aiScore,
                  d.portfolio,
                  d.language,
                  d.lastContacted,
                  ...(isSupervisor
                    ? [d.assignedAgentId ? agentLabel(d.assignedAgentId) : "Unassigned"]
                    : []),
                ]);
                const csv =
                  "﻿" + [headers, ...rows].map((r) => r.map(sanitize).join(",")).join("\n");
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "debtors.csv";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-1 h-7 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
            >
              <FileDown className="h-3.5 w-3.5" />
              Export
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
          {filtered.length === 0 && (
            <div className="col-span-full py-16 text-center space-y-2">
              {allDebtors.length === 0 ? (
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
