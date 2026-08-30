/* Standalone assertion harness for the month-over-month trend layer.
 * No test framework: run with `bun run scripts/monthly-trend-check.ts`.
 *
 * monthly-trend.ts is pure — it takes rows and a clock and returns numbers — so every edge
 * that matters can be pinned here: IST day boundaries, the 31st-vs-30-day-month clamp, a
 * January window rolling back into the previous December, and the zero-baseline case that
 * must not render as "+0%".
 *
 * Imports the record types only as types, so this never loads the supabase-backed stores. */
import type { DispositionRecord } from "@/lib/disposition-store";
import type { PaymentRecord } from "@/lib/payments-store";
import {
  compareMonths,
  dailySeries,
  deltaPct,
  istDayKey,
  monthWindow,
  scopeToAgents,
  unattributedCollected,
} from "@/lib/monthly-trend";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
  }
}
function eq(label: string, actual: unknown, expected: unknown) {
  ok(
    `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
    actual === expected,
  );
}

// ─── fixtures ───────────────────────────────────────────────────────────────────

function disp(time: string, outcome: string, extra: Partial<DispositionRecord> = {}) {
  return {
    id: `d${time}${outcome}`,
    debtorId: "x",
    debtorName: "x",
    phone: "",
    agentId: "a@x.com",
    agentName: "A",
    outcome,
    notes: "",
    time,
    ...extra,
  } as DispositionRecord;
}

function pay(when: string, amount: number, extra: Partial<PaymentRecord> = {}) {
  return {
    id: `p${when}${amount}`,
    debtorId: "x",
    debtorName: "x",
    loanId: "x",
    phone: "",
    agentName: "A",
    agentId: "a@x.com",
    collectorRole: "agent",
    amount,
    method: null,
    status: "completed",
    paymentType: "full",
    source: "agent",
    notes: "",
    receivedAt: when,
    createdAt: when,
    ...extra,
  } as PaymentRecord;
}

// ─── IST day bucketing ──────────────────────────────────────────────────────────

function istBucketing() {
  // 2026-08-01T00:30:00Z is 06:00 IST on the 1st — same day either way.
  eq("IST: 00:30Z on the 1st is the 1st", istDayKey("2026-08-01T00:30:00Z"), "2026-08-01");
  // 2026-07-31T19:00:00Z is 00:30 IST on 1 Aug. UTC bucketing (toISOString) would file this
  // under July and move a collection across the month boundary — the bug this guards.
  eq("IST: 19:00Z on 31 Jul is 1 Aug IST", istDayKey("2026-07-31T19:00:00Z"), "2026-08-01");
  // 2026-08-01T18:29:00Z is 23:59 IST on the 1st — still the 1st.
  eq("IST: 18:29Z on the 1st is still the 1st", istDayKey("2026-08-01T18:29:00Z"), "2026-08-01");
  eq("IST: empty input yields empty key", istDayKey(undefined), "");
  eq("IST: garbage input yields empty key", istDayKey("not-a-date"), "");

  // The boundary case end to end: a payment at 00:30 IST on 1 Aug must count in August.
  const c = compareMonths(
    [],
    [pay("2026-07-31T19:00:00Z", 5000)],
    new Date("2026-08-22T12:00:00Z"),
  );
  eq("IST: boundary payment lands in the current month", c.current.collected, 5000);
  eq("IST: boundary payment is not in last month", c.previousFull.collected, 0);
}

// ─── the window ─────────────────────────────────────────────────────────────────

function windows() {
  const w = monthWindow(new Date("2026-08-22T12:00:00Z"));
  eq("window: current month", w.currentMonth, 8);
  eq("window: previous month", w.previousMonth, 7);
  eq("window: previous year same", w.previousYear, 2026);
  eq("window: asOfDay", w.asOfDay, 22);
  eq("window: comparableDay", w.comparableDay, 22);
  eq("window: label", w.currentLabel, "Aug 2026");
  eq("window: previous label", w.previousLabel, "Jul 2026");

  // January rolls back into the previous December, year included.
  const jan = monthWindow(new Date("2026-01-05T12:00:00Z"));
  eq("window: Jan rolls back to Dec", jan.previousMonth, 12);
  eq("window: Jan rolls back a year", jan.previousYear, 2025);
  eq("window: Dec has 31 days", jan.daysInPrevious, 31);

  // The 31st of a month whose predecessor has 30 days: comparableDay must clamp, or the
  // comparison reads a day that does not exist and silently returns zero for it.
  const mar = monthWindow(new Date("2026-03-31T12:00:00Z"));
  eq("window: 31 Mar asOfDay", mar.asOfDay, 31);
  eq("window: clamped to Feb's 28", mar.comparableDay, 28);
  eq("window: Feb 2026 length", mar.daysInPrevious, 28);

  // IST vs UTC on the window itself: 2026-08-31T20:00:00Z is 01:30 IST on 1 Sep.
  const sep = monthWindow(new Date("2026-08-31T20:00:00Z"));
  eq("window: late-UTC-31-Aug is September in IST", sep.currentMonth, 9);
  eq("window: and its previous month is August", sep.previousMonth, 8);
}

// ─── like-for-like comparison ───────────────────────────────────────────────────

function comparison() {
  const now = new Date("2026-08-22T12:00:00Z");
  const disps = [
    disp("2026-08-05T06:00:00Z", "paid"),
    disp("2026-08-06T06:00:00Z", "promised", { ptpAmount: 3000 }),
    disp("2026-08-07T06:00:00Z", "no_answer"),
    disp("2026-08-07T07:00:00Z", "voicemail"),
    // 25 Aug is in the future relative to `now` — must not count toward month-to-date.
    disp("2026-08-25T06:00:00Z", "paid"),
    disp("2026-07-05T06:00:00Z", "paid"),
    disp("2026-07-28T06:00:00Z", "paid"), // after comparableDay=22, so same-period excludes it
  ];
  const payments = [
    pay("2026-08-10T06:00:00Z", 10_000),
    pay("2026-07-10T06:00:00Z", 4_000),
    pay("2026-07-30T06:00:00Z", 6_000), // last month, but past day 22
    pay("2026-08-11T06:00:00Z", 999, { status: "pending" }), // not completed
  ];
  const c = compareMonths(disps, payments, now);

  eq("compare: MTD calls counts only days 1-22", c.current.calls, 4);
  eq("compare: contacts excludes no_answer + voicemail", c.current.contacts, 2);
  eq("compare: ptps", c.current.ptps, 1);
  eq("compare: ptp value", c.current.ptpAmount, 3000);
  eq("compare: collected ignores pending payments", c.current.collected, 10_000);
  eq("compare: payment count", c.current.payments, 1);

  eq("compare: same-period last month stops at day 22", c.previousSamePeriod.calls, 1);
  eq("compare: same-period collected", c.previousSamePeriod.collected, 4_000);
  eq("compare: full last month includes the tail", c.previousFull.calls, 2);
  eq("compare: full last month collected", c.previousFull.collected, 10_000);

  // The whole point of the like-for-like window: a flat month must not read as a collapse
  // just because this month is only 22 days old.
  const flat = compareMonths(
    [],
    [
      pay("2026-08-10T06:00:00Z", 5_000),
      pay("2026-07-10T06:00:00Z", 5_000),
      pay("2026-07-27T06:00:00Z", 5_000),
    ],
    now,
  );
  eq(
    "compare: like-for-like is flat",
    deltaPct(flat.current.collected, flat.previousSamePeriod.collected),
    0,
  );
  // ₹5,000 this month vs ₹10,000 across all of last month. The same flat performance read as a
  // halving the moment the denominator became a full month — the reason the tiles compare
  // against previousSamePeriod and show previousFull only as context.
  eq(
    "compare: against the FULL month the same data reads as -50%",
    deltaPct(flat.current.collected, flat.previousFull.collected),
    -50,
  );
}

// ─── deltas ─────────────────────────────────────────────────────────────────────

function deltas() {
  eq("delta: plain increase", deltaPct(150, 100), 50);
  eq("delta: plain decrease", deltaPct(50, 100), -50);
  eq("delta: zero to zero is flat, not null", deltaPct(0, 0), 0);
  // 0 -> something has no percentage. Returning 0 here would report real progress as flat,
  // which is exactly what the UI must not do.
  eq("delta: zero baseline is null, not 0", deltaPct(57_500, 0), null);
  eq("delta: drop to zero is -100%", deltaPct(0, 100), -100);
}

// ─── the day-of-month series ────────────────────────────────────────────────────

function series() {
  const now = new Date("2026-08-22T12:00:00Z");
  const points = dailySeries(
    [],
    [
      pay("2026-08-03T06:00:00Z", 100),
      pay("2026-08-04T06:00:00Z", 200),
      pay("2026-07-03T06:00:00Z", 50),
    ],
    "collected",
    now,
  );

  eq("series: spans the longer of the two months", points.length, 31);
  eq("series: day 1 is 1-based", points[0].day, 1);

  const d3 = points[2];
  eq("series: day 3 current", d3.current, 100);
  eq("series: day 3 previous", d3.previous, 50);
  eq("series: day 3 cumulative current", d3.currentCumulative, 100);
  eq("series: day 4 cumulative current", points[3].currentCumulative, 300);
  eq("series: cumulative carries forward on an empty day", points[9].currentCumulative, 300);

  // Past today the current month has no data — null, not 0. A 0 would draw the running total
  // falling off a cliff to the x-axis and make an in-progress month look like a dead one.
  eq("series: today is the last non-null current point", points[21].current, 0);
  eq("series: tomorrow is null, not zero", points[22].current, null);
  eq("series: tomorrow's cumulative is null too", points[22].currentCumulative, null);
  eq("series: last month is populated across its whole length", points[30].previous, 0);

  // A 31-day current month against a 30-day previous: the previous line must stop, not zero out.
  const shortPrev = dailySeries([], [], "calls", new Date("2026-05-31T12:00:00Z"));
  eq("series: May spans 31", shortPrev.length, 31);
  eq("series: April has no day 31", shortPrev[30].previous, null);
  eq("series: but May day 31 exists", shortPrev[30].current, 0);
}

// ─── scoping ────────────────────────────────────────────────────────────────────

function scoping() {
  const now = new Date("2026-08-22T12:00:00Z");
  const disps = [
    disp("2026-08-05T06:00:00Z", "paid", { agentId: "a@x.com" }),
    disp("2026-08-06T06:00:00Z", "paid", { agentId: "b@x.com" }),
  ];
  const payments = [
    pay("2026-08-10T06:00:00Z", 1_000, { agentId: "a@x.com" }),
    pay("2026-08-11T06:00:00Z", 2_000, { agentId: "b@x.com" }),
    // A bank-reported paid-file row: nobody collected it.
    pay("2026-08-12T06:00:00Z", 9_000, { agentId: null, source: "bank_reported" }),
    pay("2026-07-12T06:00:00Z", 4_000, { agentId: null, source: "bank_reported" }),
  ];

  const a = scopeToAgents(disps, payments, ["a@x.com"]);
  eq("scope: one agent's calls", a.disps.length, 1);
  eq("scope: one agent's payments", a.payments.length, 1);
  ok(
    "scope: unattributed payment is excluded from an agent",
    a.payments.every((p) => p.agentId !== null),
  );

  const team = scopeToAgents(disps, payments, ["a@x.com", "b@x.com"]);
  eq("scope: team calls", team.disps.length, 2);
  eq(
    "scope: agent-credited team collections exclude the paid file",
    compareMonths(team.disps, team.payments, now).current.collected,
    3_000,
  );

  const un = unattributedCollected(payments, now);
  eq("scope: unattributed this month", un.current, 9_000);
  eq("scope: unattributed same period last month", un.previousSamePeriod, 4_000);

  // Company-wide (unscoped) must include it, or a paid file simply vanishes from the org total.
  eq(
    "scope: company total includes the paid file",
    compareMonths(disps, payments, now).current.collected,
    12_000,
  );
}

// ─── empty data ─────────────────────────────────────────────────────────────────

function empties() {
  const c = compareMonths([], [], new Date("2026-08-22T12:00:00Z"));
  eq("empty: no calls", c.current.calls, 0);
  eq("empty: no collections", c.current.collected, 0);
  eq(
    "empty: delta of nothing is flat",
    deltaPct(c.current.collected, c.previousSamePeriod.collected),
    0,
  );
  eq(
    "empty: series still spans the month",
    dailySeries([], [], "calls", new Date("2026-08-22T12:00:00Z")).length,
    31,
  );
}

/** Distinct account counting — the one metric that is NOT additive across days. */
function distinctAccounts() {
  const now = new Date("2026-08-22T12:00:00Z");
  // Same account worked on three separate days, plus one other account once.
  const disps = [
    disp("2026-08-10T06:00:00Z", "promised", { debtorId: "acc-1" }),
    disp("2026-08-11T06:00:00Z", "no_answer", { debtorId: "acc-1" }),
    disp("2026-08-12T06:00:00Z", "callback", { debtorId: "acc-1" }),
    disp("2026-08-12T07:00:00Z", "promised", { debtorId: "acc-2" }),
  ];
  const c = compareMonths(disps, [], now);
  eq("distinct: 4 calls across 3 days", c.current.calls, 4);
  eq("distinct: but only 2 accounts touched", c.current.uniqueAccounts, 2);

  // A payment on an account nobody called still counts as an account touched.
  const c2 = compareMonths(disps, [pay("2026-08-13T06:00:00Z", 500, { debtorId: "acc-3" })], now);
  eq("distinct: payment-only account counts", c2.current.uniqueAccounts, 3);

  // The cumulative series must union, not add: on the 12th the running total is still 2.
  const series = dailySeries(disps, [], "uniqueAccounts", now);
  const on12 = series.find((p) => p.day === 12);
  eq("distinct: cumulative unions across days", on12?.currentCumulative, 2);
  eq("distinct: that day alone saw 2 accounts", on12?.current, 2);
  const on11 = series.find((p) => p.day === 11);
  eq("distinct: repeat visit does not raise the cumulative", on11?.currentCumulative, 1);
}

/** POS metrics: distinct-set money, and the month picker. */
function posAndPicker() {
  const now = new Date("2026-08-22T12:00:00Z");
  const pos = new Map([
    ["acc-1", 100_000],
    ["acc-2", 50_000],
  ]);
  const disps = [
    // acc-1 worked three times, promised once. Its principal must count ONCE.
    disp("2026-08-10T06:00:00Z", "no_answer", { debtorId: "acc-1" }),
    disp("2026-08-11T06:00:00Z", "promised", { debtorId: "acc-1", ptpAmount: 9000 }),
    disp("2026-08-12T06:00:00Z", "callback", { debtorId: "acc-1" }),
    disp("2026-08-12T07:00:00Z", "no_answer", { debtorId: "acc-2" }),
  ];
  const c = compareMonths(disps, [], now, pos);
  eq("pos: worked counts each account's principal once", c.current.posWorked, 150_000);
  eq("pos: promised is only the account that promised", c.current.posPromised, 100_000);

  // ptpAmount and posPromised answer different questions and must not track each other.
  eq("pos: ptpAmount is the promise, not the book behind it", c.current.ptpAmount, 9000);

  // Without a POS map every other metric still works and POS is simply 0.
  const noPos = compareMonths(disps, [], now);
  eq("pos: absent map does not break other metrics", noPos.current.calls, 4);
  eq("pos: absent map yields zero POS", noPos.current.posWorked, 0);

  // Cumulative POS unions rather than adding — acc-1 worked on 3 days is still 100k.
  const series = dailySeries(disps, [], "posWorked", now, pos);
  const on12 = series.find((p) => p.day === 12);
  eq("pos: cumulative unions across days", on12?.currentCumulative, 150_000);

  // Month picker: compare against an explicit earlier month.
  const picked = compareMonths(disps, [], now, pos, "2026-06");
  eq("picker: comparison month is honoured", picked.window.previousMonth, 6);
  eq("picker: comparison year is honoured", picked.window.previousYear, 2026);
  // A future or same month is nonsense to compare against and falls back to the default.
  eq(
    "picker: refuses to compare a month against itself",
    compareMonths(disps, [], now, pos, "2026-08").window.previousMonth,
    7,
  );
  eq(
    "picker: refuses a future month",
    compareMonths(disps, [], now, pos, "2026-12").window.previousMonth,
    7,
  );
}

istBucketing();
windows();
comparison();
deltas();
series();
scoping();
empties();
distinctAccounts();
posAndPicker();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
