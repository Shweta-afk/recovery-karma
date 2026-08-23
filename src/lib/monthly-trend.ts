/**
 * Month-over-month performance trends, shared by the agent, manager and admin report pages.
 *
 * Two questions this answers, and they are deliberately different:
 *
 *   1. "How am I doing this month vs last month?"  Compared **like for like** — the 1st to
 *      today against the 1st to the same day-of-month last month. Comparing 22 days of this
 *      month against a full 31-day last month makes every month look like a collapse until
 *      its final day, which is worse than useless for a target-driven floor. Last month's
 *      full total is carried alongside as `previousFull` so the finish line is still visible.
 *   2. "Where am I on day N vs where I was on day N last month?"  A day-of-month series, so
 *      the two months line up on the x-axis (1st vs 1st, 22nd vs 22nd) rather than on
 *      calendar date. Cumulative is the pace view; daily is the activity view.
 *
 * Days are bucketed in **IST**, not the viewer's timezone and not UTC. `toISOString()` (which
 * the older date helpers in dashboard.reports.tsx use) puts every call logged before 05:30 IST
 * on the previous day, which silently moves collections across a month boundary on the 1st.
 *
 * Collections come from the `payments` table rather than from `call_logs.paidAmount`, because
 * payments is the whole financial record — it includes a manager's bulk paid-file upload,
 * which no call disposition will ever reflect. Those rows carry `agentId: null` (nobody
 * collected them), so they land in team and company totals but not in any one agent's, which
 * is the correct attribution and worth saying out loud in the UI.
 */
import type { DispositionRecord } from "./disposition-store";
import type { PaymentRecord } from "./payments-store";

export type TrendMetricKey = "collected" | "calls" | "contacts" | "ptps" | "ptpAmount" | "payments";

export interface TrendMetrics {
  /** Call logs written. */
  calls: number;
  /** Calls that reached a human — everything except no_answer and voicemail, matching calcStats. */
  contacts: number;
  /** Calls dispositioned "promised". */
  ptps: number;
  /** ₹ promised across those. */
  ptpAmount: number;
  /** ₹ from completed payments. */
  collected: number;
  /** Count of completed payments. */
  payments: number;
}

export interface MetricDef {
  key: TrendMetricKey;
  label: string;
  /** Currency metrics format as ₹; the rest as plain counts. */
  currency: boolean;
}

export const TREND_METRICS: MetricDef[] = [
  { key: "collected", label: "Collected", currency: true },
  { key: "ptpAmount", label: "PTP Value", currency: true },
  { key: "calls", label: "Calls", currency: false },
  { key: "contacts", label: "Contacts", currency: false },
  { key: "ptps", label: "PTPs", currency: false },
  { key: "payments", label: "Payments", currency: false },
];

// ─── IST day bucketing ──────────────────────────────────────────────────────────

/** One formatter, reused: constructing an Intl.DateTimeFormat per row is the expensive part
 * when bucketing thousands of call logs. en-CA yields exactly "YYYY-MM-DD". */
const IST_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" for an ISO timestamp, in IST. Empty string when the value isn't a date. */
export function istDayKey(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return IST_DAY.format(d);
}

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ─── the comparison window ──────────────────────────────────────────────────────

export interface MonthWindow {
  currentYear: number;
  /** 1-12. */
  currentMonth: number;
  previousYear: number;
  previousMonth: number;
  /** Today's day-of-month, in IST. */
  asOfDay: number;
  daysInCurrent: number;
  daysInPrevious: number;
  /** asOfDay clamped into last month — the 31st has no counterpart in a 30-day month. */
  comparableDay: number;
  currentLabel: string;
  previousLabel: string;
}

/** The current and previous month in IST, whatever timezone the browser is in. */
export function monthWindow(now: Date = new Date()): MonthWindow {
  const [y, m, d] = IST_DAY.format(now).split("-").map(Number);
  const previousMonth = m === 1 ? 12 : m - 1;
  const previousYear = m === 1 ? y - 1 : y;
  const daysInCurrent = daysInMonth(y, m);
  const daysInPrevious = daysInMonth(previousYear, previousMonth);
  return {
    currentYear: y,
    currentMonth: m,
    previousYear,
    previousMonth,
    asOfDay: d,
    daysInCurrent,
    daysInPrevious,
    comparableDay: Math.min(d, daysInPrevious),
    currentLabel: `${MONTH_NAMES[m - 1]} ${y}`,
    previousLabel: `${MONTH_NAMES[previousMonth - 1]} ${previousYear}`,
  };
}

// ─── bucketing ──────────────────────────────────────────────────────────────────

function emptyMetrics(): TrendMetrics {
  return { calls: 0, contacts: 0, ptps: 0, ptpAmount: 0, collected: 0, payments: 0 };
}

const NON_CONTACT = new Set(["no_answer", "voicemail"]);

/**
 * Every metric bucketed by IST day, in a single pass over both tables.
 *
 * Both months' figures are read out of this one map, so the "this month" and "last month"
 * columns can never be computed by two subtly different code paths — the failure mode that
 * makes a comparison table lie.
 */
export function bucketByDay(
  disps: DispositionRecord[],
  payments: PaymentRecord[],
): Map<string, TrendMetrics> {
  const byDay = new Map<string, TrendMetrics>();
  const at = (key: string): TrendMetrics => {
    let m = byDay.get(key);
    if (!m) {
      m = emptyMetrics();
      byDay.set(key, m);
    }
    return m;
  };

  for (const d of disps) {
    const key = istDayKey(d.time);
    if (!key) continue;
    const m = at(key);
    m.calls++;
    if (!NON_CONTACT.has(d.outcome)) m.contacts++;
    if (d.outcome === "promised") {
      m.ptps++;
      m.ptpAmount += d.ptpAmount ?? 0;
    }
  }

  for (const p of payments) {
    if (p.status !== "completed") continue;
    // receivedAt is when the money actually landed; createdAt is when the row was written.
    // A paid file uploaded in August for July receipts belongs to July.
    const key = istDayKey(p.receivedAt ?? p.createdAt);
    if (!key) continue;
    const m = at(key);
    m.collected += p.amount;
    m.payments++;
  }

  return byDay;
}

