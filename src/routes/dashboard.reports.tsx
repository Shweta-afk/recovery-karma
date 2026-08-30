import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Download,
  BarChart2,
  Activity,
  TrendingUp,
  HandCoins,
  PieChart as PieChartIcon,
  Info,
  PhoneCall,
  IndianRupee,
  Target,
  AlertTriangle,
  CalendarRange,
  Clock3,
  type LucideIcon,
} from "lucide-react";
import {
  ComposedChart,
  BarChart,
  Bar,
  LineChart,
  Line,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import {
  getAgentDispositions,
  refreshDispositions,
  calcStats,
  getPtpFollowups,
  type DispositionRecord,
  type PtpFollowup,
} from "@/lib/disposition-store";
import { getAgentDebtorIds, getPortfolios, refreshPortfolios } from "@/lib/portfolio-store";
import { getPayments, refreshPayments, type PaymentRecord } from "@/lib/payments-store";
import { getAgentTimeStats, formatDuration, formatDurationOrDash } from "@/lib/agent-time-stats";
import { MonthlyTrendPanel } from "@/components/reports/monthly-trend";
import { compareMonths, dailySeries, deltaPct, istDayKey } from "@/lib/monthly-trend";
import { formatINR, type DPDBucket } from "@/lib/mock-debtors";
import { downloadCsv } from "@/lib/csv-export";
import { DateRangeFilter } from "@/components/date-range-filter";
import { fetchStatusIntervalsRange, type StatusInterval } from "@/lib/agent-presence-store";
import { OutcomeBreakdown, OUTCOME_LABELS } from "@/components/reports/outcome-breakdown";
import { Stat } from "@/components/reports/stat-card";

export const Route = createFileRoute("/dashboard/reports")({
  head: () => ({ meta: [{ title: "Reports · SamvadX" }] }),
  component: ReportsPage,
});

// ─── date-range helpers ────────────────────────────────────────────────────────

/**
 * The IST calendar day for a Date — NOT `toISOString().slice(0, 10)`, which this page used to
 * use and which reports the **UTC** day.
 *
 * Two separate bugs came from that. A call logged at 00:30 IST is 19:00 UTC the previous day,
 * so it was counted against yesterday in every daily chart, range filter and CSV export. And
 * `enumerateDays` builds Dates from `${from}T00:00:00`, i.e. LOCAL midnight — for a viewer in
 * IST that is 18:30 UTC the day before, so the chart's own day labels were shifted back one.
 *
 * Going through istDayKey fixes both and, more importantly, makes this page agree with
 * MonthlyTrendPanel rendered directly beneath it, which was already IST-bucketed. One screen
 * showing two different definitions of "a day" is worse than either definition alone.
 */
function isoDay(d: Date): string {
  return istDayKey(d.toISOString());
}
function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return isoDay(d);
}
function defaultTo(): string {
  return isoDay(new Date());
}
function inRange(iso: string, from: string, to: string): boolean {
  const day = istDayKey(iso);
  return Boolean(day) && day >= from && day <= to;
}
// Capped so a fat-fingered multi-year range can't render a chart with thousands of bars.
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  let guard = 0;
  while (cur <= end && guard < 90) {
    days.push(isoDay(cur));
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return days;
}
function formatDayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}
function formatRangeLabel(from: string, to: string): string {
  return `${formatDayLabel(from)} – ${formatDayLabel(to)}`;
}

const CHART_COLORS = {
  primary: "oklch(0.58 0.18 258)",
  success: "oklch(0.65 0.16 152)",
  warning: "oklch(0.72 0.18 75)",
  destructive: "oklch(0.58 0.22 27)",
  muted: "oklch(0.25 0.03 258)",
};

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "oklch(0.15 0.025 258)",
    border: "1px solid oklch(0.25 0.03 258)",
    borderRadius: 6,
    fontSize: 11,
  },
  labelStyle: { color: "oklch(0.96 0.005 250)" },
  itemStyle: { color: "oklch(0.85 0.01 250)" },
};

const AXIS_TICK = { fontSize: 10, fill: "oklch(0.55 0.02 257)" };

// ─── report definitions ─────────────────────────────────────────────────────────

type ReportType =
  | "weekly"
  | "monthly"
  | "portfolio"
  | "performance"
  | "time"
  | "outcomes"
  | "followups";

interface ReportDef {
  id: ReportType;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Whether the from/to picker applies to this report, or it's always a live snapshot. */
  dateFiltered: boolean;
}

