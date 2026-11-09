// Rules behind the Call Auditor portal and the banker's feedback file. Run: bun test scripts/
import { describe, expect, test } from "bun:test";
import {
  FATAL_ERRORS,
  SCORECARD,
  auditHasContent,
  buildAuditQueue,
  buildTeamPerformance,
  istWeekStart,
  computeScore,
  gradeFor,
  isAnswered,
  istRangeBounds,
  type AuditCallRow,
  type ScoreAnswers,
} from "../src/lib/call-audit";
import { auditFeedbackSheet, callLogSheet, performanceSheet } from "../src/lib/call-audit-reports";
import {
  LOAN_HEADERS,
  bestCall,
  bestTimeToCall,
  buildFeedbackSheets,
  clampCell,
  feedbackTrail,
  missedFollowUps,
  MAX_CELL,
  type FeedbackDebtor,
  type FeedbackInput,
} from "../src/lib/portfolio-feedback";

const call = (over: Partial<AuditCallRow>): AuditCallRow =>
  ({
    call_id: "c1",
    created_at: "2026-11-09T06:00:00.000Z",
    agent_id: "a1",
    agent_name: "Asha",
    agent_code: "AGT-1",
    outcome: "no_answer",
    outcome_reason: null,
    raw_notes: null,
    duration_seconds: 0,
    ring_seconds: null,
    wrap_seconds: null,
    promise_amount: null,
    promise_date: null,
    callback_date: null,
    debtor_id: "d1",
    dial_mode: "manual",
    team_name: "Team A",
    manager_name: "Rohit",
    audit_id: null,
    ...over,
  }) as AuditCallRow;

const allYes = (): ScoreAnswers =>
  Object.fromEntries(SCORECARD.map((p) => [p.id, { value: "yes" as const }]));

describe("scorecard", () => {
  test("weights add up to 100", () => {
    expect(SCORECARD.reduce((a, p) => a + p.weight, 0)).toBe(100);
  });

  test("parameter and fatal ids are unique", () => {
    expect(new Set(SCORECARD.map((p) => p.id)).size).toBe(SCORECARD.length);
    expect(new Set(FATAL_ERRORS.map((f) => f.id)).size).toBe(FATAL_ERRORS.length);
  });

  test("full marks", () => {
    const s = computeScore(allYes(), []);
    expect(s).toMatchObject({ earned: 100, possible: 100, finalPercent: 100, grade: "Excellent" });
  });

  test("N/A and unanswered leave the denominator", () => {
    const s = computeScore({ greeting: { value: "yes" }, tone: { value: "na" } }, []);
    expect(s.possible).toBe(5);
    expect(s.finalPercent).toBe(100);
  });

  test("partly is half marks", () => {
    expect(computeScore({ tone: { value: "partial" } }, []).finalPercent).toBe(50);
  });

  test("a fatal error zeroes the final score but keeps the raw one", () => {
    const s = computeScore(allYes(), ["abuse"]);
    expect(s).toMatchObject({ rawPercent: 100, finalPercent: 0, grade: "Fatal", fatal: true });
  });

  test("an unknown fatal code from the browser is ignored", () => {
    expect(computeScore(allYes(), ["made_up"]).fatal).toBe(false);
  });

  test("grade boundaries", () => {
    expect(gradeFor(90, false)).toBe("Excellent");
    expect(gradeFor(89.99, false)).toBe("Good");
    expect(gradeFor(75, false)).toBe("Good");
    expect(gradeFor(60, false)).toBe("Needs Improvement");
    expect(gradeFor(59.99, false)).toBe("Poor");
  });

  test("an empty review is refused", () => {
    expect(auditHasContent({}, [])).toBe(false);
    expect(auditHasContent({}, ["abuse"])).toBe(true);
  });
});

describe("answered", () => {
  test("telephony decides when it knows; the disposition only when it does not", () => {
    expect(isAnswered({ ledger_status: "completed", outcome: "no_answer" })).toBe(true);
    expect(isAnswered({ ledger_status: "canceled", outcome: "promised" })).toBe(false);
    expect(isAnswered({ ledger_status: null, outcome: "promised" })).toBe(true);
    expect(isAnswered({ ledger_status: null, outcome: "no_answer" })).toBe(false);
  });
});

