import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useEffect, useCallback } from "react";
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
import {
  getPortfolios,
  getAgentDebtorIds,
  refreshPortfolios,
  debtorFromRow,
} from "@/lib/portfolio-store";
import { useAuth } from "@/lib/auth";
import { AssignedAgentLine } from "@/components/assigned-agent";
import { DebtorProfile } from "@/components/debtor-profile";

/** Filter value standing for "nobody owns this account". A sentinel rather than `undefined`
 * so the dropdown can round-trip it as a plain string alongside real agent emails; the "@" makes
 * it impossible to collide with one. */
const UNASSIGNED = "@unassigned";

export const Route = createFileRoute("/dashboard/debtors")({
  head: () => ({ meta: [{ title: "Debtor Profiles · SamvadX" }] }),
  component: DebtorsPage,
});

// ─── Constants ────────────────────────────────────────────────────────────────

const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

// Convert uploaded debtor to the Debtor shape expected by this page — shared with the call
// queue's buildAssignedQueue() via debtorFromRow() so both surfaces show the same info.
const toDebtor = debtorFromRow;

type SortKey =
  | "dpd_asc"
  | "dpd_desc"
  | "outstanding_desc"
  | "outstanding_asc"
  | "score_desc"
  | "name_asc";

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
  const [sort, setSort] = useState<SortKey>("dpd_desc");
  const [sortOpen, setSortOpen] = useState(false);
  const [selected, setSelected] = useState<Debtor | null>(null);
  const [uploadedDebtors, setUploadedDebtors] = useState<Debtor[]>([]);

  // Load only debtors assigned to this agent from uploaded portfolios
  useEffect(() => {
    const load = () => {
      const assignedSlices = getAgentDebtorIds(agentId);
      const portfolios = getPortfolios();

      if (isSupervisor) {
        // Closed cycles already carry rows: [] (see refreshPortfolios), so they contribute
        // nothing here and no extra closedAt filter is needed.
        // Falls back to managerId when a portfolio has no team_id — same fallback and same
        // reasoning as visibleToTeam() in manager.portfolio.tsx, which this filter mirrors;
        // keep the two in sync.
        const visible =
          user?.role === "admin"
            ? portfolios
            : portfolios.filter(
                (p) =>
                  p.teamId === activeTeamId || (!p.teamId && !!agentId && p.managerId === agentId),
              );
        const result: Debtor[] = [];
        for (const p of visible) for (const r of p.rows) result.push(toDebtor(r, p));
        setUploadedDebtors(result);
      } else if (assignedSlices.length > 0) {
        // Agent has explicit assignments — show only those debtors
        const result: Debtor[] = [];
        for (const { portfolioId, debtorIds } of assignedSlices) {
          const p = portfolios.find((p) => p.id === portfolioId);
          if (!p) continue;
          const idSet = new Set(debtorIds);
          p.rows.filter((r) => idSet.has(r.id)).forEach((r) => result.push(toDebtor(r, p)));
        }
        setUploadedDebtors(result);
      } else {
        // No assignments yet — this agent has an empty book
        setUploadedDebtors([]);
      }
    };
    load();
    window.addEventListener("portfolios-updated", load);
    refreshPortfolios();
    return () => {
      window.removeEventListener("portfolios-updated", load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, isSupervisor, activeTeamId, user?.role]);

  // Only the debtors assigned to this agent from uploaded portfolios — no mock data
  const allDebtors = uploadedDebtors;
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
      if (q && !d.name.toLowerCase().includes(q) && !displayId(d).toLowerCase().includes(q))
        return false;
      return true;
    });
    return sortDebtors(list, sort);
  }, [search, contactedRange, bucket, portfolio, assignee, sort, allDebtors]);

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

          {/* Sort dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setSortOpen((o) => !o);
                setBucketDropOpen(false);
                setPortfolioDropOpen(false);
                setAssigneeDropOpen(false);
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((d, i) => (
            <DebtorCard
              key={d.id}
              d={d}
              index={i}
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
  onView,
  assignedTo,
}: {
  d: Debtor;
  index: number;
  onView: () => void;
  /** Resolved owner name, shown to supervisors so a filtered list says whose it is. Undefined
   * for agents, whose whole book is their own and would just repeat their name on every card. */
  assignedTo?: string;
}) {
  const b = bucketOf(d.dpd);
  const bucketMeta = BUCKET_META[b];

  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both cursor-pointer hover:shadow-md transition-shadow duration-200"
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