const REPORTS: ReportDef[] = [
  {
    id: "weekly",
    label: "Collections Summary",
    icon: BarChart2,
    description: "Calls, PTPs, and amount collected by day.",
    dateFiltered: true,
  },
  {
    id: "monthly",
    label: "Monthly Trend",
    icon: CalendarRange,
    description: "This month against last month, day by day.",
    dateFiltered: false,
  },
  {
    id: "portfolio",
    label: "Portfolio Health",
    icon: Activity,
    description: "Principal, DPD mix, and how much of each book you actually worked.",
    // Was false when this was a pure snapshot. It now carries collected / accounts-touched
    // columns that only mean anything against a date range, so the picker has to apply.
    dateFiltered: true,
  },
  {
    id: "performance",
    label: "My Performance",
    icon: TrendingUp,
    description: "Contact rate and PTP conversion trend.",
    dateFiltered: true,
  },
  {
    id: "time",
    label: "Time & Effort",
    icon: Clock3,
    description: "Talk, ringing, wrap, break and idle per day — measured.",
    dateFiltered: true,
  },
  {
    id: "outcomes",
    label: "Outcome Breakdown",
    icon: PieChartIcon,
    description: "How your logged calls resolve.",
    dateFiltered: true,
  },
  {
    id: "followups",
    label: "PTP Follow-ups",
    icon: HandCoins,
    description: "Open promises, ranked by urgency.",
    dateFiltered: false,
  },
];

const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];
const BUCKET_SHORT: Record<DPDBucket, string> = {
  X: "Current",
  "1": "1–30 DPD",
  "2": "31–90 DPD",
  NPA: "91–179 DPD",
  WriteOff: "180+ DPD",
};
const BUCKET_FILL: Record<DPDBucket, string> = {
  X: CHART_COLORS.success,
  "1": CHART_COLORS.primary,
  "2": CHART_COLORS.warning,
  NPA: CHART_COLORS.destructive,
  WriteOff: "oklch(0.45 0.02 257)",
};

// ─── data aggregation ────────────────────────────────────────────────────────────

interface DailyRow {
  day: string;
  label: string;
  calls: number;
  ptps: number;
  collected: number;
  contactRate: number;
  ptpRate: number;
}

function computeDaily(disps: DispositionRecord[], days: string[]): DailyRow[] {
  return days.map((day) => {
    const dayDisps = disps.filter((d) => istDayKey(d.time) === day);
    const stats = calcStats(dayDisps);
    return {
      day,
      label: formatDayLabel(day),
      calls: stats.total,
      ptps: stats.ptps,
      collected: stats.paidAmount,
      contactRate: stats.contactRate,
      ptpRate: stats.total > 0 ? Math.round((stats.ptps / stats.total) * 100) : 0,
    };
  });
}

interface PortfolioHealthRow {
  name: string;
  total: number;
  /** Principal on the book for these accounts. NOTE: `debtors.outstanding_balance` is written
   * as a straight COPY of `loan_amount` at upload (three sites in portfolio-store.ts), so
   * principal and outstanding are the same number in this system today. Shown once and
   * labelled "Principal (POS)" rather than as two columns implying a distinction the data
   * does not have — that would be a fabricated breakdown. Splitting them for real needs the
   * bank's file to carry a separate outstanding column. */
  outstanding: number;
  /** ₹ collected against this portfolio inside the selected range. */
  collected: number;
  /** Distinct accounts in this portfolio worked at least once in the range — NOT call count.
   * 40 calls into 12 accounts is a very different week from 40 into 40. */
  accountsTouched: number;
  bucketCount: Record<DPDBucket, number>;
  bucketPct: Record<DPDBucket, number>;
}

function computePortfolioHealth(
  agentId: string,
  rangeDisps: DispositionRecord[],
): PortfolioHealthRow[] {
  const slices = getAgentDebtorIds(agentId);
  const portfolios = getPortfolios();
  const rows: PortfolioHealthRow[] = [];
  for (const { portfolioId, debtorIds } of slices) {
    const p = portfolios.find((p) => p.id === portfolioId);
    if (!p) continue;
    const idSet = new Set(debtorIds);
    const myRows = p.rows.filter((r) => idSet.has(r.id));
    const total = myRows.length;
    if (total === 0) continue;
    const bucketCount = { X: 0, "1": 0, "2": 0, NPA: 0, WriteOff: 0 } as Record<DPDBucket, number>;
    let outstanding = 0;
    for (const r of myRows) {
      bucketCount[r.bucket] = (bucketCount[r.bucket] ?? 0) + 1;
      outstanding += r.loanAmount || 0;
    }
    const bucketPct = Object.fromEntries(
      BUCKET_ORDER.map((b) => [b, Math.round((bucketCount[b] / total) * 100)]),
    ) as Record<DPDBucket, number>;

    // Scoped to the accounts of THIS portfolio that belong to this agent, so the collected
    // figure and the outstanding figure beside it describe the same set of accounts.
    const mine = rangeDisps.filter((d) => idSet.has(d.debtorId));
    const collected = mine.reduce((sum, d) => sum + (d.paidAmount ?? 0), 0);
    const accountsTouched = new Set(mine.map((d) => d.debtorId)).size;

    rows.push({
      name: p.name,
      total,
      outstanding,
      collected,
      accountsTouched,
      bucketCount,
      bucketPct,
    });
  }
  return rows.sort((a, b) => b.total - a.total);
}

// ─── time & effort ──────────────────────────────────────────────────────────────
//
// Every column here is MEASURED as of 20260830_agent_time_tracking.sql:
//   talk    Σ call_logs.duration_seconds
//   ringing Σ call_logs.ring_seconds     — stamped by the dialer
//   wrap    Σ call_logs.wrap_seconds     — call end to disposition submit
//   break / idle                          — from agent_status_log, via the status picker
//
// Until then ringing, wrap, break and idle were generated by a seeded RNG and shown here
// labelled "(est.)". They are observations now, so the labels are gone.
//
// ⚠️ What has NOT changed is the need to distinguish nothing-happened from nothing-was-tracked.
// Tracking is forward-only: a day before it was switched on has no rows and must render "—",
// never 0. A report gets exported and used to judge people, and a fabricated zero is as bad as
// a fabricated number.

