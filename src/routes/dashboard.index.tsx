import { createFileRoute } from "@tanstack/react-router";
import { createContext, useContext, useState } from "react";
import {
  PhoneCall,
  PhoneIncoming,
  HandCoins,
  IndianRupee,
  CheckCircle2,
  Phone,
  Clock,
  Coffee,
  FileText,
  Wifi,
  ZapOff,
  Users,
  CalendarClock,
  BotMessageSquare,
  PhoneMissed,
  ExternalLink,
  RefreshCcw,
  ChevronDown,
  CalendarDays,
  FileDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatINR, MOCK_DEBTORS } from "@/lib/mock-debtors";
import { Link, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Agent Dashboard · RecoveryAI" },
      { name: "description", content: "Agent dashboard with KPIs and today's summary." },
    ],
  }),
  component: AgentDashboard,
});

// ─── Mock data ────────────────────────────────────────────────────────────────

type Period = "today" | "month" | "custom";

// Queue breakdown by outcome category — single source of truth for "Today" counts
const QUEUE_BREAKDOWN = [
  {
    key: "callback",
    label: "Callback",
    count: 8,
    principal: 612000,
    ptpAmount: null,
    ptpDate: null,
    cls: "text-amber-500",
    dot: "bg-amber-400",
  },
  {
    key: "ptp",
    label: "PTP",
    count: 14,
    principal: 1840000,
    ptpAmount: 245000,
    ptpDate: "25 Jun",
    cls: "text-blue-500",
    dot: "bg-blue-400",
  },
  {
    key: "dispute",
    label: "Dispute",
    count: 3,
    principal: 520000,
    ptpAmount: null,
    ptpDate: null,
    cls: "text-orange-500",
    dot: "bg-orange-400",
  },
  {
    key: "rtp",
    label: "RTP",
    count: 5,
    principal: 380000,
    ptpAmount: null,
    ptpDate: null,
    cls: "text-purple-500",
    dot: "bg-purple-400",
  },
  {
    key: "followup",
    label: "Follow-up",
    count: 22,
    principal: 2100000,
    ptpAmount: null,
    ptpDate: null,
    cls: "text-primary",
    dot: "bg-primary",
  },
  {
    key: "writeoff",
    label: "Write-off",
    count: 7,
    principal: 890000,
    ptpAmount: null,
    ptpDate: null,
    cls: "text-destructive",
    dot: "bg-destructive",
  },
  {
    key: "nc",
    label: "NC",
    count: 18,
    principal: 1430000,
    ptpAmount: null,
    ptpDate: null,
    cls: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  {
    key: "fresh",
    label: "Fresh",
    count: 43,
    principal: 3270000,
    ptpAmount: null,
    ptpDate: null,
    cls: "text-success",
    dot: "bg-success",
  },
];

// Total principal currently under management across the whole queue (period-independent)
const PORTFOLIO_TOTAL_PRINCIPAL = QUEUE_BREAKDOWN.reduce((s, r) => s + r.principal, 0);

// Map a breakdown category to the matching call-queue filter (falls back to "all")
type QueueFilter =
  | "all"
  | "retained"
  | "callback"
  | "ptp"
  | "no_answer"
  | "fresh"
  | "escalated"
  | "switch_off"
  | "nc"
  | "paid";
const CATEGORY_TO_FILTER: Record<string, QueueFilter> = {
  callback: "callback",
  ptp: "ptp",
  nc: "nc",
  fresh: "fresh",
  dispute: "escalated",
};

// Derive "today" KPIs from QUEUE_BREAKDOWN so they stay in sync
const _qb = (key: string) => QUEUE_BREAKDOWN.find((r) => r.key === key)!;
const KPI_BY_PERIOD: Record<
  Exclude<Period, "custom">,
  {
    totalCalling: number;
    totalCallback: number;
    todayPTP: number;
    totalPTPAmount: number;
    todayPaid: number;
    todayPaidAmount: number;
    aiCallsHandled: number;
    aiPTPs: number;
    aiEscalated: number;
  }
> = {
  today: {
    totalCalling: 47,
    totalCallback: _qb("callback").count, // 8
    todayPTP: _qb("ptp").count, // 14
    totalPTPAmount: _qb("ptp").ptpAmount ?? 245000,
    todayPaid: 6,
    todayPaidAmount: 48500,
    aiCallsHandled: 28,
    aiPTPs: 9,
    aiEscalated: 3,
  },
  month: {
    totalCalling: 1140,
    totalCallback: 192,
    todayPTP: 318,
    totalPTPAmount: 5820000,
    todayPaid: 148,
    todayPaidAmount: 1162000,
    aiCallsHandled: 672,
    aiPTPs: 214,
    aiEscalated: 71,
  },
};

// Debtor call intensity — contacts attempted vs connected, with a heat score
const DEBTOR_INTENSITY = MOCK_DEBTORS.slice(0, 12)
  .map((d, i) => {
    const attempts = [6, 9, 3, 7, 2, 8, 5, 4, 1, 6, 3, 7][i];
    const connected = [4, 7, 1, 5, 1, 6, 3, 2, 0, 4, 2, 5][i];
    const heat = Math.round((connected / Math.max(attempts, 1)) * 10); // 0-10
    return { ...d, attempts, connected, heat };
  })
  .sort((a, b) => a.heat - b.heat);

// Retained debtors — passed from previous month's portfolio
const RETAINED_DEBTORS = [
  {
    id: "L-09801",
    name: "Suresh Pillai",
    phone: "+91 97XXX XX441",
    loanAmount: 185000,
    dpd: 38,
    prevOutcome: "PTP",
    ptpAmount: 18000,
    portfolio: "Personal Loan Q4 (May)",
    retained: "Agent-assigned",
    pos: "HDFC Branch, Andheri",
    note: "Broke PTP twice — high-touch required",
  },
  {
    id: "L-09744",
    name: "Kavitha Menon",
    phone: "+91 98XXX XX903",
    loanAmount: 92000,
    dpd: 55,
    prevOutcome: "Callback",
    ptpAmount: null,
    portfolio: "Credit Card NPA (May)",
    retained: "Agent-assigned",
    pos: "Online / App",
    note: "Prefers evening calls, polite",
  },
  {
    id: "L-09655",
    name: "Deepak Rawat",
    phone: "+91 91XXX XX771",
    loanAmount: 370000,
    dpd: 71,
    prevOutcome: "Refused",
    ptpAmount: null,
    portfolio: "MSME Working Cap (May)",
    retained: "Portfolio carry",
    pos: "SME Desk, Pune",
    note: "Dispute logged — needs manager review",
  },
  {
    id: "L-09512",
    name: "Bhavna Shah",
    phone: "+91 99XXX XX308",
    loanAmount: 61000,
    dpd: 22,
    prevOutcome: "PTP",
    ptpAmount: 9000,
    portfolio: "Two-Wheeler Auto (May)",
    retained: "Agent-assigned",
    pos: "Dealer – Bajaj, Surat",
    note: "PTP kept last month — likely to pay",
  },
  {
    id: "L-09488",
    name: "Naresh Kumar",
    phone: "+91 90XXX XX155",
    loanAmount: 128000,
    dpd: 47,
    prevOutcome: "No Answer",
    ptpAmount: null,
    portfolio: "Personal Loan Q4 (May)",
    retained: "Portfolio carry",
    pos: "DSA – Finserv Partners",
    note: "Phone inactive — try WhatsApp",
  },
];

const PREV_OUTCOME_CLS: Record<string, string> = {
  PTP: "bg-blue-500/8 text-blue-500/70 border-blue-400/15",
  Callback: "bg-warning/8 text-warning-foreground/70 border-warning/15",
  Refused: "bg-destructive/8 text-destructive/70 border-destructive/15",
  "No Answer": "bg-muted text-muted-foreground border-border",
};

// Daily targets set by manager for this agent
const DAILY_TARGETS = {
  calls: { target: 60, actual: 47, unit: "calls" },
  ptpCount: { target: 18, actual: 14, unit: "PTPs" },
  ptpAmount: { target: 350000, actual: 245000, unit: "₹" },
  collections: { target: 80000, actual: 48500, unit: "₹" },
  talkTime: { target: 240, actual: 165, unit: "min" },
  contactRate: { target: 75, actual: 61, unit: "%" },
};

const TIME_TRACKING = {
  ringing: 72,
  talking: 165,
  breakTime: 45,
  feedback: 38,
  idle: 82,
  online: 78,
};
const TOTAL_SHIFT_MINS = Object.values(TIME_TRACKING).reduce((a, b) => a + b, 0);

function fmtMins(mins: number) {
  const h = Math.floor(mins / 60),
    m = mins % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

// When false (e.g. the manager's read-only mirror of an agent's dashboard), the quick-link
// cards render as plain divs so a click doesn't navigate the manager into the agent route tree.
const InteractiveContext = createContext(true);

function Nav({
  to,
  search,
  className,
  style,
  children,
}: {
  to: string;
  search?: Record<string, unknown>;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const interactive = useContext(InteractiveContext);
  if (interactive)
    return (
      <Link to={to} search={search} className={className} style={style}>
        {children}
      </Link>
    );
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

/** Route wrapper — the agent's own interactive dashboard. */
function AgentDashboard() {
  return <AgentDashboardContent />;
}

/** The dashboard body, reused read-only by the manager's Agent Live View.
 * `interactive={false}` disables the quick-link navigation for the mirrored view. */
export function AgentDashboardContent({ interactive = true }: { interactive?: boolean }) {
  const [period, setPeriod] = useState<Period>("today");
  const [customDate, setCustomDate] = useState("");
  const [intensitySlide, setIntensitySlide] = useState(0);
  const [retainedOpen, setRetainedOpen] = useState(false);
  const navigate = useNavigate();
  const goToQueue = (filter: QueueFilter) => {
    if (interactive) navigate({ to: "/dashboard/call-queue", search: { filter } });
  };

  const kpi =
    period === "custom"
      ? KPI_BY_PERIOD.today // use today's data as placeholder for custom date
      : KPI_BY_PERIOD[period];

  // Today's PTP generation — always today's stock, independent of the period toggle
  const todayGeneration = _qb("ptp");
  const projectedRecovery = kpi.totalPTPAmount + kpi.todayPaidAmount;

  return (
    <InteractiveContext.Provider value={interactive}>
      <div className="space-y-5">
        {/* ── Compact header row ── */}
        <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Agent Dashboard
            </h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse inline-block" />
              Hybrid (AI + Agent) · Dialer online
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Period selector inline */}
            <div className="flex items-center rounded-lg border border-border bg-card p-0.5 gap-0.5">
              {(["today", "month"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setPeriod(p);
                    setRetainedOpen(p === "month");
                  }}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-all",
                    period === p
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p === "today" ? "Today" : "This Month"}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPeriod("custom")}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-all flex items-center gap-1",
                  period === "custom"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CalendarDays className="h-3 w-3" />
                Custom
              </button>
            </div>
            {period === "custom" && (
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="h-7 rounded-lg border border-border bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            )}
          </div>
        </div>

        {/* ── Collections: Target / Shortfall / Run Rate / EOD Projection ── */}
        {(() => {
          const target = DAILY_TARGETS.collections.target;
          const actual = DAILY_TARGETS.collections.actual;
          const shortfall = Math.max(0, target - actual);
          const dailyRunRate = Math.round((actual / 6.5) * 9);
          const projection = dailyRunRate;
          return (
            <div className="space-y-2">
              <SectionLabel>Collections · Today</SectionLabel>
              <div className="grid grid-cols-4 gap-2">
                {[
                  {
                    label: "Target",
                    value: formatINR(target),
                    sub: "daily target",
                    cls: "text-foreground",
                    bar: null,
                    filter: "paid" as const,
                  },
                  {
                    label: "Shortfall",
                    value: formatINR(shortfall),
                    sub: "gap to close",
                    cls: shortfall === 0 ? "text-success" : "text-destructive",
                    bar: null,
                    filter: "all" as const,
                  },
                  {
                    label: "Run Rate",
                    value: formatINR(dailyRunRate),
                    sub: "pace × shift",
                    cls: "text-amber-500",
                    bar: null,
                    filter: "all" as const,
                  },
                  {
                    label: "EOD Projection",
                    value: formatINR(projection),
                    sub: "est. end of day",
                    cls: projection >= target ? "text-success" : "text-destructive",
                    bar: projection / target,
                    filter: "ptp" as const,
                  },
                ].map((s) => (
                  <Nav
                    key={s.label}
                    to="/dashboard/call-queue"
                    search={{ filter: s.filter }}
                    className="rounded-lg border border-border bg-card px-3 py-2.5 transition-all hover:border-foreground/30 hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <div className={cn("text-base font-bold tabular-nums leading-tight", s.cls)}>
                      {s.value}
                    </div>
                    <div className="text-[11px] font-medium text-foreground mt-0.5">{s.label}</div>
                    <div className="text-[10px] text-muted-foreground">{s.sub}</div>
                    {s.bar !== null && (
                      <div className="mt-1.5 h-0.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            s.bar >= 1 ? "bg-success" : "bg-primary",
                          )}
                          style={{ width: `${Math.min(s.bar * 100, 100)}%` }}
                        />
                      </div>
                    )}
                  </Nav>
                ))}
              </div>
            </div>
          );
        })()}

        {/* ── Performance + Queue Overview side by side ── */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[3fr_2fr]">
          {/* Performance KPIs */}
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Performance ·{" "}
                {period === "today"
                  ? "Today"
                  : period === "month"
                    ? "This Month"
                    : customDate || "—"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {[
                {
                  label: "Calling",
                  value: kpi.totalCalling.toString(),
                  hint: "dials",
                  icon: PhoneCall,
                  highlight: false,
                  filter: "all" as const,
                },
                {
                  label: "Callback",
                  value: kpi.totalCallback.toString(),
                  hint: "scheduled",
                  icon: PhoneIncoming,
                  highlight: false,
                  filter: "callback" as const,
                },
                {
                  label: "PTPs",
                  value: kpi.todayPTP.toString(),
                  hint: "promised",
                  icon: HandCoins,
                  highlight: false,
                  filter: "ptp" as const,
                },
                {
                  label: "PTP Amount",
                  value: formatINR(kpi.totalPTPAmount),
                  hint: "committed",
                  icon: IndianRupee,
                  highlight: false,
                  filter: "ptp" as const,
                },
                {
                  label: "Collected",
                  value: formatINR(kpi.todayPaidAmount),
                  hint: `${kpi.todayPaid} calls`,
                  icon: CheckCircle2,
                  highlight: true,
                  filter: "paid" as const,
                },
              ].map((c, i) => (
                <Nav
                  key={c.label}
                  to="/dashboard/call-queue"
                  search={{ filter: c.filter }}
                  className={cn(
                    "rounded-lg border p-2.5 animate-in fade-in duration-300 transition-all hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary",
                    c.highlight
                      ? "border-success/30 bg-success/5 hover:border-success/50"
                      : "border-border bg-muted/20 hover:border-foreground/30",
                  )}
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {c.label}
                    </span>
                    <c.icon
                      className={cn(
                        "h-3.5 w-3.5",
                        c.highlight ? "text-success" : "text-muted-foreground/50",
                      )}
                    />
                  </div>
                  <div
                    className={cn(
                      "text-base font-bold tabular-nums",
                      c.highlight ? "text-success" : "text-foreground",
                    )}
                  >
                    {c.value}
                  </div>
                  <div className="text-[10px] text-muted-foreground">{c.hint}</div>
                </Nav>
              ))}
            </div>

            {/* AI row inline */}
            <div className="mt-2.5 pt-2.5 border-t border-border flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
                AI Bot
              </span>
              {[
                { label: "Handled", value: kpi.aiCallsHandled, cls: "text-foreground" },
                { label: "AI PTPs", value: kpi.aiPTPs, cls: "text-blue-500" },
                { label: "Escalated", value: kpi.aiEscalated, cls: "text-amber-500" },
                {
                  label: "No Answer",
                  value: period === "month" ? 264 : 11,
                  cls: "text-muted-foreground",
                },
              ].map((s) => (
                <div
                  key={s.label}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1"
                >
                  <span className={cn("text-sm font-bold tabular-nums", s.cls)}>{s.value}</span>
                  <span className="text-[10px] text-muted-foreground">{s.label}</span>
                </div>
              ))}
              <Nav
                to="/dashboard/call-queue"
                className="ml-auto text-[10px] text-primary hover:underline flex items-center gap-1"
              >
                AI queue <ExternalLink className="h-3 w-3" />
              </Nav>
            </div>
          </div>

          {/* Queue Overview */}
          <div className="rounded-xl border border-border bg-card p-3 flex flex-col">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Queue
              </span>
              <Nav
                to="/dashboard/call-queue"
                className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
              >
                Open <ExternalLink className="h-2.5 w-2.5" />
              </Nav>
            </div>
            <div className="flex-1 grid grid-cols-3 gap-2">
              <Nav
                to="/dashboard/call-queue"
                search={{ filter: "all" }}
                className="rounded-lg border border-border bg-muted/20 p-2.5 text-center flex flex-col justify-center transition-all hover:border-foreground/30 hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <div className="text-base font-bold text-foreground tabular-nums leading-tight">
                  {formatINR(PORTFOLIO_TOTAL_PRINCIPAL)}
                </div>
                <div className="text-[10px] font-medium text-foreground leading-tight mt-1">
                  Total Principal
                </div>
                <div className="text-[9px] text-muted-foreground leading-tight">portfolio</div>
              </Nav>
              <Nav
                to="/dashboard/call-queue"
                search={{ filter: "ptp" }}
                className="rounded-lg border border-success/30 bg-success/5 p-2.5 text-center flex flex-col justify-center transition-all hover:border-success/50 hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <div className="text-base font-bold text-success tabular-nums leading-tight">
                  {formatINR(projectedRecovery)}
                </div>
                <div className="text-[10px] font-medium text-foreground leading-tight mt-1">
                  Projected Recovery
                </div>
                <div className="text-[9px] text-muted-foreground leading-tight">
                  PTP + collected
                </div>
              </Nav>
              <Nav
                to="/dashboard/call-queue"
                search={{ filter: "ptp" }}
                className="rounded-lg border border-blue-400/30 bg-blue-500/5 p-2.5 text-center flex flex-col justify-center transition-all hover:border-blue-400/50 hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <div className="text-base font-bold text-blue-500 tabular-nums leading-tight">
                  {formatINR(todayGeneration.ptpAmount ?? 0)}
                </div>
                <div className="text-[10px] font-medium text-foreground leading-tight mt-1">
                  Today's Generation
                </div>
                <div className="text-[9px] text-muted-foreground leading-tight">
                  {todayGeneration.count} PTPs today
                </div>
              </Nav>
            </div>
          </div>
        </div>

        {/* ── Activity Breakdown ── */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* Debtor Intensity — two-slide card */}
          <Card className="animate-in fade-in slide-in-from-left-4 duration-500">
            <CardHeader className="pb-2 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Debtor Contact Breakdown</CardTitle>
                {/* Slide tabs */}
                <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
                  <button
                    type="button"
                    onClick={() => setIntensitySlide(0)}
                    className={cn(
                      "rounded-md px-2.5 py-0.5 text-[10px] font-medium transition-all",
                      intensitySlide === 0
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Category
                  </button>
                  <button
                    type="button"
                    onClick={() => setIntensitySlide(1)}
                    className={cn(
                      "rounded-md px-2.5 py-0.5 text-[10px] font-medium transition-all",
                      intensitySlide === 1
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Intensity
                  </button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {intensitySlide === 0 ? (
                /* ── Category breakdown as a table ── */
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Cases</TableHead>
                        <TableHead className="text-right">Principal</TableHead>
                        <TableHead className="text-right">PTP Amount</TableHead>
                        <TableHead>PTP Due</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {QUEUE_BREAKDOWN.map((row) => (
                        <TableRow
                          key={row.key}
                          onClick={() => goToQueue(CATEGORY_TO_FILTER[row.key] ?? "all")}
                          className="cursor-pointer hover:bg-muted/30 transition-colors"
                        >
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className={cn("h-2 w-2 rounded-full flex-shrink-0", row.dot)} />
                              <span className="text-xs font-medium text-foreground">
                                {row.label}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-sm font-semibold tabular-nums text-foreground">
                            {row.count}
                          </TableCell>
                          <TableCell
                            className={cn("text-right text-xs font-semibold tabular-nums", row.cls)}
                          >
                            {formatINR(row.principal)}
                          </TableCell>
                          <TableCell className="text-right text-xs font-semibold tabular-nums text-blue-500">
                            {row.ptpAmount ? (
                              formatINR(row.ptpAmount)
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {row.ptpDate ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                /* ── Contact intensity per debtor as a table ── */
                <div className="overflow-y-auto max-h-[300px] overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Debtor</TableHead>
                        <TableHead>ID</TableHead>
                        <TableHead>Connection</TableHead>
                        <TableHead className="text-right">Connected / Attempts</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {DEBTOR_INTENSITY.map((d) => {
                        const connPct = Math.round((d.connected / Math.max(d.attempts, 1)) * 100);
                        const barCls =
                          connPct >= 70
                            ? "bg-foreground"
                            : connPct >= 40
                              ? "bg-foreground/60"
                              : "bg-muted-foreground/30";
                        return (
                          <TableRow
                            key={d.id}
                            onClick={() => goToQueue("all")}
                            className="cursor-pointer hover:bg-muted/30 transition-colors"
                          >
                            <TableCell className="text-xs font-medium text-foreground">
                              {d.name}
                            </TableCell>
                            <TableCell className="text-[11px] text-muted-foreground">
                              {d.id}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2 min-w-[120px]">
                                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                                  <div
                                    className={cn("h-full rounded-full", barCls)}
                                    style={{ width: `${connPct}%` }}
                                  />
                                </div>
                                <span className="text-xs font-semibold tabular-nums text-muted-foreground w-9 text-right">
                                  {connPct}%
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                              {d.connected}/{d.attempts}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Time Distribution — compact */}
          <Card className="animate-in fade-in slide-in-from-right-4 duration-500">
            <CardHeader className="pb-2 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Time Distribution · Today</CardTitle>
                <span className="text-xs text-muted-foreground">
                  {fmtMins(TOTAL_SHIFT_MINS)} shift
                </span>
              </div>
            </CardHeader>
            <CardContent className="pt-3 space-y-3">
              <div className="flex h-3 w-full overflow-hidden rounded-full gap-0.5">
                {TIME_SEGMENTS.map((seg) => (
                  <div
                    key={seg.key}
                    className={cn(
                      "h-full rounded-sm first:rounded-l-full last:rounded-r-full",
                      seg.barCls,
                    )}
                    style={{ width: `${(TIME_TRACKING[seg.key] / TOTAL_SHIFT_MINS) * 100}%` }}
                    title={`${seg.label}: ${fmtMins(TIME_TRACKING[seg.key])}`}
                  />
                ))}
              </div>
              <div className="space-y-2">
                {TIME_SEGMENTS.map((seg) => {
                  const mins = TIME_TRACKING[seg.key];
                  const pct = Math.round((mins / TOTAL_SHIFT_MINS) * 100);
                  return (
                    <TimeRow
                      key={seg.key}
                      icon={seg.icon}
                      label={seg.label}
                      desc={seg.desc}
                      mins={mins}
                      pct={pct}
                      barCls={seg.barCls}
                      textCls={seg.textCls}
                      dot={seg.dot}
                    />
                  );
                })}
              </div>
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 flex items-center justify-between gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Productive</span>
                  <span className="font-semibold text-foreground">
                    {fmtMins(
                      TIME_TRACKING.ringing +
                        TIME_TRACKING.talking +
                        TIME_TRACKING.feedback +
                        TIME_TRACKING.online,
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Non-productive</span>
                  <span className="font-semibold text-muted-foreground">
                    {fmtMins(TIME_TRACKING.breakTime + TIME_TRACKING.idle)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Retain Debtors — collapsible panel ── */}
        <section>
          <SectionLabel>Retain Debtors · Carried from May 2026</SectionLabel>
          <div className="mt-3 rounded-xl border border-violet-400/30 bg-violet-500/5 overflow-hidden animate-in fade-in duration-400">
            {/* Header / toggle */}
            <div className="flex items-center justify-between px-4 py-3">
              <button
                type="button"
                onClick={() => setRetainedOpen((o) => !o)}
                className="flex items-center gap-2.5 flex-1 text-left group"
              >
                <span className="h-2.5 w-2.5 rounded-full bg-violet-500 flex-shrink-0" />
                <span className="text-sm font-semibold text-violet-600">
                  {RETAINED_DEBTORS.length} accounts · Carried from May 2026
                </span>
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  · {formatINR(RETAINED_DEBTORS.reduce((s, d) => s + d.loanAmount, 0))} outstanding
                </span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-violet-500 transition-transform duration-200 ml-1",
                    retainedOpen && "rotate-180",
                  )}
                />
              </button>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    const headers = [
                      "Name",
                      "Loan ID",
                      "Phone",
                      "Loan Amount",
                      "DPD",
                      "Prev Outcome",
                      "PTP Amount",
                      "Portfolio",
                      "Note",
                    ];
                    const rows = RETAINED_DEBTORS.map((d) => [
                      d.name,
                      d.id,
                      d.phone,
                      d.loanAmount,
                      d.dpd,
                      d.prevOutcome,
                      d.ptpAmount ?? "",
                      d.portfolio,
                      d.note,
                    ]);
                    const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
                    const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "retained-debtors.csv";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="inline-flex items-center gap-1 h-7 rounded-md border border-violet-400/30 bg-card px-2 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  Export
                </button>
                <Nav
                  to="/dashboard/call-queue"
                  className="inline-flex items-center gap-1 h-7 rounded-md border border-violet-400/30 bg-card px-2 text-xs text-violet-600 hover:text-violet-700 transition-all"
                >
                  Queue <ExternalLink className="h-3 w-3" />
                </Nav>
              </div>
            </div>

            {/* Expandable content */}
            {retainedOpen && (
              <div className="border-t border-violet-400/20">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-violet-500/5">
                      <TableRow>
                        <TableHead>Debtor</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead>DPD</TableHead>
                        <TableHead>Last Outcome</TableHead>
                        <TableHead>PTP</TableHead>
                        <TableHead>Carry Type</TableHead>
                        <TableHead className="min-w-[160px]">Notes</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {RETAINED_DEBTORS.map((d, i) => (
                        <TableRow
                          key={d.id}
                          className="hover:bg-violet-500/5 align-top"
                          style={{ animationDelay: `${i * 40}ms` }}
                        >
                          <TableCell>
                            <div className="font-medium text-sm text-foreground">{d.name}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {d.id} · {d.portfolio}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-foreground">
                            {d.phone}
                          </TableCell>
                          <TableCell className="text-right font-medium text-sm">
                            {formatINR(d.loanAmount)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-xs font-medium",
                                d.dpd < 30
                                  ? "bg-success/8 text-success/70 border-success/15"
                                  : d.dpd < 60
                                    ? "bg-warning/8 text-warning-foreground/70 border-warning/15"
                                    : "bg-destructive/8 text-destructive/70 border-destructive/15",
                              )}
                            >
                              {d.dpd}d
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={cn("text-xs", PREV_OUTCOME_CLS[d.prevOutcome] ?? "")}
                            >
                              {d.prevOutcome}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">
                            {d.ptpAmount ? (
                              <span className="font-semibold text-blue-600">
                                {formatINR(d.ptpAmount)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">{d.retained}</span>
                          </TableCell>
                          <TableCell>
                            <p className="text-xs text-foreground/80 leading-relaxed max-w-[160px]">
                              {d.note}
                            </p>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button size="sm" className="h-7 px-2 text-xs gap-1 active:scale-95">
                                <Phone className="h-3 w-3" />
                                Call
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground active:scale-95"
                              >
                                <RefreshCcw className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Performance vs Target ── */}
        <section>
          <div className="flex items-center justify-between">
            <SectionLabel>My Performance vs Target · Today</SectionLabel>
            <span className="text-[11px] text-muted-foreground">
              Targets set by{" "}
              <span className="font-medium text-foreground">Sanjay M. (Manager)</span>
            </span>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {(
              [
                {
                  key: "calls",
                  label: "Calls",
                  target: DAILY_TARGETS.calls.target,
                  actual: DAILY_TARGETS.calls.actual,
                  fmt: (v: number) => String(v),
                  filter: "all" as const,
                },
                {
                  key: "ptpCount",
                  label: "PTPs",
                  target: DAILY_TARGETS.ptpCount.target,
                  actual: DAILY_TARGETS.ptpCount.actual,
                  fmt: (v: number) => String(v),
                  filter: "ptp" as const,
                },
                {
                  key: "ptpAmount",
                  label: "PTP ₹",
                  target: DAILY_TARGETS.ptpAmount.target,
                  actual: DAILY_TARGETS.ptpAmount.actual,
                  fmt: (v: number) => formatINR(v),
                  filter: "ptp" as const,
                },
                {
                  key: "collections",
                  label: "Collected",
                  target: DAILY_TARGETS.collections.target,
                  actual: DAILY_TARGETS.collections.actual,
                  fmt: (v: number) => formatINR(v),
                  filter: "paid" as const,
                },
                {
                  key: "talkTime",
                  label: "Talk Time",
                  target: DAILY_TARGETS.talkTime.target,
                  actual: DAILY_TARGETS.talkTime.actual,
                  fmt: (v: number) => fmtMins(v),
                  filter: "all" as const,
                },
                {
                  key: "contactRate",
                  label: "Contact %",
                  target: DAILY_TARGETS.contactRate.target,
                  actual: DAILY_TARGETS.contactRate.actual,
                  fmt: (v: number) => `${v}%`,
                  filter: "all" as const,
                },
              ] as const
            ).map((item, i) => {
              const pct = Math.min(Math.round((item.actual / item.target) * 100), 100);
              const done = pct >= 100;
              return (
                <Nav
                  key={item.key}
                  to="/dashboard/call-queue"
                  search={{ filter: item.filter }}
                  className="animate-in fade-in duration-400 rounded-xl border border-border bg-card p-3 transition-all hover:border-foreground/30 hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  style={{ animationDelay: `${i * 50}ms` }}
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    {item.label}
                  </div>
                  <div className="text-base font-bold leading-tight text-foreground">
                    {item.fmt(item.actual)}
                  </div>
                  <div className="text-[10px] text-muted-foreground mb-1.5">
                    of {item.fmt(item.target)}
                  </div>
                  <div className="h-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        done ? "bg-foreground" : "bg-foreground/50",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div
                    className={cn(
                      "text-[10px] mt-0.5",
                      done ? "text-foreground font-medium" : "text-muted-foreground",
                    )}
                  >
                    {done ? "✓ Done" : `${pct}%`}
                  </div>
                </Nav>
              );
            })}
          </div>
        </section>
      </div>
    </InteractiveContext.Provider>
  );
}

// ─── Time segment config ───────────────────────────────────────────────────────

const TIME_SEGMENTS: {
  key: keyof typeof TIME_TRACKING;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  barCls: string;
  textCls: string;
  dot: string;
}[] = [
  {
    key: "talking",
    label: "Talking",
    desc: "Connected call time",
    icon: Phone,
    barCls: "bg-success",
    textCls: "text-success",
    dot: "bg-success",
  },
  {
    key: "ringing",
    label: "Ringing",
    desc: "Dialing + waiting",
    icon: PhoneCall,
    barCls: "bg-blue-500",
    textCls: "text-blue-500",
    dot: "bg-blue-500",
  },
  {
    key: "online",
    label: "Online",
    desc: "Predictive dialer running",
    icon: Wifi,
    barCls: "bg-violet-500",
    textCls: "text-violet-500",
    dot: "bg-violet-500",
  },
  {
    key: "feedback",
    label: "Feedback",
    desc: "Logging outcomes & notes",
    icon: FileText,
    barCls: "bg-amber-400",
    textCls: "text-amber-500",
    dot: "bg-amber-400",
  },
  {
    key: "breakTime",
    label: "Break",
    desc: "Agent on break",
    icon: Coffee,
    barCls: "bg-orange-400",
    textCls: "text-orange-500",
    dot: "bg-orange-400",
  },
  {
    key: "idle",
    label: "Idle",
    desc: "No activity detected",
    icon: ZapOff,
    barCls: "bg-muted-foreground/40",
    textCls: "text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground whitespace-nowrap">
        {children}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

function KPICard({
  label,
  value,
  hint,
  icon: Icon,
  index,
  highlight,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  index: number;
  highlight?: boolean;
}) {
  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground leading-tight">
          {label}
        </CardTitle>
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "text-xl font-bold leading-tight",
            highlight ? "text-foreground" : "text-foreground",
          )}
        >
          {value}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function QueueCard({
  label,
  value,
  sub,
  icon: Icon,
  index,
}: {
  label: string;
  value: number | string;
  sub: string;
  icon: React.ComponentType<{ className?: string }>;
  index: number;
}) {
  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <CardContent className="flex items-center gap-4 p-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted flex-shrink-0">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <div className="text-2xl font-bold text-foreground">{value}</div>
          <div className="text-xs font-medium text-foreground leading-tight">{label}</div>
          <div className="text-[11px] text-muted-foreground">{sub}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function TimeRow({
  icon: Icon,
  label,
  desc,
  mins,
  pct,
  barCls,
  textCls,
  dot,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  desc: string;
  mins: number;
  pct: number;
  barCls: string;
  textCls: string;
  dot: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-full flex-shrink-0", dot)} />
          <Icon className={cn("h-3.5 w-3.5", textCls)} />
          <span className={cn("text-sm font-medium", textCls)}>{label}</span>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· {desc}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("text-sm font-semibold tabular-nums", textCls)}>{fmtMins(mins)}</span>
          <span className="text-[11px] text-muted-foreground w-8 text-right">{pct}%</span>
        </div>
      </div>
      <Progress value={pct} className="h-1.5" indicatorClassName={barCls} />
    </div>
  );
}
