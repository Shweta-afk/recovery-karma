import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useEffect } from "react";
import {
  IndianRupee,
  TrendingUp,
  Clock,
  Search,
  X,
  FileDown,
  CreditCard,
  Banknote,
  Smartphone,
  Link as LinkIcon,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Landmark,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { DateRangeFilter } from "@/components/date-range-filter";
import { EMPTY_RANGE, inDateRange, type DateRange } from "@/lib/date-filter";
import { formatINR, bucketOf, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";
import { getDispositions, refreshDispositions } from "@/lib/disposition-store";
import {
  getPayments,
  refreshPayments,
  getSettlements,
  refreshSettlements,
  type PaymentRecord,
  type PaymentStatus,
  type PaymentMethod,
  type SettlementRecord,
} from "@/lib/payments-store";

export const Route = createFileRoute("/dashboard/payments")({
  head: () => ({ meta: [{ title: "Payments · SamvadX" }] }),
  component: PaymentsPage,
});

// ─── Status & method metadata ─────────────────────────────────────────────────
// Mirrors the real `payments.status` / `payments.payment_method` CHECK constraints
// (schema.sql) — not the earlier mock's invented Razorpay-flavored values.

const STATUS_META: Record<PaymentStatus, { label: string; cls: string }> = {
  completed: { label: "Confirmed", cls: "bg-success/8 text-success/70 border-success/15" },
  pending: {
    label: "Pending Verify",
    cls: "bg-warning/8 text-warning-foreground/70 border-warning/15",
  },
  failed: { label: "Failed", cls: "bg-destructive/8 text-destructive/70 border-destructive/15" },
  refunded: { label: "Refunded", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
};

const SETTLEMENT_META: Record<SettlementRecord["status"], { label: string; cls: string }> = {
  approved: { label: "Approved", cls: "bg-success/8 text-success/70 border-success/15" },
  pending_manager: {
    label: "Pending Approval",
    cls: "bg-warning/8 text-warning-foreground/70 border-warning/15",
  },
  rejected: {
    label: "Rejected",
    cls: "bg-destructive/8 text-destructive/70 border-destructive/15",
  },
  sent_to_bank: { label: "Sent to Bank", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
};

const METHOD_LABEL: Record<PaymentMethod, string> = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net Banking",
  cash: "Cash",
  cheque: "Cheque",
  link: "Payment Link",
};

const METHOD_CLS: Record<PaymentMethod, string> = {
  upi: "bg-primary/8 text-primary/70 border-primary/15",
  card: "bg-muted text-muted-foreground border-border",
  netbanking: "bg-muted text-muted-foreground border-border",
  cash: "bg-success/8 text-success/70 border-success/15",
  cheque: "bg-warning/8 text-warning-foreground/70 border-warning/15",
  link: "bg-accent text-accent-foreground border-border",
};

const METHOD_ICON: Record<PaymentMethod, React.ComponentType<{ className?: string }>> = {
  upi: Smartphone,
  card: CreditCard,
  netbanking: Banknote,
  cash: Banknote,
  cheque: CreditCard,
  link: LinkIcon,
};

function formatDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isSameDay(iso: string, ref: Date): boolean {
  return new Date(iso).toDateString() === ref.toDateString();
}

function isSameMonth(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  return d.getMonth() === ref.getMonth() && d.getFullYear() === ref.getFullYear();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function PaymentsPage() {
  // Agents only ever see their own collections here; managers/admins see everything. Enforced
  // client-side against PaymentRecord.agentId, which payments-store.ts populates with the
  // collecting agent's email (same identity used elsewhere on this page as actingAgentId).
  const { user } = useAuth();
  const isAgent = user?.role === "agent";
  const selfId = user?.email ?? user?.id ?? null;

  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_RANGE);
  const [portfolioFilter, setPortfolioFilter] = useState<string>("all");
  const [collectorFilter, setCollectorFilter] = useState<string>("all");
  const [activity, setActivity] = useState<"payments" | "ptp" | "callback">("payments");
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | "all">("all");
  const [methodFilter, setMethodFilter] = useState<PaymentMethod | "all">("all");
  const [bucketFilter, setBucketFilter] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [statusDropOpen, setStatusDropOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // getDispositions() is a plain cache read, so the PTP/callback memo needs an explicit
  // signal when that cache refreshes — it has no React state of its own.
  const [dispositionsTick, setDispositionsTick] = useState(0);
  const [payments, setPayments] = useState<PaymentRecord[]>(() => getPayments());
  const [settlements, setSettlements] = useState<SettlementRecord[]>(() => getSettlements());

  useEffect(() => {
    const loadPayments = () => setPayments(getPayments());
    const loadSettlements = () => setSettlements(getSettlements());
    const bumpDispositions = () => setDispositionsTick((n) => n + 1);
    window.addEventListener("dispositions-updated", bumpDispositions);
    refreshDispositions().catch((e) => console.warn("[dispositions] refresh failed:", e));
    window.addEventListener("payments-updated", loadPayments);
    window.addEventListener("settlements-updated", loadSettlements);
    refreshPayments()
      .then(loadPayments)
      .catch((e) => console.warn("[payments] refresh failed:", e));
    refreshSettlements()
      .then(loadSettlements)
      .catch((e) => console.warn("[settlements] refresh failed:", e));
    return () => {
      window.removeEventListener("dispositions-updated", bumpDispositions);
      window.removeEventListener("payments-updated", loadPayments);
      window.removeEventListener("settlements-updated", loadSettlements);
    };
  }, []);

  // Role gate — everything below reads visiblePayments, never the raw payments state, so an
  // agent can't reach another agent's collections through any KPI, breakdown, or export on
  // this page even though the fetch itself is unscoped.
  const visiblePayments = useMemo(
    () => (isAgent ? payments.filter((p) => p.agentId === selfId) : payments),
    [payments, isAgent, selfId],
  );

  // Every portfolio present in the payments this user can see. Derived from the rows rather
  // than from getPortfolios() so the list can never offer an option that yields nothing.
  const portfolioOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const p of visiblePayments) {
      if (p.portfolioId) byId.set(p.portfolioId, p.portfolioName ?? p.portfolioId);
    }
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [visiblePayments]);

  // The portfolio filter SCOPES the page rather than just filtering the table: the KPI cards,
  // the DPD breakdown and the method breakdown all read `scoped`, not `payments`. Filtering
  // only the table would leave "Collected this month" reporting across every portfolio while
  // the list underneath showed one — the two would contradict each other on screen.
  const scoped = useMemo(
    () =>
      (portfolioFilter === "all"
        ? visiblePayments
        : visiblePayments.filter((p) => p.portfolioId === portfolioFilter)
      )
        // Dated on when the money arrived, falling back to when the row was written for a
        // payment still pending — `receivedAt` is absent until it lands.
        .filter((p) => inDateRange(p.receivedAt ?? p.createdAt, dateRange)),
    [visiblePayments, portfolioFilter, dateRange],
  );

  // Who has actually collected anything in the scoped set, with their role, so a manager's
  // collections are attributable rather than blended into the agent totals.
  const collectorOptions = useMemo(() => {
    const byId = new Map<string, { label: string; role: PaymentRecord["collectorRole"] }>();
    for (const p of scoped) {
      if (!p.agentId) continue;
      byId.set(p.agentId, { label: p.agentName, role: p.collectorRole });
    }
    return [...byId.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [scoped]);

  const byCollector = useMemo(
    () =>
      collectorFilter === "all" ? scoped : scoped.filter((p) => p.agentId === collectorFilter),
    [scoped, collectorFilter],
  );

  // PTPs and callbacks are NOT payments — they live in call_logs via disposition-store. They
  // are surfaced here because "what did this person generate" is the same question as "what
  // did they collect", and answering it meant leaving the page. Scoped by the same portfolio
  // and collector selection so the three views are comparable.
  const activityRows = useMemo(() => {
    if (activity === "payments") return [];
    const wanted = activity === "ptp" ? "promised" : "callback";
    return getDispositions()
      .filter((d) => d.outcome === wanted)
      .filter((d) => portfolioFilter === "all" || d.portfolioId === portfolioFilter)
      // Doesn't go through visiblePayments (this reads dispositions, not payments) — so the
      // agent role-gate is re-applied here directly rather than via the collector picker,
      // which is hidden for agents anyway once collectorOptions collapses to just themselves.
      .filter((d) => (isAgent ? d.agentId === selfId : collectorFilter === "all" || d.agentId === collectorFilter))
      .filter((d) => inDateRange(d.time, dateRange))
      .sort((a, b) => (a.time < b.time ? 1 : -1));
  }, [activity, portfolioFilter, collectorFilter, dateRange, dispositionsTick, isAgent, selfId]);

  // Managers collect too — from their own escalation queue and by dialling on an agent's
  // behalf. Splitting the total is the whole point of the request; a blended figure hides it.
  const collectedByRole = useMemo(() => {
    const done = scoped.filter((p) => p.status === "completed");
    const sum = (role: PaymentRecord["collectorRole"]) =>
      done.filter((p) => p.collectorRole === role).reduce((s, p) => s + p.amount, 0);
    return { agent: sum("agent"), manager: sum("manager") + sum("admin"), bank: sum("bank") };
  }, [scoped]);

  // A portfolio that disappears (reassigned, closed) must not strand the page on an empty
  // selection with no way back.
  useEffect(() => {
    if (portfolioFilter !== "all" && !portfolioOptions.some(([id]) => id === portfolioFilter)) {
      setPortfolioFilter("all");
    }
  }, [portfolioOptions, portfolioFilter]);

  // Same reasoning for the collector: switching portfolio can remove the selected person.
  useEffect(() => {
    if (collectorFilter !== "all" && !collectorOptions.some(([id]) => id === collectorFilter)) {
      setCollectorFilter("all");
    }
  }, [collectorOptions, collectorFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return byCollector.filter((p) => {
      const matchSearch =
        !q ||
        p.debtorName.toLowerCase().includes(q) ||
        p.loanId.toLowerCase().includes(q) ||
        p.notes.toLowerCase().includes(q);
      const matchStatus = statusFilter === "all" || p.status === statusFilter;
      const matchMethod = methodFilter === "all" || p.method === methodFilter;
      const matchBucket = bucketFilter === "all" || bucketOf(p.dpd ?? 0) === bucketFilter;
      return matchSearch && matchStatus && matchMethod && matchBucket;
    });
  }, [byCollector, search, statusFilter, methodFilter, bucketFilter]);

  const now = new Date();
  const confirmedToday = scoped.filter(
    (p) => p.status === "completed" && isSameDay(p.receivedAt ?? p.createdAt, now),
  );
  const confirmedAmount = confirmedToday.reduce((s, p) => s + p.amount, 0);
  const totalMonth = scoped
    .filter((p) => p.status === "completed" && isSameMonth(p.receivedAt ?? p.createdAt, now))
    .reduce((s, p) => s + p.amount, 0);
  // Pending/Failed KPI tiles removed — every payment insert in this app hardcodes
  // status: "completed" (disposition-store.ts, portfolio-store.ts), so those counts are
  // always zero and were dead weight, not a real state to monitor.

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Collections logged against real debtor accounts. Payment links are issued by the bank —
          not a payment gateway — so most rows are logged manually via a call outcome.
        </p>
      </div>

      {/* KPI strip — "Collected by Managers" only makes sense once the view spans more than
          one person, so it's hidden for an agent (always scoped to just themselves). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 animate-in fade-in duration-400">
        {[
          {
            label: "Collected Today",
            value: formatINR(confirmedAmount),
            sub: `${confirmedToday.length} transactions`,
            icon: IndianRupee,
            cls: "text-success",
          },
          {
            label: "Month to Date",
            value: formatINR(totalMonth),
            sub: "Confirmed only",
            icon: TrendingUp,
            cls: "text-primary",
          },
          ...(isAgent
            ? []
            : [
                {
                  // Managers collect from their own escalation queue and by dialling on an
                  // agent's behalf. This used to be folded into the same totals as agent
                  // collections, so there was no way to see it at all.
                  label: "Collected by Managers",
                  value: formatINR(collectedByRole.manager),
                  sub:
                    collectedByRole.bank > 0
                      ? `${formatINR(collectedByRole.agent)} by agents · ${formatINR(collectedByRole.bank)} bank-reported`
                      : `${formatINR(collectedByRole.agent)} by agents`,
                  icon: Users,
                  cls: "text-primary",
                },
              ]),
        ].map((s, i) => (
          <Card
            key={s.label}
            className="animate-in fade-in duration-400"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <CardContent className="p-4 flex items-start gap-3">
              <div className={cn("mt-0.5", s.cls)}>
                <s.icon className="h-4 w-4" />
              </div>
              <div>
                <div className={cn("text-xl font-bold", s.cls)}>{s.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                <div className="text-[11px] text-muted-foreground/70">{s.sub}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs: Collections | Settlements */}
      <Tabs defaultValue="collections">
        <TabsList className="bg-muted/50 h-9">
          <TabsTrigger value="collections" className="text-sm">
            Collections
          </TabsTrigger>
          <TabsTrigger value="settlements" className="text-sm">
            Settlements
          </TabsTrigger>
        </TabsList>

        {/* ── Collections ── */}
        <TabsContent value="collections" className="space-y-3 mt-4">
          {/* Filters row: search + status pills + bucket dropdown + method dropdown */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search debtor, notes, loan…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm w-48"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <DateRangeFilter value={dateRange} onChange={setDateRange} />

            {/* Status filter — a dropdown like Bucket, rather than a pill per status. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setStatusDropOpen((o) => !o)}
                className={cn(
                  "flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-xs transition-all",
                  statusFilter !== "all"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {statusFilter === "all" ? "Status" : STATUS_META[statusFilter].label}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
              {statusDropOpen && (
                <div className="absolute left-0 top-full mt-1 z-30 w-44 rounded-lg border border-border bg-card shadow-lg py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setStatusFilter("all");
                      setStatusDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50",
                      statusFilter === "all" ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    All
                  </button>
                  {(Object.keys(STATUS_META) as PaymentStatus[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setStatusFilter(key);
                        setStatusDropOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                        statusFilter === key ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span>{STATUS_META[key].label}</span>
                      <span className="opacity-50">
                        {scoped.filter((p) => p.status === key).length}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Bucket dropdown */}
            <div className="relative ml-auto">
              <button
                type="button"
                onClick={() => setBucketDropOpen((o) => !o)}
                className={cn(
                  "flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-xs transition-all",
                  bucketFilter !== "all"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {bucketFilter === "all" ? "Bucket" : BUCKET_META[bucketFilter].label}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
              {bucketDropOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-lg border border-border bg-card shadow-lg py-1">
                  <button
                    type="button"
                    onClick={() => {
                      setBucketFilter("all");
                      setBucketDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                      bucketFilter === "all"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <span>All Buckets</span>
                    {/* scoped, not payments — the per-bucket counts below are scoped, so an
                        unscoped total here would exceed the sum of the rows under it. */}
                    <span className="opacity-50">{scoped.length}</span>
                  </button>
                  {(["X", "1", "2", "NPA", "WriteOff"] as DPDBucket[]).map((b) => {
                    const count = scoped.filter((p) => bucketOf(p.dpd ?? 0) === b).length;
                    if (count === 0) return null;
                    return (
                      <button
                        key={b}
                        type="button"
                        onClick={() => {
                          setBucketFilter(b);
                          setBucketDropOpen(false);
                        }}
                        className={cn(
                          "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                          bucketFilter === b
                            ? "font-medium text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        <span>{BUCKET_META[b].label}</span>
                        <span className="opacity-50">{count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Portfolio scope — only worth showing when there is a choice to make. */}
            {portfolioOptions.length > 1 && (
              <div className="flex gap-1.5 flex-wrap items-center">
                <span className="text-xs text-muted-foreground mr-0.5">Portfolio</span>
                {[["all", `All (${portfolioOptions.length})`] as const, ...portfolioOptions].map(
                  ([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPortfolioFilter(id)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
                        portfolioFilter === id
                          ? "bg-foreground text-background border-foreground"
                          : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30",
                      )}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
            )}

            {/* Collected by — answers "which agent or manager brought this in". Role is on the
                pill because duplicate names are common and a manager's collections need to be
                distinguishable at a glance. */}
            {collectorOptions.length > 1 && (
              <div className="flex gap-1.5 flex-wrap items-center">
                <span className="text-xs text-muted-foreground mr-0.5">Collected by</span>
                {[
                  ["all", { label: "Anyone", role: "agent" as const }] as const,
                  ...collectorOptions,
                ].map(([id, meta]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setCollectorFilter(id)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
                      collectorFilter === id
                        ? "bg-foreground text-background border-foreground"
                        : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30",
                    )}
                  >
                    {meta.label}
                    {id !== "all" && meta.role !== "agent" && (
                      <span className="ml-1 opacity-60">· {meta.role}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Payments / PTPs / Callbacks. PTPs and callbacks come from dispositions, not the
                payments table — see activityRows. */}
            <div className="flex gap-1.5 flex-wrap items-center">
              <span className="text-xs text-muted-foreground mr-0.5">Showing</span>
              {(
                [
                  ["payments", "Payments"],
                  ["ptp", "PTPs generated"],
                  ["callback", "Callbacks generated"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActivity(key)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
                    activity === key
                      ? "bg-foreground text-background border-foreground"
                      : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Method pills */}
            <div className="flex gap-1.5 flex-wrap">
              {(["all", "upi", "netbanking", "cash", "cheque", "link"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethodFilter(m)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
                    methodFilter === m
                      ? "bg-foreground text-background border-foreground"
                      : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  {m === "all" ? "All methods" : METHOD_LABEL[m]}
                </button>
              ))}
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">
                  {filtered.length} records
                  {statusFilter !== "all" || methodFilter !== "all" || portfolioFilter !== "all"
                    ? " (filtered)"
                    : ""}
                </CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    const headers = [
                      "Date",
                      "Debtor",
                      "Loan ID",
                      "Amount",
                      "Method",
                      "Status",
                      "Notes",
                      "Agent",
                      "DPD Bucket",
                    ];
                    const rows = filtered.map((p) => [
                      formatDate(p.receivedAt ?? p.createdAt),
                      p.debtorName,
                      p.loanId,
                      p.amount,
                      p.method ? METHOD_LABEL[p.method] : "",
                      STATUS_META[p.status].label,
                      p.notes,
                      p.source === "bank_reported" ? "Bank Reported" : p.agentName,
                      p.dpd ?? "",
                    ]);
                    const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
                    const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "payments.csv";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <FileDown className="h-3.5 w-3.5" />
                  Export
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto max-h-[540px]">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>Debtor</TableHead>
                      <TableHead>Portfolio / Product</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={9}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No payments logged yet. Payments are recorded when an agent disposes a
                          call as "Paid" — nothing to show until that happens.
                        </TableCell>
                      </TableRow>
                    )}
                    {payments.length > 0 && filtered.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={9}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No payments match this filter.
                        </TableCell>
                      </TableRow>
                    )}
                    {filtered.map((p) => {
                      const sMeta = STATUS_META[p.status];
                      const MethodIcon = p.method ? METHOD_ICON[p.method] : null;
                      const expanded = expandedId === p.id;
                      return (
                        <>
                          <TableRow
                            key={p.id}
                            className={cn(
                              "hover:bg-primary/5 cursor-pointer",
                              p.status === "failed" && "bg-destructive/5",
                            )}
                            onClick={() => setExpandedId(expanded ? null : p.id)}
                          >
                            <TableCell>
                              {/* A payment whose debtor this user cannot see — a bank-reported
                                  row on someone else's account. Say that, rather than showing a
                                  dash and an internal id and leaving them to guess. */}
                              <div className="font-medium text-sm">
                                {p.debtorName || (
                                  <span className="text-muted-foreground italic">
                                    Account not visible to you
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {p.loanId ? `${p.loanId} · ` : ""}DPD {p.dpd ?? "—"}d
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm text-foreground">
                                {p.portfolioName ?? "—"}
                              </div>
                              <div className="text-[11px] text-muted-foreground">
                                {[p.product, p.lender].filter(Boolean).join(" · ") || "—"}
                              </div>
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right font-semibold text-sm",
                                p.status === "completed"
                                  ? "text-success"
                                  : p.status === "failed"
                                    ? "text-destructive"
                                    : "text-foreground",
                              )}
                            >
                              {formatINR(p.amount)}
                            </TableCell>
                            <TableCell>
                              {p.method ? (
                                <Badge
                                  variant="outline"
                                  className={cn("text-xs gap-1", METHOD_CLS[p.method])}
                                >
                                  {MethodIcon && <MethodIcon className="h-3 w-3" />}
                                  {METHOD_LABEL[p.method]}
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                              {p.notes || "—"}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                              {formatDate(p.receivedAt ?? p.createdAt)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={cn("text-xs", sMeta.cls)}>
                                {sMeta.label}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {p.source === "bank_reported" ? (
                                <Badge
                                  variant="outline"
                                  className="text-xs gap-1 bg-blue-500/8 text-blue-600 border-blue-400/20"
                                  title="Reported paid via the bank's daily file, not collected by an agent"
                                >
                                  <Landmark className="h-3 w-3" />
                                  Bank Reported
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">{p.agentName}</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {expanded ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </TableCell>
                          </TableRow>

                          {/* Expanded detail row */}
                          {expanded && (
                            <TableRow
                              key={p.id + "-detail"}
                              className="bg-muted/20 hover:bg-muted/20"
                            >
                              <TableCell colSpan={9} className="py-3 px-6">
                                <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
                                  {[
                                    ["Payment Type", p.paymentType],
                                    ["Notes", p.notes || "—"],
                                    ["Debtor Phone", p.phone || "—"],
                                    [
                                      "Agent",
                                      p.source === "bank_reported" ? "Bank Reported" : p.agentName,
                                    ],
                                  ].map(([label, val]) => (
                                    <div key={String(label)}>
                                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        {label}
                                      </div>
                                      <div className="font-medium text-foreground mt-0.5">
                                        {val}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                {p.status === "failed" && (
                                  <div className="mt-3 flex items-center gap-2">
                                    <AlertTriangle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                                    <p className="text-xs text-destructive">
                                      Payment failed — requires immediate follow-up.
                                    </p>
                                    <Button
                                      size="sm"
                                      className="ml-auto h-7 px-2 text-xs gap-1"
                                      onClick={() =>
                                        toast.info("Follow-up task created for " + p.debtorName)
                                      }
                                    >
                                      Create Follow-up
                                    </Button>
                                  </div>
                                )}
                                {p.status === "pending" && (
                                  <div className="mt-3 flex items-center gap-2">
                                    <Clock className="h-3.5 w-3.5 text-warning-foreground flex-shrink-0" />
                                    <p className="text-xs text-warning-foreground">
                                      Awaiting bank confirmation.
                                    </p>
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Summary by method — scoped, so it hides rather than showing a row of zeros when
              the selected portfolio has no payments. */}
          {scoped.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {(["upi", "card", "netbanking", "cash", "cheque", "link"] as PaymentMethod[]).map(
                (m) => {
                  const total = scoped
                    .filter((p) => p.method === m && p.status === "completed")
                    .reduce((s, p) => s + p.amount, 0);
                  const count = scoped.filter((p) => p.method === m).length;
                  if (count === 0) return null;
                  const Icon = METHOD_ICON[m];
                  return (
                    <Card key={m} className="animate-in fade-in duration-400">
                      <CardContent className="p-3">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs font-semibold text-foreground">
                            {METHOD_LABEL[m]}
                          </span>
                        </div>
                        <div className="text-sm font-bold text-foreground">
                          {total > 0 ? formatINR(total) : "—"}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {count} transaction{count !== 1 ? "s" : ""}
                        </div>
                      </CardContent>
                    </Card>
                  );
                },
              )}
            </div>
          )}
        </TabsContent>

        {/* ── Settlements ── */}
        <TabsContent value="settlements" className="mt-4">
          <Card>
            <CardHeader className="pb-3 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Settlement Proposals</CardTitle>
                <span className="text-xs text-muted-foreground">
                  Manager approval required for waivers above 15%
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto max-h-[400px]">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>Debtor</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Settlement</TableHead>
                      <TableHead className="text-right">Waiver</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Raised By</TableHead>
                      <TableHead className="min-w-[200px]">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {settlements.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={8}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No settlement requests raised yet.
                        </TableCell>
                      </TableRow>
                    )}
                    {settlements.map((s) => {
                      const meta = SETTLEMENT_META[s.status];
                      return (
                        <TableRow key={s.id} className="hover:bg-primary/5 align-top">
                          <TableCell>
                            <div className="font-medium text-sm">{s.debtorName || "—"}</div>
                            <div className="text-[11px] text-muted-foreground">{s.loanId}</div>
                          </TableCell>
                          <TableCell className="text-right font-medium text-sm">
                            {formatINR(s.originalAmount)}
                          </TableCell>
                          <TableCell className="text-right font-semibold text-teal-600 text-sm">
                            {formatINR(s.proposedAmount)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-semibold text-sm",
                              s.waiverPct > 20 ? "text-destructive" : "text-warning-foreground",
                            )}
                          >
                            {s.waiverPct}%
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDate(s.createdAt)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn("text-xs", meta.cls)}>
                              {meta.label}
                            </Badge>
                            {s.approvedByName && (
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {s.approvedByName}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {s.requestedByName}
                          </TableCell>
                          <TableCell>
                            <p className="text-xs text-foreground/80 leading-relaxed">
                              {s.notes || "—"}
                            </p>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