interface TimeRow {
  day: string;
  label: string;
  calls: number;
  /** REAL — Σ duration_seconds. */
  talkSeconds: number;
  /** REAL — mean call length. */
  avgSeconds: number;
  /** REAL — the longest single call that day. */
  longestSeconds: number;
  /** MEASURED as of 20260830_agent_time_tracking.sql — ring/wrap from the dialer, break and
   * idle from agent_status_log. `null` means NOT RECORDED (a day before tracking existed, or
   * an agent whose presence was never logged) and renders as "—", never as 0. */
  ringingSeconds: number | null;
  wrapSeconds: number | null;
  breakSeconds: number | null;
  idleSeconds: number | null;
}

function computeTimeRows(
  agentId: string,
  disps: DispositionRecord[],
  days: string[],
  intervals: StatusInterval[],
): TimeRow[] {
  return days.map((day) => {
    const dayDisps = disps.filter((d) => istDayKey(d.time) === day);
    const durations = dayDisps.map((d) => d.durationSeconds ?? 0);
    const talkSeconds = durations.reduce((a, b) => a + b, 0);
    const t = getAgentTimeStats(agentId, dayDisps, day, intervals);
    return {
      day,
      label: formatDayLabel(day),
      calls: dayDisps.length,
      talkSeconds,
      avgSeconds: dayDisps.length ? Math.round(talkSeconds / dayDisps.length) : 0,
      longestSeconds: durations.length ? Math.max(...durations) : 0,
      ringingSeconds: t.ringingSeconds,
      wrapSeconds: t.dispositionSeconds,
      breakSeconds: t.breakSeconds,
      idleSeconds: t.idleSeconds,
    };
  });
}

// ─── narrative (computed from the real numbers above — no LLM call behind this) ──

function weeklyNarrative(rows: DailyRow[], from: string, to: string): string {
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  if (totalCalls === 0) return `No calls logged between ${formatRangeLabel(from, to)} yet.`;
  const totalCollected = rows.reduce((s, r) => s + r.collected, 0);
  const totalPtps = rows.reduce((s, r) => s + r.ptps, 0);
  const best = rows.reduce((a, b) => (b.collected > a.collected ? b : a));
  return (
    `${totalCalls} calls logged and ${formatINR(totalCollected)} collected across ${totalPtps} PTPs, ` +
    `${formatRangeLabel(from, to)}.` +
    (best.collected > 0
      ? ` ${best.label} was your best day at ${formatINR(best.collected)} collected.`
      : "")
  );
}

function portfolioNarrative(rows: PortfolioHealthRow[]): string {
  if (rows.length === 0) return "No accounts are currently assigned to you.";
  const totalAccounts = rows.reduce((s, r) => s + r.total, 0);
  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  const riskiest = [...rows].sort(
    (a, b) => b.bucketPct.NPA + b.bucketPct.WriteOff - (a.bucketPct.NPA + a.bucketPct.WriteOff),
  )[0];
  const riskPct = riskiest.bucketPct.NPA + riskiest.bucketPct.WriteOff;
  return (
    `${totalAccounts} accounts assigned across ${rows.length} portfolio${rows.length === 1 ? "" : "s"}, ` +
    `totalling ${formatINR(totalOutstanding)} outstanding.` +
    (riskPct > 0
      ? ` ${riskiest.name} carries the highest risk concentration — ${riskPct}% of those accounts are 90+ DPD.`
      : " None of your assigned accounts are past 90 DPD right now.")
  );
}

function performanceNarrative(rows: DailyRow[], from: string, to: string): string {
  const withCalls = rows.filter((r) => r.calls > 0);
  if (withCalls.length === 0) return `No calls logged between ${formatRangeLabel(from, to)} yet.`;
  const avg = (arr: DailyRow[], key: "contactRate" | "ptpRate") =>
    arr.length ? Math.round(arr.reduce((s, r) => s + r[key], 0) / arr.length) : 0;
  const avgContact = avg(withCalls, "contactRate");
  const avgPtp = avg(withCalls, "ptpRate");
  const mid = Math.floor(withCalls.length / 2);
  const delta =
    avg(withCalls.slice(mid), "contactRate") - avg(withCalls.slice(0, mid), "contactRate");
  const trendWord = delta > 3 ? "improving" : delta < -3 ? "slipping" : "holding steady";
  return (
    `Average contact rate of ${avgContact}% over this range, with a ${avgPtp}% promise-to-pay rate on ` +
    `connected calls. Contact rate is ${trendWord} across the period${
      withCalls.length > 1 && Math.abs(delta) > 3 ? ` (${delta > 0 ? "+" : ""}${delta} pts)` : ""
    }.`
  );
}

