import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useEffect } from "react";
import {
  Phone,
  MessageCircle,
  HandCoins,
  Search,
  X,
  Clock,
  CheckCheck,
  Check,
  ChevronRight,
  Banknote,
  ChevronDown,
  FileDown,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { bucketOf, formatINR, type Debtor, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";
import { useActiveTeam } from "@/lib/active-team-store";
import {
  getPortfolios,
  getAgentDebtorIds,
  refreshPortfolios,
  debtorFromRow,
} from "@/lib/portfolio-store";
import { useAuth } from "@/lib/auth";
import { TracePanel } from "@/components/profilex/trace-panel";
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";

const CALL_OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  promised: "PTP",
  refused: "Refused",
  no_answer: "No Answer",
  voicemail: "Voicemail",
  dispute: "Dispute",
  callback: "Callback",
  settlement: "Settlement",
};

function formatCallDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export const Route = createFileRoute("/dashboard/debtors")({
  head: () => ({ meta: [{ title: "Debtor Profiles · SamvadX" }] }),
  component: DebtorsPage,
});

// ─── Extra data keyed by loan ID (from uploaded Excel + call history) ─────────

const EXTRA: Record<
  string,
  {
    lender: string;
    product: string;
    originalAmount: number;
    emi: number;
    tenure: number;
    disbursedOn: string;
    accountNumber: string;
    branch: string;
    pos: string;
    emiSchedule: { month: string; amount: number; status: "paid" | "missed" | "upcoming" }[];
    callHistory: {
      date: string;
      duration: string;
      outcome: string;
      note: string;
      type: "agent" | "ai";
    }[];
    payments: { date: string; amount: number; method: string; ref: string }[];
    disputes: {
      id: string;
      type: string;
      status: "open" | "resolved" | "escalated";
      raised: string;
    }[];
    messages: {
      dir: "out" | "in";
      text: string;
      time: string;
      channel: "whatsapp" | "sms" | "ivr";
    }[];
  }
> = {
  "L-10042": {
    lender: "HDFC Bank",
    product: "Personal Loan",
    originalAmount: 300000,
    emi: 8200,
    tenure: 36,
    disbursedOn: "Apr 2023",
    accountNumber: "HDFC-PL-10042",
    branch: "Andheri West",
    pos: "HDFC Branch, Andheri",
    emiSchedule: [
      { month: "Apr 2026", amount: 8200, status: "paid" },
      { month: "May 2026", amount: 8200, status: "paid" },
      { month: "Jun 2026", amount: 8200, status: "missed" },
      { month: "Jul 2026", amount: 8200, status: "upcoming" },
    ],
    callHistory: [
      {
        date: "22 Jun, 10:14 AM",
        duration: "4m 22s",
        outcome: "PTP",
        note: "Will pay by 25th June via UPI",
        type: "agent",
      },
      {
        date: "20 Jun, 11:45 AM",
        duration: "2m 05s",
        outcome: "Callback",
        note: "Asked to call back after 6 PM",
        type: "agent",
      },
      {
        date: "18 Jun, 03:30 PM",
        duration: "0m 45s",
        outcome: "No answer",
        note: "",
        type: "agent",
      },
    ],
    payments: [{ date: "15 May 2026", amount: 8200, method: "UPI", ref: "UPI202605151234" }],
    disputes: [],
    messages: [
      {
        dir: "out",
        text: "Namaste Rahul ji, aapka EMI ₹8,200 due hai. Kripya aaj payment karein.",
        time: "10:15 AM",
        channel: "whatsapp",
      },
      {
        dir: "in",
        text: "Haan sir, kal tak kar dunga UPI se.",
        time: "10:18 AM",
        channel: "whatsapp",
      },
      {
        dir: "out",
        text: "Payment details SMS bhej diya hai. Please account details se transfer karein.",
        time: "10:19 AM",
        channel: "sms",
      },
    ],
  },
  "L-10018": {
    lender: "Bajaj Finance",
    product: "Credit Card NPA",
    originalAmount: 120000,
    emi: 3800,
    tenure: 24,
    disbursedOn: "Jan 2024",
    accountNumber: "BFL-CC-10018",
    branch: "Surat Dealer",
    pos: "Dealer – Bajaj, Surat",
    emiSchedule: [
      { month: "Apr 2026", amount: 3800, status: "paid" },
      { month: "May 2026", amount: 3800, status: "missed" },
      { month: "Jun 2026", amount: 3800, status: "missed" },
      { month: "Jul 2026", amount: 3800, status: "upcoming" },
    ],
    callHistory: [
      {
        date: "22 Jun, 09:00 AM",
        duration: "6m 10s",
        outcome: "PTP",
        note: "Salary credited, will settle this week",
        type: "agent",
      },
    ],
    payments: [],
    disputes: [
      { id: "D-001", type: "Interest waiver request", status: "open", raised: "10 Jun 2026" },
    ],
    messages: [
      {
        dir: "out",
        text: "Dear customer, 2 EMIs overdue. Please pay immediately to avoid legal notice.",
        time: "9:05 AM",
        channel: "sms",
      },
    ],
  },
};

function getExtra(id: string) {
  return (
    EXTRA[id] ?? {
      lender: "Axis Bank",
      product: "Personal Loan",
      originalAmount: 0,
      emi: 0,
      tenure: 0,
      disbursedOn: "—",
      accountNumber: "—",
      branch: "—",
      pos: "—",
      emiSchedule: [],
      callHistory: [],
      payments: [],
      disputes: [],
      messages: [],
    }
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

// Convert uploaded debtor to the Debtor shape expected by this page — shared with the call
// queue's buildAssignedQueue() via debtorFromRow() so both surfaces show the same info.
const toDebtor = debtorFromRow;

// d.id is a real (opaque) row identifier; _loanReference (when present, for uploaded
// portfolios) is the human-readable loan/account ID from the source CSV — prefer that
// for display/search/export.
function displayId(d: Debtor): string {
  return (d as Debtor & { _loanReference?: string })._loanReference ?? d.id;
}

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

  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [portfolio, setPortfolio] = useState<string>("all");
  const [portfolioDropOpen, setPortfolioDropOpen] = useState(false);
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
        const visible =
          user?.role === "admin" ? portfolios : portfolios.filter((p) => p.teamId === activeTeamId);
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = allDebtors.filter((d) => {
      if (bucket !== "all" && bucketOf(d.dpd) !== bucket) return false;
      if (portfolio !== "all" && d.portfolio !== portfolio) return false;
      if (q && !d.name.toLowerCase().includes(q) && !displayId(d).toLowerCase().includes(q))
        return false;
      return true;
    });
    return sortDebtors(list, sort);
  }, [search, bucket, portfolio, sort, allDebtors]);

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

          {/* Sort dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setSortOpen((o) => !o);
                setBucketDropOpen(false);
                setPortfolioDropOpen(false);
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
            <DebtorCard key={d.id} d={d} index={i} onView={() => setSelected(d)} />
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full py-16 text-center space-y-2">
              {allDebtors.length === 0 ? (
                <>
                  <p className="text-sm text-muted-foreground">No accounts assigned to you yet.</p>
                  <p className="text-xs text-muted-foreground">
                    <Upload className="inline h-3 w-3 mr-1" />
                    Ask your manager to upload a portfolio and assign you accounts.
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

function DebtorCard({ d, index, onView }: { d: Debtor; index: number; onView: () => void }) {
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
      </CardContent>
    </Card>
  );
}

// ─── Debtor profile sheet ─────────────────────────────────────────────────────

/** Exported so the manager's escalation queue can open the same profile an agent sees,
 * rather than growing a second, thinner version of it. */
export function DebtorProfile({ d, onClose }: { d: Debtor; onClose: () => void }) {
  const anyD = d as Debtor & {
    _uploadedExtra?: Record<string, string>;
    _lender?: string;
    _product?: string;
  };
  const isUploaded = !!anyD._uploadedExtra;
  const csvFields = anyD._uploadedExtra ?? {};
  const extra = isUploaded ? null : getExtra(d.id);
  const initials = d.name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Real call_logs for this debtor — same disposition-store used by Activity History.
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  useEffect(() => {
    const load = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", load);
    refreshDispositions()
      .then(load)
      .catch((e) => console.warn("[debtors] disposition refresh failed:", e));
    return () => window.removeEventListener("dispositions-updated", load);
  }, []);

  const debtorCalls = useMemo(
    () => disps.filter((r) => r.debtorId === d.id).sort((a, b) => b.time.localeCompare(a.time)),
    [disps, d.id],
  );
  const debtorPayments = useMemo(
    () => debtorCalls.filter((r) => r.outcome === "paid" && r.paidAmount),
    [debtorCalls],
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <SheetHeader className="px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-full bg-muted flex items-center justify-center text-muted-foreground font-semibold">
            {initials}
          </div>
          <div className="flex-1">
            <SheetTitle className="text-base">{d.name}</SheetTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {displayId(d)} · {d.phone} · {d.language}
            </p>
          </div>
        </div>
      </SheetHeader>

      {/* Key stats band */}
      <div className="flex-shrink-0 px-6 py-3 border-b border-border grid grid-cols-4 gap-4 text-sm bg-muted/20">
        {[
          { label: "Outstanding", value: formatINR(d.loanAmount) },
          { label: "DPD", value: `${d.dpd} days` },
          { label: "AI Score", value: `${d.aiScore}/10` },
          {
            label: "Principal Amount",
            value: isUploaded
              ? csvFields["pos"] || csvFields["Principal"] || "—"
              : extra?.pos || "—",
          },
        ].map(({ label, value }) => (
          <div key={label}>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div className="font-semibold text-foreground mt-0.5 text-sm truncate">{value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="h-full flex flex-col">
          <TabsList className="flex-shrink-0 rounded-none border-b border-border bg-transparent px-6 h-10 justify-start gap-1">
            {["overview", "calls", "insights", "messages", "payments", "disputes"].map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="capitalize text-xs data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-foreground rounded-none pb-2 text-muted-foreground"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto px-6 py-4 space-y-5 mt-0">
            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                {isUploaded
                  ? "CSV Fields · from uploaded portfolio"
                  : "Loan Details · from uploaded file"}
              </p>
              {isUploaded ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  {/* Always show the standard fields first */}
                  {(
                    [
                      ["Lender", anyD._lender || "—"],
                      ["Product", anyD._product || "—"],
                      ["Portfolio", d.portfolio],
                      ["DPD", String(d.dpd)],
                    ] as [string, string][]
                  ).map(([label, val]) => (
                    <div key={label}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="font-medium text-foreground mt-0.5">{val || "—"}</div>
                    </div>
                  ))}
                  {/* Then all raw CSV columns */}
                  {Object.entries(csvFields).map(([col, val]) => (
                    <div key={col}>
                      <div className="text-xs text-muted-foreground capitalize">
                        {col.replace(/_/g, " ")}
                      </div>
                      <div className="font-medium text-foreground mt-0.5 break-all">
                        {val || "—"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  {(
                    [
                      ["Lender", extra!.lender],
                      ["Product", extra!.product],
                      ["Account No.", extra!.accountNumber],
                      ["Disbursed On", extra!.disbursedOn],
                      ["Original Amount", formatINR(extra!.originalAmount)],
                      ["EMI", formatINR(extra!.emi)],
                      ["Tenure", `${extra!.tenure} months`],
                      ["Principal Amount", extra!.pos],
                      ["Portfolio", d.portfolio],
                    ] as [string, string][]
                  ).map(([label, val]) => (
                    <div key={label}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="font-medium text-foreground mt-0.5">{val}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                EMI Schedule
              </p>
              {(extra?.emiSchedule ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No EMI data available.</p>
              ) : (
                <div className="space-y-1.5">
                  {extra!.emiSchedule.map((e, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <span className="text-foreground">{e.month}</span>
                      <span className="font-medium text-foreground">{formatINR(e.amount)}</span>
                      <span
                        className={cn(
                          "text-xs font-medium capitalize",
                          e.status === "paid"
                            ? "text-foreground"
                            : e.status === "missed"
                              ? "text-muted-foreground line-through"
                              : "text-muted-foreground",
                        )}
                      >
                        {e.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                Other Details
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {(
                  [
                    ["Last Contacted", d.lastContacted ?? "—"],
                    ["Language", d.language],
                    ["AI Insight", d.scoreReason],
                  ] as [string, string][]
                ).map(([label, val]) => (
                  <div key={label} className={label === "AI Insight" ? "col-span-2" : ""}>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="font-medium text-foreground mt-0.5">{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* Call history */}
          <TabsContent value="calls" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            {debtorCalls.length === 0 ? (
              <p className="text-sm text-muted-foreground">No call history recorded.</p>
            ) : (
              <div>
                {debtorCalls.map((c, i) => (
                  <div key={c.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="h-2 w-2 rounded-full bg-muted-foreground mt-1.5" />
                      {i < debtorCalls.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                    </div>
                    <div className="pb-4">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-foreground">
                          {CALL_OUTCOME_LABEL[c.outcome] ?? c.outcome}
                        </span>
                        <span className="text-muted-foreground">·</span>
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground text-xs">
                          {formatDuration(c.durationSeconds)}
                        </span>
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          {c.callType === "human" ? "Agent" : (c.callType ?? "Agent").toUpperCase()}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">{formatCallDate(c.time)}</div>
                      {c.notes && (
                        <div className="mt-1 text-xs bg-muted rounded px-2 py-1 text-foreground/80">
                          {c.notes}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Trace — ProfileX skip-tracing. Managers/admins can run a lookup here; agents see
              whatever their manager already paid for, read-only. Role gate lives in TracePanel. */}
          <TabsContent value="insights" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            <TracePanel debtorId={d.id} debtorName={d.name} />
          </TabsContent>

          {/* Messages */}
          <TabsContent value="messages" className="flex-1 overflow-y-auto px-6 py-4 space-y-2 mt-0">
            {(extra?.messages ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages sent.</p>
            ) : (
              extra!.messages.map((m, i) => (
                <div
                  key={i}
                  className={cn("flex", m.dir === "out" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[75%] rounded-2xl px-3 py-2 text-sm",
                      m.dir === "out"
                        ? "bg-foreground text-background rounded-br-sm"
                        : "bg-muted border border-border text-foreground rounded-bl-sm",
                    )}
                  >
                    <p>{m.text}</p>
                    <div
                      className={cn(
                        "flex items-center gap-1 mt-1 text-[10px]",
                        m.dir === "out" ? "justify-end opacity-60" : "text-muted-foreground",
                      )}
                    >
                      {m.time} · {m.channel}
                      {m.dir === "out" && <CheckCheck className="h-3 w-3" />}
                      {m.dir === "in" && <Check className="h-3 w-3" />}
                    </div>
                  </div>
                </div>
              ))
            )}
          </TabsContent>

          {/* Payments */}
          <TabsContent value="payments" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            {debtorPayments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments recorded.</p>
            ) : (
              <div className="space-y-2">
                {debtorPayments.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
                  >
                    <div>
                      <div className="font-semibold text-foreground">
                        {formatINR(p.paidAmount ?? 0)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatCallDate(p.time)}
                        {p.notes ? ` · ${p.notes}` : ""}
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-xs">
                      Logged by {p.agentName || "agent"}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Disputes */}
          <TabsContent value="disputes" className="flex-1 overflow-y-auto px-6 py-4 space-y-3 mt-0">
            {(extra?.disputes ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No disputes raised.</p>
            ) : (
              extra!.disputes.map((disp) => (
                <div key={disp.id} className="rounded-lg border border-border p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">{disp.type}</span>
                    <Badge variant="outline" className="capitalize text-xs text-muted-foreground">
                      {disp.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {disp.id} · Raised {disp.raised}
                  </div>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Action bar */}
      <div className="flex-shrink-0 border-t border-border px-6 py-3 flex flex-wrap gap-2 bg-card">
        <Button
          size="sm"
          className="gap-1.5 h-8 active:scale-95"
          onClick={() => toast.success("Initiating call to " + d.name)}
        >
          <Phone className="h-3.5 w-3.5" />
          Call Now
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 active:scale-95"
          onClick={() => toast.success("WhatsApp opened for " + d.name)}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          WhatsApp
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 active:scale-95"
          onClick={() => toast.success("Payment details sent via SMS")}
        >
          <Banknote className="h-3.5 w-3.5" />
          Share Details
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 active:scale-95"
          onClick={() => toast.info("Settlement workflow initiated")}
        >
          <HandCoins className="h-3.5 w-3.5" />
          Settlement
        </Button>
      </div>
    </div>
  );
}
