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

export type TrendMetricKey =
  | "posWorked"
  | "posPromised"
  | "collected"
  | "calls"
  | "contacts"
  | "ptps"
  | "ptpAmount"
  | "projectedRecovery"
  | "payments"
  | "uniqueAccounts";

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
  /** ptpAmount + collected — the same "Projected Recovery" figure shown on the agent
   * dashboard's Queue card. Differentiates what's actually landed (collected) from what's
   * still sitting in the pipeline as an open promise (ptpAmount) by showing their sum
   * alongside both individually, rather than requiring the reader to add the two tiles
   * themselves. Not a forecast — an open PTP that's later broken still counts here until the
   * disposition changes, so this trends downward, not just up, as promises resolve. */
  projectedRecovery: number;
  /** Count of completed payments. */
  payments: number;
  /** Distinct accounts (loan IDs) with activity — contacted or collected from. Answers "how
   * many accounts did we actually touch", which `calls` cannot: 200 calls to 40 accounts is a
   * very different month from 200 calls to 200. See DayMetrics on why it can't be summed. */
  uniqueAccounts: number;
  /** ₹ principal on the accounts WORKED — the book actually covered this period. A distinct-set
   * figure like uniqueAccounts: an account worked five times counts its principal once. */
  posWorked: number;
  /** ₹ principal on the accounts that PROMISED — the book now sitting behind a PTP.
   *
   * Distinct from ptpAmount, and the pair is the point: ptpAmount is what debtors said they
   * would pay, posPromised is how much principal those promises are attached to. A month of
   * small promises against a large book looks identical to a healthy one on ptpAmount alone. */
  posPromised: number;
}

/**
 * A day's metrics plus the identities behind the distinct count.
 *
 * The set has to be carried, not just its size: a distinct count is **not additive**. An
 * account called on Monday and again on Tuesday is one account for the week, but adding the
 * two days' `uniqueAccounts` reports two. Ranges therefore union these sets and take the size
 * of the union — see sumRange — and the cumulative series in dailySeries does the same.
 */