function sumRange(
  byDay: Map<string, TrendMetrics>,
  year: number,
  month: number,
  fromDay: number,
  toDay: number,
): TrendMetrics {
  const total = emptyMetrics();
  for (let day = fromDay; day <= toDay; day++) {
    const m = byDay.get(dayKey(year, month, day));
    if (!m) continue;
    total.calls += m.calls;
    total.contacts += m.contacts;
    total.ptps += m.ptps;
    total.ptpAmount += m.ptpAmount;
    total.collected += m.collected;
    total.payments += m.payments;
  }
  return total;
}

// ─── the comparison ─────────────────────────────────────────────────────────────

export interface TrendComparison {
  window: MonthWindow;
  /** 1st → today, this month. */
  current: TrendMetrics;
  /** 1st → the same day-of-month last month. The honest comparison. */
  previousSamePeriod: TrendMetrics;
  /** All of last month, for context on where the finish line was. */
  previousFull: TrendMetrics;
}

export function compareMonths(
  disps: DispositionRecord[],
  payments: PaymentRecord[],
  now: Date = new Date(),
): TrendComparison {
  const w = monthWindow(now);
  const byDay = bucketByDay(disps, payments);
  return {
    window: w,
    current: sumRange(byDay, w.currentYear, w.currentMonth, 1, w.asOfDay),
    previousSamePeriod: sumRange(byDay, w.previousYear, w.previousMonth, 1, w.comparableDay),
    previousFull: sumRange(byDay, w.previousYear, w.previousMonth, 1, w.daysInPrevious),
  };
}

/**
 * Percent change, or `null` when there is no baseline to change from.
 *
 * A 0 → 500 jump is not "+∞%" and definitely not "+0%"; it has no percentage, and the UI says
 * "new" instead of inventing one. Callers must handle null rather than defaulting it to 0,
 * which would render real progress as flat.
 */
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

// ─── the day-of-month series ────────────────────────────────────────────────────

export interface TrendDayPoint {
  /** Day-of-month, 1-based — the shared x-axis between the two months. */
  day: number;
  label: string;
  /** null past today, so the current month's line stops rather than flat-lining to zero. */
  current: number | null;
  previous: number | null;
  currentCumulative: number | null;
  previousCumulative: number | null;
}

/**
 * One metric, day-of-month by day-of-month, for both months.
 *
 * The current month's series is null after today. Charting a zero there would draw a cliff to
 * the x-axis and make a month in progress look like a month that stopped.
 */
export function dailySeries(
  disps: DispositionRecord[],
  payments: PaymentRecord[],
  metric: TrendMetricKey,
  now: Date = new Date(),
): TrendDayPoint[] {
  const w = monthWindow(now);
  const byDay = bucketByDay(disps, payments);
  const span = Math.max(w.daysInCurrent, w.daysInPrevious);

  const points: TrendDayPoint[] = [];
  let curCum = 0;
  let prevCum = 0;

  for (let day = 1; day <= span; day++) {
    const inCurrent = day <= w.asOfDay;
    const inPrevious = day <= w.daysInPrevious;

    const cur = inCurrent
      ? (byDay.get(dayKey(w.currentYear, w.currentMonth, day))?.[metric] ?? 0)
      : null;
    const prev = inPrevious
      ? (byDay.get(dayKey(w.previousYear, w.previousMonth, day))?.[metric] ?? 0)
      : null;

    if (cur !== null) curCum += cur;
    if (prev !== null) prevCum += prev;

    points.push({
      day,
      label: String(day),
      current: cur,
      previous: prev,
      currentCumulative: cur === null ? null : curCum,
      previousCumulative: prev === null ? null : prevCum,
    });
  }

  return points;
}

// ─── scoping ────────────────────────────────────────────────────────────────────

/**
 * Narrow both tables to a set of agent emails — the roster of a team, or one agent.
 *
 * Bank-reported payments (`agentId: null`) are dropped here by design: nobody collected them,
 * so crediting them to a person or to a team's per-agent total would be fiction. They stay in
 * the unscoped company figures, and `unattributedCollected` below exists so a page can say how
 * much sits outside every agent's number instead of leaving the gap unexplained.
 */
export function scopeToAgents(
  disps: DispositionRecord[],
  payments: PaymentRecord[],
  agentEmails: Iterable<string>,
): { disps: DispositionRecord[]; payments: PaymentRecord[] } {
  const roster = new Set(agentEmails);
  return {
    disps: disps.filter((d) => roster.has(d.agentId)),
    payments: payments.filter((p) => p.agentId !== null && roster.has(p.agentId)),
  };
}

/** ₹ of completed payments in the window that no agent is credited with — a paid-file upload.
 * Reported next to team/company totals so the difference against the sum of agents is
 * accounted for rather than looking like a bug. */
export function unattributedCollected(
  payments: PaymentRecord[],
  now: Date = new Date(),
): { current: number; previousSamePeriod: number } {
  const unattributed = payments.filter((p) => p.agentId === null);
  const c = compareMonths([], unattributed, now);
  return { current: c.current.collected, previousSamePeriod: c.previousSamePeriod.collected };
}
