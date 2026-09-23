import { createFileRoute } from "@tanstack/react-router";
import { createContext, useContext, useState, useEffect, useMemo } from "react";
import {
  PhoneCall,
  PhoneIncoming,
  HandCoins,
  IndianRupee,
  CheckCircle2,
  Phone,
  Clock,
  Users,
  ExternalLink,
  CalendarDays,
  LogIn,
  LogOut,
  Timer,
  ClipboardList,
  Coffee,
  Info,
  Target,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { formatINR } from "@/lib/mock-debtors";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import {
  getAgentDispositions,
  calcStats,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";
import {
  getAgentTimeStats,
  formatDurationOrDash,
  formatDuration,
  formatClockTime,
  pctOfShift,
} from "@/lib/agent-time-stats";
import { getAgentBook, refreshAgentBooks } from "@/lib/agent-book-store";
import { getPayments, refreshPayments, type PaymentRecord } from "@/lib/payments-store";
import { MonthlyTrendCompact } from "@/components/reports/monthly-trend";
import { computeDrr, monthDays } from "@/lib/daily-run-rate";
import {
  fetchStatusIntervals,
  todayPresenceKey,
  type StatusInterval,
} from "@/lib/agent-presence-store";
import { useStorageSync } from "@/lib/storage-sync";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Agent Dashboard · SamvadX" },
      { name: "description", content: "Agent dashboard with KPIs and today's summary." },
    ],
  }),
  component: AgentDashboard,
});

type Period = "today" | "month" | "custom";

// Per-metric targets a manager sets for an agent. Only `calls` has a real backing column
// (agents.daily_target) — fetched live in useAgentPeriodStats. The rest are placeholder
// defaults until a real per-metric target-setting feature exists; "actual" values next to
// them are real, only the targets are not.
const TARGETS = {
  calls: 80, // overwritten with the real agents.daily_target once fetched
  ptpCount: 18,
  ptpAmount: 350000,
  collections: 80000,
  talkTime: 240,
  contactRate: 75,
};

function isSameDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
function isSameMonth(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

/** Mon-Fri days in `now`'s month, and how many of them have happened (today counts). Used to
 * scale the daily targets when the period toggle is on This Month — there is no monthly target
 * field anywhere, so a month figure has to be derived from the daily one. Sundays/Saturdays
 * are excluded because the daily target is a working-day target. */
function workingDaysInMonth(now: Date): { total: number; elapsed: number } {
  const year = now.getFullYear(),
    month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  let total = 0,
    elapsed = 0;
  for (let day = 1; day <= lastDay; day++) {
    const dow = new Date(year, month, day).getDay();
    if (dow === 0 || dow === 6) continue;
    total++;
    if (day <= now.getDate()) elapsed++;
  }
  return { total, elapsed: Math.max(elapsed, 1) };
}

/** calcStats() (disposition-store.ts) covers total/ptps/paid/ptpAmount/paidAmount/contactRate;
 * callback count and talk time aren't part of that shared shape, so they're added here. */
function extendedStats(disps: DispositionRecord[]) {
  const base = calcStats(disps);
  const callbacks = disps.filter((d) => d.outcome === "callback").length;
  const talkTimeMins = Math.round(disps.reduce((s, d) => s + (d.durationSeconds ?? 0), 0) / 60);
  return { ...base, callbacks, talkTimeMins };
}

type PeriodStats = ReturnType<typeof extendedStats>;

/** Real, Supabase-backed KPIs for the logged-in agent — replaces the old hardcoded
 * KPI_BY_PERIOD/PORTFOLIO_TOTAL_PRINCIPAL constants. Same cache-first + event-subscription
 * pattern as manager.index.tsx's useTeamStats. */
/**
 * This agent's whole call log and their credited payments — the two tables the month-over-month
 * tile compares. Deliberately unfiltered by date: monthly-trend.ts owns the windowing, and
 * pre-filtering here to the current month would leave last month's line with nothing to draw.
 *
 * Payments are matched on agentId, so a bank-reported paid-file row (which credits nobody)
 * stays out of an agent's own figures — same rule as every other per-agent total in the app.
 */
function useAgentTrendData(agentId: string) {
  const compute = () => ({
    disps: agentId ? getAgentDispositions(agentId) : [],
    payments: agentId ? getPayments().filter((p) => p.agentId === agentId) : [],
  });

  const [data, setData] = useState<{ disps: DispositionRecord[]; payments: PaymentRecord[] }>(
    compute,
  );
  useEffect(() => {
    const reload = () => setData(compute());
    reload();
    window.addEventListener("dispositions-updated", reload);
    window.addEventListener("payments-updated", reload);
    refreshDispositions();
    refreshPayments();
    return () => {
      window.removeEventListener("dispositions-updated", reload);
      window.removeEventListener("payments-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  return data;
}

function useAgentPeriodStats(agentId: string) {
  const compute = () => {
    const now = new Date();
    const disps = agentId ? getAgentDispositions(agentId) : [];
    const today = extendedStats(disps.filter((d) => isSameDay(d.time, now)));
    const month = extendedStats(disps.filter((d) => isSameMonth(d.time, now)));

    // Summed in the database (agent-book-store.ts), not by downloading every debtor row.
    const book = agentId ? getAgentBook(agentId) : null;
    const assignedPOS = book?.assignedPos ?? 0;
    // Real, from portfolio_agent_targets — read as a MONTHLY figure (see daily-run-rate.ts).
    return { today, month, assignedPOS, monthlyTarget: book?.monthlyTarget ?? 0 };
  };

  const [stats, setStats] = useState(compute);
  useEffect(() => {
    const reload = () => setStats(compute());
    reload();
    // A write anywhere in the app (reassignment, upload) still fires portfolios-updated; the
    // totals are re-read from the database then, rather than recomputed from a full sync.
    const refetchBook = () => void refreshAgentBooks([agentId]);
    window.addEventListener("dispositions-updated", reload);
    window.addEventListener("agent-books-updated", reload);
    window.addEventListener("portfolios-updated", refetchBook);
    refreshDispositions();
    refetchBook();
    return () => {
      window.removeEventListener("dispositions-updated", reload);
      window.removeEventListener("agent-books-updated", reload);
      window.removeEventListener("portfolios-updated", refetchBook);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  useStorageSync(() => setStats(compute()));
  return stats;
}

/** The one field with a real per-agent target column (agents.daily_target). */
function useDailyCallTarget(authUserId: string | undefined): number {
  const [target, setTarget] = useState(TARGETS.calls);
  useEffect(() => {
    if (!authUserId) return;
    supabase
      .from("agents")
      .select("daily_target")
      .eq("auth_user_id", authUserId)
      .single()
      .then(({ data }) => {
        if (data?.daily_target) setTarget(data.daily_target as number);
      });
  }, [authUserId]);
  return target;
}

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
export function AgentDashboardContent({
  agentId: agentIdProp,
  interactive = true,
}: {
  /** Whose dashboard to render. Defaults to the signed-in user.
   *
   * The manager's Agent Live View passed only `interactive={false}` and no id, so this
   * resolved the agent from useAuth() — a manager saw THEIR OWN dashboard under the selected
   * agent's name, directly beneath KPI cards that were genuinely that agent's. Half the
   * screen was one person, half another. */
  agentId?: string;
  interactive?: boolean;
}) {
  const [period, setPeriod] = useState<Period>("today");
  const [customDate, setCustomDate] = useState("");

  const { user } = useAuth();
  const agentId = agentIdProp ?? user?.email ?? user?.id ?? "";
  /** agents.daily_target is looked up by auth user id, which we do not have for a mirrored
   * agent — fall back to the default target rather than showing the viewer's own. */
  const isSelf = !agentIdProp || agentIdProp === (user?.email ?? user?.id);
  const dailyCallTarget = useDailyCallTarget(isSelf ? user?.id : undefined);
  const { today, month, assignedPOS, monthlyTarget } = useAgentPeriodStats(agentId);
  const trendData = useAgentTrendData(agentId);

  // Today's raw call logs, for the time-breakdown panel below — calling time is computed
  // straight from these (real); everything else getAgentTimeStats derives is a placeholder
  // pending a real presence/status-log table (see agent-time-stats.ts).
  const todayDisps = useMemo(
    () =>
      agentId ? getAgentDispositions(agentId).filter((d) => isSameDay(d.time, new Date())) : [],
    [agentId, today],
  );
  // Presence intervals make break/idle/login real; without them getAgentTimeStats returns
  // nulls, which render as "—" rather than as invented figures.
  const [presence, setPresence] = useState<StatusInterval[]>([]);
  useEffect(() => {
    if (!agentId) return;
    fetchStatusIntervals([agentId], todayPresenceKey())
      .then(setPresence)
      .catch(() => setPresence([]));
  }, [agentId, todayDisps]);
  const myTimeStats = useMemo(
    () => getAgentTimeStats(agentId, todayDisps, todayPresenceKey(), presence),
    [agentId, todayDisps, presence],
  );

  // "custom" used to have nothing behind it — it silently showed today's numbers under the
  // chosen date's label. Harmless while only the Performance block followed the toggle;
  // actively misleading now that Collections and vs-Target do too. The dispositions are all
  // in the cache already, so filtering them to the picked day is the whole implementation.
  const customStats = useMemo(() => {
    if (period !== "custom" || !customDate || !agentId) return null;
    const picked = new Date(`${customDate}T00:00:00`);
    if (Number.isNaN(picked.getTime())) return null;
    return extendedStats(getAgentDispositions(agentId).filter((d) => isSameDay(d.time, picked)));
    // `today` is in deps so this recomputes when the dispositions cache refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customDate, agentId, today]);

  const periodStats = period === "month" ? month : (customStats ?? today);
  const isMonth = period === "month";
  const periodLabel = period === "today" ? "Today" : isMonth ? "This Month" : customDate || "—";

  // Every target in TARGETS (and agents.daily_target) is a DAILY figure, so comparing a whole
  // month's actuals against them read as 1000%+ complete. Scale them by the month's working
  // days when the toggle is on This Month; `contactRate` is deliberately excluded everywhere
  // below because it is a rate, not a total, and must not be multiplied.
  const wd = workingDaysInMonth(new Date());
  const scaleTarget = (dailyTarget: number) => (isMonth ? dailyTarget * wd.total : dailyTarget);

  const kpi = {
    totalCalling: periodStats.total,
    totalCallback: periodStats.callbacks,
    todayPTP: periodStats.ptps,
    totalPTPAmount: periodStats.ptpAmount,
    todayPaid: periodStats.paid,
    todayPaidAmount: periodStats.paidAmount,
  };

  // Today's PTP generation — always today's stock, independent of the period toggle
  const todayGeneration = { count: today.ptps, ptpAmount: today.ptpAmount };

  // Hoisted out of the Collections block below so the Performance card's "To Collect" tile
  // measures against the SAME number the DRR tile shows. Two independent computeDrr() calls
  // would be free to drift apart on one screen.
  const drr = computeDrr(monthlyTarget, month.paidAmount);

  const projectedRecovery = kpi.totalPTPAmount + kpi.todayPaidAmount;
  // How much is still needed today to close in on today's DRR ask — surfaced as a
  // "To Collect" tile on the Performance card.
  const remainingToday = drr.drr !== null ? Math.max(0, drr.drr - today.paidAmount) : null;

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
                  onClick={() => setPeriod(p)}
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

        {/* ── Collections: Target / Shortfall / DRR / EOD Projection ── */}
        {(() => {
          // DRR is inherently a MONTHLY measure, so it always reads the month's collections —
          // never periodStats, which follows the Today/Month toggle. Flipping the view must not
          // change what the month still demands of you.
          const hasTarget = drr.drr !== null;
          const md = monthDays();
          const actual = periodStats.paidAmount; // real, from call_logs
          // Today: 6.5hrs-into-a-9hr-shift, a simplifying assumption — there's no real
          // shift-start tracking to compute "hours elapsed so far" from. Month: pace across the
          // working days elapsed so far, projected over the whole month.
          const projection = isMonth
            ? Math.round((actual / wd.elapsed) * wd.total)
            : Math.round((actual / 6.5) * 9);
          // What the projection is judged against: the month's target, or today's DRR ask.
          const projectionTarget = isMonth ? drr.target : (drr.drr ?? 0);
          const DASH = "—"; // "no target set" — deliberately not rendered as ₹0, which reads
          // as "nothing left to do".
          return (
            <div className="space-y-2">
              <SectionLabel>Collections · {periodLabel}</SectionLabel>
              <div className="grid grid-cols-4 gap-2">
                {[
                  {
                    label: "Target",
                    value: hasTarget ? formatINR(isMonth ? drr.target : drr.drr!) : DASH,
                    sub: hasTarget
                      ? isMonth
                        ? `${md.total} days · month`
                        : "required today"
                      : "no monthly target set",
                    cls: "text-foreground",
                    bar: null,
                    filter: "paid" as const,
                  },
                  {
                    label: "Shortfall",
                    value: hasTarget ? formatINR(drr.shortfall) : DASH,
                    sub: hasTarget ? "gap to close this month" : "needs a target",
                    cls: !hasTarget
                      ? "text-muted-foreground"
                      : drr.met
                        ? "text-success"
                        : "text-destructive",
                    bar: null,
                    filter: "all" as const,
                  },
                  {
                    // Replaces the old "Run Rate" tile, which was a projection — and rendered
                    // the exact same value as the projection tile beside it. DRR is the
                    // opposite question: not where today's pace lands, but what the days left
                    // must each deliver. It climbs as the month runs out.
                    label: "DRR",
                    value: hasTarget ? formatINR(drr.drr!) : DASH,
                    sub: hasTarget
                      ? drr.met
                        ? "target met"
                        : `per day · ${drr.daysRemaining} left`
                      : "set a portfolio target",
                    cls: hasTarget && !drr.met ? "text-amber-500" : "text-muted-foreground",
                    bar: null,
                    filter: "all" as const,
                  },
                  {
                    label: isMonth ? "Month Projection" : "EOD Projection",
                    value: formatINR(projection),
                    sub: isMonth ? "est. month end · at this pace" : "est. end of day",
                    cls: !hasTarget
                      ? "text-foreground"
                      : projection >= projectionTarget
                        ? "text-success"
                        : "text-destructive",
                    bar: hasTarget && projectionTarget > 0 ? projection / projectionTarget : null,
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
                Performance · {periodLabel}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
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
                {
                  // The delivery gap: how much more today has to bring in to close in on
                  // today's DRR ask (and, in turn, the month's projection). Always shown
                  // green — it's a call to action, not a pass/fail readout.
                  label: "To Collect",
                  value: remainingToday === null ? "—" : formatINR(remainingToday),
                  hint: remainingToday === null ? "no target set" : "to hit today's projection",
                  icon: Target,
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
            <div className="flex-1 grid grid-cols-2 gap-2">
              <Nav
                to="/dashboard/call-queue"
                search={{ filter: "all" }}
                className="rounded-lg border border-border bg-muted/20 p-2.5 text-center flex flex-col justify-center transition-all hover:border-foreground/30 hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <div className="text-base font-bold text-foreground tabular-nums leading-tight">
                  {formatINR(assignedPOS)}
                </div>
                <div className="text-[10px] font-medium text-foreground leading-tight mt-1">
                  Total Principal
                </div>
                <div className="text-[9px] text-muted-foreground leading-tight">
                  assigned to you
                </div>
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
                className="col-span-2 rounded-lg border border-blue-400/30 bg-blue-500/5 p-2.5 text-center flex flex-col justify-center transition-all hover:border-blue-400/50 hover:shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
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

        {/* ── Performance vs Target ── */}
        <section>
          <div className="flex items-center justify-between">
            <SectionLabel>My Performance vs Target · {periodLabel}</SectionLabel>
            {/* Only the call target is real (agents.daily_target). The other five are constants
                in TARGETS above — claiming a manager set them is simply false, and it sits
                directly under a DRR tile that correctly says no target is set. */}
            <span className="text-[11px] text-muted-foreground">
              Calls target is set by your manager · the rest are placeholder defaults
            </span>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {(
              [
                {
                  key: "calls",
                  label: "Calls",
                  target: scaleTarget(dailyCallTarget), // real — agents.daily_target
                  actual: periodStats.total,
                  fmt: (v: number) => String(v),
                  filter: "all" as const,
                },
                {
                  key: "ptpCount",
                  label: "PTPs",
                  target: scaleTarget(TARGETS.ptpCount), // no real per-metric target field yet
                  actual: periodStats.ptps,
                  fmt: (v: number) => String(v),
                  filter: "ptp" as const,
                },
                {
                  key: "ptpAmount",
                  label: "PTP ₹",
                  target: scaleTarget(TARGETS.ptpAmount),
                  actual: periodStats.ptpAmount,
                  fmt: (v: number) => formatINR(v),
                  filter: "ptp" as const,
                },
                {
                  key: "collections",
                  label: "Collected",
                  target: scaleTarget(TARGETS.collections),
                  actual: periodStats.paidAmount,
                  fmt: (v: number) => formatINR(v),
                  filter: "paid" as const,
                },
                {
                  key: "talkTime",
                  label: "Talk Time",
                  target: scaleTarget(TARGETS.talkTime),
                  actual: periodStats.talkTimeMins,
                  fmt: (v: number) => fmtMins(v),
                  filter: "all" as const,
                },
                {
                  key: "contactRate",
                  label: "Contact %",
                  // NOT scaled — a rate, not a total. Multiplying it by working days would
                  // make the month target 75% x 22 = 1650%.
                  target: TARGETS.contactRate,
                  actual: periodStats.contactRate,
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

        {/* ── Activity + month-over-month trend, side by side on wide screens ── */}
        <div className="flex flex-col gap-4 lg:flex-row">
          {/* ── My Activity Today: ringing / calling / disposition / idle, as progress bars ── */}
          <div className="rounded-xl border border-border bg-card p-3 lg:w-1/2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                My Activity Today
              </span>
              {/* These were estimates until time tracking landed; they are measured now. The
                  badge only appears when nothing was RECORDED for the day, which is a different
                  statement and the one that is still true. */}
              {!myTimeStats.presenceRecorded && (
                <span
                  className="flex items-center gap-1 text-[10px] text-amber-500"
                  title="Your status has not been recorded yet today, so break and idle cannot be calculated. Talk time is always measured."
                >
                  <Info className="h-3 w-3" />
                  Not recorded yet
                </span>
              )}
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-3 pb-2 border-b border-border">
              <span className="flex items-center gap-1">
                <LogIn className="h-3 w-3" />
                {myTimeStats.loginTime ? formatClockTime(myTimeStats.loginTime) : "—"}
              </span>
              <span className="text-foreground font-medium">
                {formatDurationOrDash(myTimeStats.loggedInSeconds)} logged in
              </span>
              {myTimeStats.logoutTime ? (
                <span className="flex items-center gap-1">
                  <LogOut className="h-3 w-3" />
                  {formatClockTime(myTimeStats.logoutTime)}
                </span>
              ) : myTimeStats.presenceRecorded ? (
                <span className="flex items-center gap-1 text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                  Active
                </span>
              ) : (
                // No logout because nothing was recorded — not because the agent is on shift.
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div className="space-y-2.5">
              {[
                {
                  label: "Ringing",
                  seconds: myTimeStats.ringingSeconds,
                  icon: PhoneIncoming,
                  cls: "bg-blue-500",
                },
                {
                  label: "Calling",
                  seconds: myTimeStats.callingSeconds,
                  icon: PhoneCall,
                  cls: "bg-primary",
                },
                {
                  label: "Disposition",
                  seconds: myTimeStats.dispositionSeconds,
                  icon: ClipboardList,
                  cls: "bg-amber-500",
                },
                {
                  label: "Break",
                  seconds: myTimeStats.breakSeconds,
                  icon: Coffee,
                  cls: "bg-orange-400",
                },
                {
                  label: "Idle",
                  seconds: myTimeStats.idleSeconds,
                  icon: Timer,
                  cls: "bg-muted-foreground/40",
                },
              ].map(({ label, seconds, icon: Icon, cls }) => {
                const pct = pctOfShift(seconds, myTimeStats);
                return (
                  <div key={label}>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Icon className="h-3 w-3" />
                        {label}
                      </span>
                      <span className="font-medium text-foreground tabular-nums">
                        {formatDurationOrDash(seconds)}{" "}
                        <span className="text-muted-foreground">({pct}%)</span>
                      </span>
                    </div>
                    <Progress value={pct} className="h-1.5" indicatorClassName={cls} />
                  </div>
                );
              })}
            </div>
          </div>

          <MonthlyTrendCompact
            disps={trendData.disps}
            payments={trendData.payments}
            className="lg:w-1/2"
            footer={
              <Nav
                to="/dashboard/reports"
                className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Full monthly trend in Reports →
              </Nav>
            }
          />
        </div>
      </div>
    </InteractiveContext.Provider>
  );
}

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