describe("dates", () => {
  test("a range runs midnight to midnight IST", () => {
    const b = istRangeBounds("2026-11-01", "2026-11-05");
    expect(new Date(b.from).toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(new Date(b.to).toISOString()).toBe("2026-11-05T18:30:00.000Z");
  });
});

describe("feedback by loan", () => {
  test("best disposition beats a later worse one", () => {
    const b = bestCall([
      call({ call_id: "ptp", outcome: "promised", created_at: "2026-11-01T06:00:00Z" }),
      call({ call_id: "na", outcome: "no_answer", created_at: "2026-11-02T06:00:00Z" }),
    ]);
    expect(b?.call_id).toBe("ptp");
  });

  test("the trail is dated, newest day first, in IST", () => {
    const trail = feedbackTrail([
      call({ created_at: "2026-11-08T19:00:00Z", outcome: "callback", raw_notes: "after 5" }),
      call({ created_at: "2026-11-07T06:00:00Z", outcome: "promised", raw_notes: "will pay" }),
    ]);
    // 19:00 UTC on the 8th is already the 9th in IST.
    expect(trail).toBe("09/11/2026. Call Back - after 5 // 07/11/2026. PTP - will pay");
  });

  test("best time is the busiest answered hour", () => {
    expect(
      bestTimeToCall([
        call({ outcome: "promised", created_at: "2026-11-09T05:40:00Z" }), // 11:10 IST
        call({ outcome: "callback", created_at: "2026-11-08T05:50:00Z" }), // 11:20 IST
        call({ outcome: "paid", created_at: "2026-11-07T10:00:00Z" }), // 15:30 IST
        call({ outcome: "no_answer", created_at: "2026-11-06T10:00:00Z" }),
        call({ outcome: "no_answer", created_at: "2026-11-05T10:00:00Z" }),
      ]),
    ).toBe("11:00-12:00");
  });

  test("a callback counts as missed only once due and never called after", () => {
    const made = call({
      outcome: "callback",
      callback_date: "2026-11-05",
      created_at: "2026-11-01T06:00:00Z",
    });
    const later = call({ created_at: "2026-11-05T06:00:00Z" });
    expect(missedFollowUps([made], "2026-11-09").callback).toBe(1);
    expect(missedFollowUps([made, later], "2026-11-09").callback).toBe(0);
    expect(missedFollowUps([made], "2026-11-03").callback).toBe(0);
  });

  test("an over-long cell is cut below Excel's limit", () => {
    expect(clampCell("x".repeat(40_000)).length).toBeLessThanOrEqual(MAX_CELL);
  });

  const debtor = (id: string): FeedbackDebtor => ({
    id,
    name: `Name ${id}`,
    phone_primary: "9800000000",
    loan_reference: `L-${id}`,
    loan_amount: 1000,
    outstanding_balance: 1000,
    dpd: 30,
    lender: "Bank",
    product_type: "PL",
    status: "active",
    assigned_agent_id: null,
  });
  const input = (over: Partial<FeedbackInput>): FeedbackInput => ({
    portfolioName: "P1",
    lenderName: "Bank",
    debtors: [debtor("d1"), debtor("d2")],
    calls: [
      call({
        debtor_id: "d1",
        outcome: "promised",
        promise_amount: 500,
        promise_date: "2026-11-20",
        raw_notes: "ok",
      }),
    ],
    payments: [
      {
        debtor_id: "d1",
        amount: 200,
        status: "completed",
        source: "agent",
        payment_method: null,
        notes: null,
        received_at: "2026-10-01T06:00:00Z",
        created_at: "2026-10-01T06:00:00Z",
      },
      {
        debtor_id: "d1",
        amount: 300,
        status: "completed",
        source: "agent",
        payment_method: null,
        notes: null,
        received_at: "2026-11-01T06:00:00Z",
        created_at: "2026-11-01T06:00:00Z",
      },
    ],
    settlements: [],
    disputes: [],
    agentNames: new Map(),
    from: "2026-11-05",
    to: "2026-11-09",
    includeNoActivity: true,
    ...over,
  });
  const cell = (row: (string | number)[], h: string) => row[LOAN_HEADERS.indexOf(h)];

  test("one row per loan, columns line up, money totals across all time", () => {
    const [loans] = buildFeedbackSheets(input({}), "2026-11-09");
    expect(loans.rows.length).toBe(2);
    for (const r of loans.rows) expect(r.length).toBe(LOAN_HEADERS.length);
    const r = loans.rows[0] as (string | number)[];
    expect(cell(r, "Till Date Collected")).toBe(500);
    expect(cell(r, "Last Paid Amount in Allocation")).toBe(300);
    expect(cell(r, "PTP Amount")).toBe(500);
    expect(cell(r, "Code")).toBe("CONNECTED");
    expect(String(cell(r, "Grouping Disposition"))).toContain("PTP - ok");
    expect(cell(loans.rows[1] as (string | number)[], "Best Disposition Name")).toBe("Not Called");
  });

  test("the banker's file can leave out untouched loans", () => {
    const [loans] = buildFeedbackSheets(input({ includeNoActivity: false }), "2026-11-09");
    expect(loans.rows.length).toBe(1);
  });

  test("All Feedback only shows the chosen period", () => {
    const [, all] = buildFeedbackSheets(input({}), "2026-11-09");
    expect(all.rows.filter((r) => r[5] === "Payment").length).toBe(0);
    expect(all.rows.filter((r) => r[5] === "Call").length).toBe(1);
  });

  test("the file that goes to the bank carries no audit data", () => {
    const sheets = buildFeedbackSheets(
      input({
        calls: [call({ internal_note: "SECRET", feedback_manager: "SECRET", audit_id: "x" })],
      }),
      "2026-11-09",
    );
    expect(JSON.stringify(sheets)).not.toContain("SECRET");
    expect(JSON.stringify(sheets.map((s) => s.headers))).not.toMatch(/audit|score|grade|fatal/i);
  });
});

describe("reports", () => {
  test("the call log starts with the company's own export columns, in order", () => {
    const { headers } = callLogSheet([call({})], "https://x");
    expect(headers.slice(0, 5)).toEqual([
      "Allocator Name",
      "Allocation File Name",
      "Agency ID",
      "Loan Account Number",
      "Call Date",
    ]);
    expect(headers[48]).toBe("Grouping Disposition");
  });

  test("every bank-file field becomes a column and every row lines up", () => {
    const sheet = callLogSheet(
      [call({ extra: { Branch: "Pune" } }), call({ call_id: "c2", extra: { Zone: "West" } })],
      "https://x",
    );
    expect(sheet.headers).toContain("Bank: Branch");
    expect(sheet.headers).toContain("Bank: Zone");
    for (const r of sheet.rows) expect(r.length).toBe(sheet.headers.length);
  });

  test("Audit + Feedback has only reviewed calls, with each parameter", () => {
    const sheet = auditFeedbackSheet(
      [
        call({
          audit_id: "a",
          scores: { tone: { value: "yes", remark: "calm" } },
          feedback_agent: "good",
        }),
        call({ call_id: "c2" }),
      ],
      "https://x",
    );
    expect(sheet.rows.length).toBe(1);
    expect(sheet.rows[0].length).toBe(sheet.headers.length);
    expect(sheet.rows[0]).toContain("calm");
    expect(sheet.rows[0]).toContain("good");
  });

  test("performance matches the sample's formulas and leaves unknown time blank", () => {
    const c = call({ outcome: "promised", duration_seconds: 3760, wrap_seconds: 3600 });
    const presence = [
      {
        agent_id: "a1",
        status: "available",
        started_at: "2026-11-09T04:00:00Z",
        ended_at: "2026-11-09T06:57:32Z",
      },
    ];
    const { headers, rows } = performanceSheet([c], presence);
    const v = (h: string) => rows[0][headers.indexOf(h)];
    expect(rows[0].length).toBe(headers.length);
    expect(v("Wrap %")).toBe(33.8); // the sample's first row: 1:00:00 of 2:57:32
    expect(v("Utilisation %")).toBe(69.1);
    expect(v("Tea Break")).toBe("");
    const none = performanceSheet([c], []);
    expect(none.rows[0][none.headers.indexOf("Login Time")]).toBe("");
    expect(none.rows[0][none.headers.indexOf("Wrap %")]).toBe("");
  });
});

describe("a manager's team", () => {
  const reviewed = (agent: string, score: number, tone: "yes" | "no", over = {}) =>
    call({
      agent_id: agent,
      agent_name: agent,
      audit_id: "x",
      final_percent: score,
      ledger_status: "completed",
      duration_seconds: 60,
      scores: { tone: { value: tone }, greeting: { value: "yes" } },
      ...over,
    });

  test("totals, best agent first, unreviewed agents last", () => {
    const p = buildTeamPerformance([
      reviewed("low", 40, "no"),
      reviewed("high", 90, "yes"),
      call({ agent_id: "none", agent_name: "none" }),
    ]);
    expect(p.calls).toBe(3);
    expect(p.connected).toBe(2);
    expect(p.talk_seconds).toBe(120);
    expect(p.not_audited).toBe(1);
    expect(p.avg_score).toBe(65);
    expect(p.agents.map((a) => a.agent_id)).toEqual(["high", "low", "none"]);
    expect(p.agents[2].avg_score).toBeNull();
  });

  test("weakest scorecard question comes first", () => {
    const p = buildTeamPerformance([reviewed("a", 50, "no")]);
    expect(p.parameters[0].id).toBe("tone");
    expect(p.parameters[0].percent).toBe(0);
    expect(p.agents[0].weakest).toBe(p.parameters[0].label);
  });

  test("a manager's Excel has no internal note, but the auditor's does", () => {
    const row = reviewed("a", 80, "yes", { internal_note: "PRIVATE" });
    const mine = auditFeedbackSheet([row], "https://x", "manager");
    expect(mine.headers).not.toContain("Internal Note");
    expect(JSON.stringify(mine.rows)).not.toContain("PRIVATE");
    expect(mine.rows[0].length).toBe(mine.headers.length);
    expect(String(mine.rows[0][mine.rows[0].length - 1])).toContain("/manager/audit?call=");
    expect(auditFeedbackSheet([row], "https://x").headers).toContain("Internal Note");
  });
});

describe("audit queue", () => {
  const q = (id: string, agent: string, over = {}) =>
    call({ call_id: id, agent_id: agent, agent_name: agent, ...over });

  test("picks only what is left of the target", () => {
    const [a] = buildAuditQueue(
      [q("1", "a", { audit_id: "x" }), q("2", "a"), q("3", "a"), q("4", "a")],
      3,
    );
    expect(a.audited).toBe(1);
    expect(a.remaining).toBe(2);
    expect(a.picks.length).toBe(2);
    expect(a.picks.every((c) => !c.audit_id)).toBe(true);
  });

  test("the sample is stable however the rows arrive", () => {
    const ids = ["a1", "b2", "c3", "d4", "e5", "f6"];
    const one = buildAuditQueue(
      ids.map((i) => q(i, "a")),
      2,
    )[0].picks.map((c) => c.call_id);
    const two = buildAuditQueue(
      [...ids].reverse().map((i) => q(i, "a")),
      2,
    )[0].picks.map((c) => c.call_id);
    expect(one).toEqual(two);
  });

  test("calls with a recording are picked first", () => {
    const [a] = buildAuditQueue(
      [q("1", "a"), q("2", "a"), q("3", "a", { recording_url: "samvadx-recording:x" })],
      1,
    );
    expect(a.picks[0].call_id).toBe("3");
  });

  test("target reached means nothing more to pick", () => {
    const [a] = buildAuditQueue([q("1", "a", { audit_id: "x" }), q("2", "a")], 1);
    expect(a.picks).toEqual([]);
  });

  test("the week starts on Monday, in IST", () => {
    // Sunday 8 Nov 2026 19:00 UTC is already Monday 9 Nov in IST.
    expect(istWeekStart(new Date("2026-11-08T19:00:00Z"))).toBe("2026-11-09");
    expect(istWeekStart(new Date("2026-11-08T10:00:00Z"))).toBe("2026-11-02");
  });
});