export interface DayMetrics extends TrendMetrics {
  accounts: Set<string>;
  /** Accounts that promised that day. Carried as a set for the same reason `accounts` is —
   * principal must not be double-counted when a range is summed. */
  promisedAccounts: Set<string>;
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
  { key: "projectedRecovery", label: "Projected Recovery", currency: true },
  { key: "calls", label: "Calls", currency: false },
  { key: "contacts", label: "Contacts", currency: false },
  { key: "ptps", label: "PTPs", currency: false },
  { key: "payments", label: "Payments", currency: false },
  { key: "uniqueAccounts", label: "Accounts", currency: false },
  { key: "posWorked", label: "POS Worked", currency: true },
  { key: "posPromised", label: "POS Promised", currency: true },
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

/** "YYYY-MM-DD" for an ISO timestamp, in IST. Empty string when the value isn't a date —
 * null included, since nullable timestamp columns come straight out of Supabase. */
export function istDayKey(iso: string | null | undefined): string {
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
export function monthWindow(now: Date = new Date(), compareTo?: string): MonthWindow {
  const [y, m, d] = IST_DAY.format(now).split("-").map(Number);

  // `compareTo` ("YYYY-MM") lets the caller pick any month to compare against; without it the
  // comparison is the month immediately before, which is what this always used to do.
  let previousMonth = m === 1 ? 12 : m - 1;
  let previousYear = m === 1 ? y - 1 : y;
  if (compareTo && /^\d{4}-\d{2}$/.test(compareTo)) {
    const [cy, cm] = compareTo.split("-").map(Number);
    // A future month, or this same month, has nothing to compare against — fall back rather
    // than render a comparison of a month against itself.
    if (cm >= 1 && cm <= 12 && (cy < y || (cy === y && cm < m))) {
      previousYear = cy;
      previousMonth = cm;
    }
  }
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
  return {
    calls: 0,
    contacts: 0,
    ptps: 0,
    ptpAmount: 0,
    collected: 0,
    projectedRecovery: 0,
    payments: 0,
    uniqueAccounts: 0,
    posWorked: 0,
    posPromised: 0,
  };
}

function emptyDayMetrics(): DayMetrics {
  return {
    ...emptyMetrics(),
    accounts: new Set<string>(),
    promisedAccounts: new Set<string>(),
  };
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
  /** debtorId -> principal, for the POS metrics. Omit and they come back 0 — callers without
   * portfolio data get every other metric unaffected rather than a broken call. */
  posByDebtor: Map<string, number> = new Map(),
): Map<string, DayMetrics> {
  const byDay = new Map<string, DayMetrics>();
  const at = (key: string): DayMetrics => {
    let m = byDay.get(key);
    if (!m) {
      m = emptyDayMetrics();
      byDay.set(key, m);
    }
    return m;
  };

  for (const d of disps) {
    const key = istDayKey(d.time);
    if (!key) continue;
    const m = at(key);
    m.calls++;
    if (d.debtorId) m.accounts.add(d.debtorId);
    if (!NON_CONTACT.has(d.outcome)) m.contacts++;
    if (d.outcome === "promised") {
      m.ptps++;
      m.ptpAmount += d.ptpAmount ?? 0;
      if (d.debtorId) m.promisedAccounts.add(d.debtorId);
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
    // A bank-uploaded receipt is activity on that account even though nobody called it.
    if (p.debtorId) m.accounts.add(p.debtorId);
  }

  // Materialise the per-day distinct figures now that every row has landed. POS is summed
  // over the SET, so an account worked five times contributes its principal once.
  const pos = (ids: Set<string>) => {
    let total = 0;
    for (const id of ids) total += posByDebtor.get(id) ?? 0;
    return total;
  };
  for (const m of byDay.values()) {
    m.uniqueAccounts = m.accounts.size;
    m.posWorked = pos(m.accounts);
    m.posPromised = pos(m.promisedAccounts);
    m.projectedRecovery = m.ptpAmount + m.collected;
  }

  return byDay;
}

function sumRange(
  byDay: Map<string, DayMetrics>,
  posByDebtor: Map<string, number>,
  year: number,
  month: number,
  fromDay: number,
  toDay: number,
): TrendMetrics {
  const total = emptyMetrics();
  // Unioned, not added — see DayMetrics. POS follows the same rule: adding each day's POS
  // would count an account's principal once per day it was worked.
  const accounts = new Set<string>();
  const promised = new Set<string>();
  for (let day = fromDay; day <= toDay; day++) {
    const m = byDay.get(dayKey(year, month, day));
    if (!m) continue;
    for (const id of m.accounts) accounts.add(id);
    for (const id of m.promisedAccounts) promised.add(id);
    total.calls += m.calls;
    total.contacts += m.contacts;
    total.ptps += m.ptps;
    total.ptpAmount += m.ptpAmount;
    total.collected += m.collected;
    total.payments += m.payments;
  }
  // Derived at the end from the two totals above, not summed per-day — mathematically
  // identical (both addends are already additive) and avoids a second accumulator to keep in
  // sync with ptpAmount/collected.
  total.projectedRecovery = total.ptpAmount + total.collected;
  total.uniqueAccounts = accounts.size;
  let worked = 0;
  for (const id of accounts) worked += posByDebtor.get(id) ?? 0;
  let promisedPos = 0;
  for (const id of promised) promisedPos += posByDebtor.get(id) ?? 0;
  total.posWorked = worked;
  total.posPromised = promisedPos;
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
  posByDebtor: Map<string, number> = new Map(),
  /** Which month to compare AGAINST, as "YYYY-MM". Defaults to the month before `now`.
   * Lets a report ask "this month vs last March" instead of only ever the previous month. */
  compareTo?: string,
): TrendComparison {
  const w = monthWindow(now, compareTo);
  const byDay = bucketByDay(disps, payments, posByDebtor);
  return {
    window: w,
    current: sumRange(byDay, posByDebtor, w.currentYear, w.currentMonth, 1, w.asOfDay),
    previousSamePeriod: sumRange(
      byDay,
      posByDebtor,
      w.previousYear,
      w.previousMonth,
      1,
      w.comparableDay,
    ),
    previousFull: sumRange(
      byDay,
      posByDebtor,
      w.previousYear,
      w.previousMonth,
      1,
      w.daysInPrevious,
    ),
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
  posByDebtor: Map<string, number> = new Map(),
  compareTo?: string,
): TrendDayPoint[] {
  const w = monthWindow(now, compareTo);
  const byDay = bucketByDay(disps, payments, posByDebtor);
  const span = Math.max(w.daysInCurrent, w.daysInPrevious);

  const points: TrendDayPoint[] = [];
  let curCum = 0;
  let prevCum = 0;
  // The cumulative line for a DISTINCT count has to union identities as it walks the month,
  // not add the daily figures — an account worked on three days is one account, not three.
  // Every other metric is additive and ignores these.
  // uniqueAccounts, posWorked and posPromised are all distinct-set figures: their cumulative
  // line unions identities as it walks the month rather than adding the daily values, or an
  // account worked on three days contributes its principal three times.
  const distinct =
    metric === "uniqueAccounts" || metric === "posWorked" || metric === "posPromised";
  const curSeen = new Set<string>();
  const prevSeen = new Set<string>();

  for (let day = 1; day <= span; day++) {
    const inCurrent = day <= w.asOfDay;
    const inPrevious = day <= w.daysInPrevious;

    const cur = inCurrent
      ? (byDay.get(dayKey(w.currentYear, w.currentMonth, day))?.[metric] ?? 0)
      : null;
    const prev = inPrevious
      ? (byDay.get(dayKey(w.previousYear, w.previousMonth, day))?.[metric] ?? 0)
      : null;

    if (distinct) {
      // Which set of identities this metric counts, and how a set becomes its value.
      const setOf = (m: DayMetrics | undefined) =>
        (metric === "posPromised" ? m?.promisedAccounts : m?.accounts) ?? [];
      const valueOf = (ids: Set<string>) => {
        if (metric === "uniqueAccounts") return ids.size;
        let total = 0;
        for (const id of ids) total += posByDebtor.get(id) ?? 0;
        return total;
      };
      if (cur !== null) {
        for (const id of setOf(byDay.get(dayKey(w.currentYear, w.currentMonth, day))))
          curSeen.add(id);
        curCum = valueOf(curSeen);
      }
      if (prev !== null) {
        for (const id of setOf(byDay.get(dayKey(w.previousYear, w.previousMonth, day))))
          prevSeen.add(id);
        prevCum = valueOf(prevSeen);
      }
    } else {
      if (cur !== null) curCum += cur;
      if (prev !== null) prevCum += prev;
    }

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