/** Speaks only to talk time, which is available for every period. Break and idle exist only
 * for days after tracking was switched on, so a prose sentence asserting them would be wrong
 * for any older range — the table says "—" per day instead. */
function timeNarrative(rows: TimeRow[]): string {
  const calls = rows.reduce((s, r) => s + r.calls, 0);
  if (calls === 0) return "No calls logged in this range, so there is no talk time to report.";
  const talk = rows.reduce((s, r) => s + r.talkSeconds, 0);
  const busiest = rows.reduce((a, b) => (b.talkSeconds > a.talkSeconds ? b : a));
  const activeDays = rows.filter((r) => r.calls > 0).length;
  return (
    `${formatDuration(talk)} on the phone across ${calls} call${calls === 1 ? "" : "s"} ` +
    `over ${activeDays} active day${activeDays === 1 ? "" : "s"}, averaging ` +
    `${formatDuration(Math.round(talk / calls))} per call. Busiest day was ${busiest.label} ` +
    `(${formatDuration(busiest.talkSeconds)}). Ringing, wrap, break and idle in the table are ` +
    `A dash in the table means that day was not tracked.`
  );
}

function outcomeNarrative(disps: DispositionRecord[]): string {
  if (disps.length === 0) return "No calls logged in this range yet.";
  const stats = calcStats(disps);
  const counts = disps.reduce<Record<string, number>>((acc, d) => {
    acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const [topOutcome, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return (
    `${disps.length} calls logged, ${stats.contactRate}% contact rate. ` +
    `"${OUTCOME_LABELS[topOutcome] ?? topOutcome}" is the most common outcome — ${topCount} calls ` +
    `(${Math.round((topCount / disps.length) * 100)}%).`
  );
}

function followupsNarrative(followups: PtpFollowup[]): string {
  if (followups.length === 0) return "No open promises-to-pay right now.";
  const overdue = followups.filter((f) => f.daysLeft < 0);
  const totalOpen = followups.reduce((s, f) => s + f.ptpAmount, 0);
  return (
    `${followups.length} open promise${followups.length === 1 ? "" : "s"} worth ${formatINR(totalOpen)}` +
    (overdue.length > 0
      ? `, including ${overdue.length} overdue — follow up on those first.`
      : ", none overdue.")
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

/** One line on how the month is pacing, in the same voice as the other narratives. Reads the
 * like-for-like comparison, never this-month-to-date against a full last month. */
function monthlyNarrative(disps: DispositionRecord[], payments: PaymentRecord[]): string {
  const c = compareMonths(disps, payments);
  const { window: w } = c;
  if (c.current.calls === 0 && c.previousSamePeriod.calls === 0 && c.current.collected === 0) {
    return `No activity logged in ${w.currentLabel} or the same stretch of ${w.previousLabel} yet.`;
  }
  const pct = deltaPct(c.current.collected, c.previousSamePeriod.collected);
  const pace =
    pct === null
      ? c.current.collected > 0
        ? `nothing was collected over the same days in ${w.previousLabel}, so there is no percentage to compare against`
        : `nothing collected either month so far`
      : `${pct >= 0 ? "up" : "down"} ${Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct))}% against the same days last month`;
  return (
    `Through ${w.asOfDay} ${w.currentLabel} you have logged ${c.current.calls.toLocaleString()} calls ` +
    `and collected ${formatINR(c.current.collected)} — ${pace}. ` +
    `${w.previousLabel} finished at ${formatINR(c.previousFull.collected)} across ` +
    `${c.previousFull.calls.toLocaleString()} calls.`
  );
}

function ReportsPage() {
  const { user } = useAuth();
  const agentId = user?.email ?? user?.id ?? "";

  const [active, setActive] = useState<ReportType>("weekly");
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);

  const [disps, setDisps] = useState<DispositionRecord[]>(() =>
    agentId ? getAgentDispositions(agentId) : [],
  );
  useEffect(() => {
    const load = () => setDisps(agentId ? getAgentDispositions(agentId) : []);
    load();
    window.addEventListener("dispositions-updated", load);
    refreshDispositions();
    return () => window.removeEventListener("dispositions-updated", load);
  }, [agentId]);

  // Collections come from the payments table, not from call_logs.paidAmount — see
  // monthly-trend.ts. Scoped to this agent: a bank-reported paid-file row credits nobody, so it
  // is deliberately absent here and shows up only in the team and company figures.
  const [payments, setPayments] = useState<PaymentRecord[]>(() =>
    agentId ? getPayments().filter((p) => p.agentId === agentId) : [],
  );
  useEffect(() => {
    const load = () =>
      setPayments(agentId ? getPayments().filter((p) => p.agentId === agentId) : []);
    load();
    window.addEventListener("payments-updated", load);
    refreshPayments();
    return () => window.removeEventListener("payments-updated", load);
  }, [agentId]);

  const [portfolioVersion, setPortfolioVersion] = useState(0);
  useEffect(() => {
    const bump = () => setPortfolioVersion((n) => n + 1);
    window.addEventListener("portfolios-updated", bump);
    refreshPortfolios();
    return () => window.removeEventListener("portfolios-updated", bump);
  }, []);

  const days = useMemo(() => enumerateDays(fromDate, toDate), [fromDate, toDate]);
  const rangeDisps = useMemo(
    () => disps.filter((d) => inRange(d.time, fromDate, toDate)),
    [disps, fromDate, toDate],
  );
  const dailyRows = useMemo(() => computeDaily(rangeDisps, days), [rangeDisps, days]);
  // Real presence for the selected range. Without it the break/idle columns come back null
  // and render as "—", which is correct but empty — this is what fills them in.
  const [presenceIntervals, setPresenceIntervals] = useState<StatusInterval[]>([]);
  useEffect(() => {
    if (!agentId) return;
    fetchStatusIntervalsRange([agentId], fromDate, toDate)
      .then(setPresenceIntervals)
      .catch(() => setPresenceIntervals([]));
  }, [agentId, fromDate, toDate]);

  const timeRows = useMemo(
    () => computeTimeRows(agentId, rangeDisps, days, presenceIntervals),
    [agentId, rangeDisps, days, presenceIntervals],
  );
  const portfolioRows = useMemo(
    () => computePortfolioHealth(agentId, rangeDisps),
    // rangeDisps added: the collected / accounts-touched columns are range-scoped, so this
    // must recompute when the date filter moves, not only when portfolios reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, portfolioVersion, rangeDisps],
  );
  // `disps` isn't read directly below — it's a dependency so this recomputes whenever the
  // dispositions cache updates (getPtpFollowups reads that same cache internally).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const followups = useMemo(() => (agentId ? getPtpFollowups(agentId) : []), [agentId, disps]);

  const rangeStats = useMemo(() => calcStats(rangeDisps), [rangeDisps]);
  const overdueCount = useMemo(() => followups.filter((f) => f.daysLeft < 0).length, [followups]);
  const openPtpAmount = useMemo(() => followups.reduce((s, f) => s + f.ptpAmount, 0), [followups]);

  const report = REPORTS.find((r) => r.id === active)!;

  function handleExport() {
    if (active === "weekly") {
      downloadCsv(
        `collections-summary-${fromDate}-to-${toDate}.csv`,
        ["Date", "Calls", "PTPs", "Collected (₹)"],
        dailyRows.map((r) => [r.label, r.calls, r.ptps, r.collected]),
      );
    } else if (active === "monthly") {
      const { window: w } = compareMonths(disps, payments);
      const calls = dailySeries(disps, payments, "calls");
      const ptps = dailySeries(disps, payments, "ptps");
      const collected = dailySeries(disps, payments, "collected");
      downloadCsv(
        `monthly-trend-${w.currentLabel.replace(" ", "-")}.csv`,
        [
          "Day of month",
          `Calls — ${w.currentLabel}`,
          `Calls — ${w.previousLabel}`,
          `PTPs — ${w.currentLabel}`,
          `PTPs — ${w.previousLabel}`,
          `Collected ₹ — ${w.currentLabel}`,
          `Collected ₹ — ${w.previousLabel}`,
        ],
        calls.map((row, i) => [
          row.day,
          // null means the day hasn't happened yet this month — blank, not 0, so a
          // spreadsheet average over the column isn't dragged down by days that don't exist.
          row.current ?? "",
          row.previous ?? "",
          ptps[i].current ?? "",
          ptps[i].previous ?? "",
          collected[i].current ?? "",
          collected[i].previous ?? "",
        ]),
      );
    } else if (active === "portfolio") {
      downloadCsv(
        "portfolio-health.csv",
        ["Portfolio", "Accounts", "Outstanding (₹)", ...BUCKET_ORDER.map((b) => BUCKET_SHORT[b])],
        portfolioRows.map((r) => [
          r.name,
          r.total,
          r.outstanding,
          ...BUCKET_ORDER.map((b) => `${r.bucketCount[b]} (${r.bucketPct[b]}%)`),
        ]),
      );
    } else if (active === "time") {
      // An unrecorded value is an empty cell, not a 0 — a spreadsheet will happily average a
      // column of zeros and produce a confident answer about a day nobody tracked.
      downloadCsv(
        `time-and-effort-${fromDate}-to-${toDate}.csv`,
        [
          "Date",
          "Calls",
          "Talk (s)",
          "Avg call (s)",
          "Longest call (s)",
          "Ringing (s)",
          "Wrap (s)",
          "Break (s)",
          "Idle (s)",
        ],
        timeRows.map((r) => [
          r.label,
          r.calls,
          r.talkSeconds,
          r.avgSeconds,
          r.longestSeconds,
          r.ringingSeconds ?? "",
          r.wrapSeconds ?? "",
          r.breakSeconds ?? "",
          r.idleSeconds ?? "",
        ]),
      );
    } else if (active === "performance") {
      downloadCsv(
        `my-performance-${fromDate}-to-${toDate}.csv`,
        ["Date", "Calls", "Contact Rate %", "PTP Rate %"],
        dailyRows.map((r) => [r.label, r.calls, r.contactRate, r.ptpRate]),
      );
    } else if (active === "outcomes") {
      const counts = rangeDisps.reduce<Record<string, number>>((acc, d) => {
        acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
        return acc;
      }, {});
      downloadCsv(
        `outcome-breakdown-${fromDate}-to-${toDate}.csv`,
        ["Outcome", "Count", "% of calls"],
        Object.entries(counts).map(([o, c]) => [
          OUTCOME_LABELS[o] ?? o,
          c,
          rangeDisps.length ? Math.round((c / rangeDisps.length) * 100) : 0,
        ]),
      );
    } else {
      downloadCsv(
        "ptp-followups.csv",
        ["Debtor", "Phone", "PTP Amount (₹)", "Due Date", "Days Left", "Notes"],
        followups.map((f) => [
          f.debtorName,
          f.phone,
          f.ptpAmount,
          f.ptpDateIso,
          f.daysLeft,
          f.notes,
        ]),
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Summaries and charts generated from your own call log — nothing here is a mock.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          icon={IndianRupee}
          label="Collected"
          value={formatINR(rangeStats.paidAmount)}
          sub={`${rangeStats.paid} payments · ${formatRangeLabel(fromDate, toDate)}`}
          green
        />
        <Stat
          icon={Target}
          label="PTP Secured"
          value={formatINR(rangeStats.ptpAmount)}
          sub={`${rangeStats.ptps} promises this range`}
          green
        />
        <Stat
          icon={PhoneCall}
          label="Calls Logged"
          value={rangeStats.total.toLocaleString()}
          sub={`${rangeStats.contactRate}% contact rate`}
        />
        <Stat
          icon={AlertTriangle}
          label="Open Promises"
          value={formatINR(openPtpAmount)}
          sub={`${followups.length} open${overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
        {/* Report list */}
        <div className="space-y-2">
          {REPORTS.map((r, i) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setActive(r.id)}
              className={cn(
                "animate-in fade-in slide-in-from-left-4 duration-500 fill-mode-both",
                "w-full text-left rounded-lg border p-3 transition-all duration-150",
                active === r.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-foreground hover:border-primary/40 hover:bg-accent",
              )}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center gap-2">
                <r.icon className="h-4 w-4 flex-shrink-0" />
                <span className="text-sm font-medium">{r.label}</span>
                {!r.dateFiltered && (
                  <Badge variant="secondary" className="ml-auto text-[10px] py-0">
                    Live
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground leading-snug">{r.description}</p>
            </button>
          ))}
        </div>

        {/* Preview panel */}
        <Card className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <CardHeader className="border-b border-border">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <report.icon className="h-4 w-4 text-primary" />
                  {report.label}
                </CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {report.dateFiltered ? (
                  <>
                    {/* The same control as Activity History, Payments, Messages, Call Audit,
                        Manager Activity and Debtors — one date filter, learned once. It also
                        swaps a reversed range rather than silently rendering an empty report,
                        which the two bare inputs here could not do. */}
                    <DateRangeFilter
                      value={{ from: fromDate, to: toDate }}
                      onChange={(r) => {
                        setFromDate(r.from);
                        setToDate(r.to);
                      }}
                      showIcon={false}
                    />
                  </>
                ) : (
                  <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                    Live snapshot — not affected by the date range
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={handleExport}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:text-foreground hover:bg-muted/50 active:scale-95"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {/* Summary */}
            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
              <Info className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" />
              <p className="text-sm text-foreground/90 leading-relaxed">
                {active === "weekly" && weeklyNarrative(dailyRows, fromDate, toDate)}
                {active === "monthly" && monthlyNarrative(disps, payments)}
                {active === "portfolio" && portfolioNarrative(portfolioRows)}
                {active === "performance" && performanceNarrative(dailyRows, fromDate, toDate)}
                {active === "time" && timeNarrative(timeRows)}
                {active === "outcomes" && outcomeNarrative(rangeDisps)}
                {active === "followups" && followupsNarrative(followups)}
              </p>
            </div>

            {/* Chart + table */}
            {active === "weekly" && <WeeklyReport rows={dailyRows} />}
            {active === "monthly" && (
              <MonthlyTrendPanel
                disps={disps}
                payments={payments}
                note="Collections counted here are the ones credited to you. A payment the bank reported in a paid-file upload has no collector, so it lands in your team's total but not in yours."
              />
            )}
            {active === "portfolio" && <PortfolioReport rows={portfolioRows} />}
            {active === "performance" && <PerformanceReport rows={dailyRows} />}
            {active === "time" && <TimeReport rows={timeRows} />}
            {active === "outcomes" && <OutcomesReport disps={rangeDisps} />}
            {active === "followups" && <FollowupsReport followups={followups} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── per-report chart + table ────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{message}</p>;
}

/** Spreadsheet-style table matching the shared DataTable's look (ruled cells, zebra rows,
 * right-aligned tabular numerics) — kept positional here since every agent-side report feeds
 * it plain header/row arrays rather than column definitions. */
function ReportTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card">
      <div className="overflow-auto max-h-[420px]">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/60 backdrop-blur text-[10px] uppercase tracking-wider text-muted-foreground">
              {headers.map((h, i) => (
                <th
                  key={h}
                  className={cn(
                    "border-b border-r border-border last:border-r-0 px-3 py-2 font-semibold whitespace-nowrap",
                    i === 0 ? "text-left" : "text-right",
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={ri}
                className={cn(
                  "transition-colors hover:bg-primary/5",
                  ri % 2 === 1 && "bg-muted/20",
                )}
              >
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "border-b border-r border-border/60 last:border-r-0 px-3 py-1.5",
                      ci === 0
                        ? "text-left font-medium text-foreground"
                        : "text-right tabular-nums",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WeeklyReport({ rows }: { rows: DailyRow[] }) {
  if (rows.every((r) => r.calls === 0))
    return <EmptyState message="No calls logged in this range yet." />;
  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={rows} barGap={4}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} />
          <XAxis dataKey="label" tick={AXIS_TICK} />
          <YAxis
            yAxisId="left"
            tick={AXIS_TICK}
            tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
          />
          <YAxis yAxisId="right" orientation="right" tick={AXIS_TICK} allowDecimals={false} />
          <Tooltip {...TOOLTIP_STYLE} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            yAxisId="left"
            dataKey="collected"
            name="Collected (₹)"
            fill={CHART_COLORS.primary}
            radius={[3, 3, 0, 0]}
          />
          <Line
            yAxisId="right"
            dataKey="calls"
            name="Calls"
            stroke={CHART_COLORS.success}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
          <Line
            yAxisId="right"
            dataKey="ptps"
            name="PTPs"
            stroke={CHART_COLORS.warning}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <ReportTable
        headers={["Date", "Calls", "PTPs", "Collected"]}
        rows={rows.map((r) => [r.label, r.calls, r.ptps, formatINR(r.collected)])}
      />
    </div>
  );
}

/** "All portfolios" row. Counts and money sum; the two percentages are recomputed from the
 * summed numerator and denominator rather than averaged — averaging percentages across
 * portfolios of different sizes gives a number that is simply wrong. */
function totalsRow(rows: PortfolioHealthRow[]): (string | number)[] {
  const accounts = rows.reduce((s, r) => s + r.total, 0);
  const principal = rows.reduce((s, r) => s + r.outstanding, 0);
  const worked = rows.reduce((s, r) => s + r.accountsTouched, 0);
  const collected = rows.reduce((s, r) => s + r.collected, 0);
  return [
    "All portfolios",
    accounts,
    formatINR(principal),
    worked,
    `${accounts ? Math.round((worked / accounts) * 100) : 0}%`,
    formatINR(collected),
    principal ? `${((collected / principal) * 100).toFixed(2)}%` : "\u2014",
    ...BUCKET_ORDER.map((b) => `${rows.reduce((s, r) => s + r.bucketCount[b], 0)}`),
  ];
}

function PortfolioReport({ rows }: { rows: PortfolioHealthRow[] }) {
  if (rows.length === 0) return <EmptyState message="No accounts are currently assigned to you." />;
  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 56)}>
        <BarChart data={rows} layout="vertical" barSize={16} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
          <YAxis type="category" dataKey="name" tick={AXIS_TICK} width={140} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {BUCKET_ORDER.map((b, i) => (
            <Bar
              key={b}
              dataKey={(r: PortfolioHealthRow) => r.bucketPct[b]}
              name={BUCKET_SHORT[b]}
              stackId="a"
              fill={BUCKET_FILL[b]}
              radius={i === BUCKET_ORDER.length - 1 ? [0, 3, 3, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <ReportTable
        headers={[
          "Portfolio",
          "Accounts",
          "Principal (POS)",
          "Worked",
          "Coverage",
          "Collected",
          "Recovery",
          ...BUCKET_ORDER.map((b) => BUCKET_SHORT[b]),
        ]}
        rows={[
          ...rows.map((r) => [
            r.name,
            r.total,
            formatINR(r.outstanding),
            r.accountsTouched,
            // How much of the book was actually reached — "Accounts" alone never showed this.
            `${r.total ? Math.round((r.accountsTouched / r.total) * 100) : 0}%`,
            formatINR(r.collected),
            // Against principal, so it is comparable across portfolios of different sizes.
            r.outstanding ? `${((r.collected / r.outstanding) * 100).toFixed(2)}%` : "\u2014",
            ...BUCKET_ORDER.map((b) => `${r.bucketCount[b]} (${r.bucketPct[b]}%)`),
          ]),
          ...(rows.length > 1 ? [totalsRow(rows)] : []),
        ]}
      />
      <p className="text-[11px] text-muted-foreground">
        Principal and outstanding are the same figure in this system \u2014 the bank file carries no
        separate outstanding balance, so it is stored as a copy of the loan amount. Recovery % is
        against that principal.
      </p>
    </div>
  );
}

function PerformanceReport({ rows }: { rows: DailyRow[] }) {
  if (rows.every((r) => r.calls === 0))
    return <EmptyState message="No calls logged in this range yet." />;
  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} />
          <XAxis dataKey="label" tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} tickFormatter={(v) => `${v}%`} domain={[0, 100]} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="contactRate"
            name="Contact Rate"
            stroke={CHART_COLORS.primary}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="ptpRate"
            name="PTP Rate"
            stroke={CHART_COLORS.success}
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
      <ReportTable
        headers={["Date", "Calls", "Contact Rate", "PTP Rate"]}
        rows={rows.map((r) => [r.label, r.calls, `${r.contactRate}%`, `${r.ptpRate}%`])}
      />
    </div>
  );
}

function TimeReport({ rows }: { rows: TimeRow[] }) {
  if (rows.every((r) => r.calls === 0))
    return <EmptyState message="No calls logged in this range yet." />;

  const totalTalk = rows.reduce((s, r) => s + r.talkSeconds, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const busiest = rows.reduce((a, b) => (b.talkSeconds > a.talkSeconds ? b : a));

  return (
    <div className="space-y-3">
      {/* Headline totals for the range. Every figure below is measured. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Talk time", value: formatDuration(totalTalk), sub: "measured" },
          {
            label: "Avg call",
            value: formatDuration(totalCalls ? Math.round(totalTalk / totalCalls) : 0),
            sub: `over ${totalCalls} call${totalCalls === 1 ? "" : "s"}`,
          },
          {
            label: "Longest call",
            value: formatDuration(Math.max(...rows.map((r) => r.longestSeconds))),
            sub: "measured",
          },
          { label: "Busiest day", value: busiest.label, sub: formatDuration(busiest.talkSeconds) },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="text-base font-bold tabular-nums leading-tight text-foreground">
              {c.value}
            </div>
            <div className="mt-0.5 text-[11px] font-medium text-foreground">{c.label}</div>
            <div className="text-[10px] text-muted-foreground">{c.sub}</div>
          </div>
        ))}
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} />
          <YAxis tick={AXIS_TICK} tickFormatter={(v: number) => `${Math.round(v / 60)}m`} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [formatDuration(v)]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="talkSeconds"
            name="Talk (measured)"
            stackId="t"
            fill={CHART_COLORS.primary}
          />
          <Bar
            dataKey="ringingSeconds"
            name="Ringing (est.)"
            stackId="t"
            fill={CHART_COLORS.muted}
          />
          <Bar dataKey="wrapSeconds" name="Wrap" stackId="t" fill={CHART_COLORS.success} />
          <Bar dataKey="idleSeconds" name="Idle" stackId="t" fill={CHART_COLORS.warning} />
        </BarChart>
      </ResponsiveContainer>

      <ReportTable
        headers={["Date", "Calls", "Talk", "Avg", "Longest", "Ringing", "Wrap", "Break", "Idle"]}
        rows={rows.map((r) => [
          r.label,
          r.calls,
          formatDuration(r.talkSeconds),
          formatDuration(r.avgSeconds),
          formatDuration(r.longestSeconds),
          formatDurationOrDash(r.ringingSeconds),
          formatDurationOrDash(r.wrapSeconds),
          formatDurationOrDash(r.breakSeconds),
          formatDurationOrDash(r.idleSeconds),
        ])}
      />

      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-warning" />
        <p className="text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">
            These are measurements, not estimates.
          </span>{" "}
          Ringing and wrap come from the dialer; break and idle from the agent&apos;s status picker.
          A dash means <span className="font-medium text-foreground">not recorded</span> — tracking
          only began when it was switched on, and nothing can reconstruct a day before that. An
          agent who took no breaks and one whose breaks were never tracked are deliberately shown
          differently.
        </p>
      </div>
    </div>
  );
}

function OutcomesReport({ disps }: { disps: DispositionRecord[] }) {
  if (disps.length === 0) return <EmptyState message="No calls logged in this range yet." />;
  const counts = disps.reduce<Record<string, number>>((acc, d) => {
    acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-4">
      <OutcomeBreakdown disps={disps} />
      <ReportTable
        headers={["Outcome", "Count", "% of calls"]}
        rows={sorted.map(([o, c]) => [
          OUTCOME_LABELS[o] ?? o,
          c,
          `${Math.round((c / disps.length) * 100)}%`,
        ])}
      />
    </div>
  );
}

function FollowupsReport({ followups }: { followups: PtpFollowup[] }) {
  if (followups.length === 0) return <EmptyState message="No open promises-to-pay right now." />;
  const top = followups.slice(0, 10);
  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={Math.max(180, top.length * 32)}>
        <BarChart data={top} layout="vertical" barSize={14}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} tickFormatter={(v) => formatINR(v)} />
          <YAxis type="category" dataKey="debtorName" tick={AXIS_TICK} width={120} />
          <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [formatINR(v), "PTP Amount"]} />
          <Bar dataKey="ptpAmount" radius={[0, 3, 3, 0]}>
            {top.map((f, i) => (
              <Cell
                key={i}
                fill={
                  f.daysLeft < 0
                    ? CHART_COLORS.destructive
                    : f.daysLeft === 0
                      ? CHART_COLORS.warning
                      : CHART_COLORS.primary
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <ReportTable
        headers={["Debtor", "Phone", "Amount", "Due", "Status"]}
        rows={followups.map((f) => [
          f.debtorName,
          f.phone,
          formatINR(f.ptpAmount),
          f.ptpDateIso,
          f.daysLeft < 0
            ? `${-f.daysLeft}d overdue`
            : f.daysLeft === 0
              ? "Due today"
              : `in ${f.daysLeft}d`,
        ])}
      />
    </div>
  );
}
