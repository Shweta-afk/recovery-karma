// The rules that decide which accounts get their data stripped. Getting these wrong either
// strips an account someone is still working (a live PTP, a retention request with the bank) or
// never archives anything — so each edge is pinned here.
import { describe, expect, test } from "bun:test";
import {
  DEAD_AFTER_DAYS,
  buildDeadAccountSheets,
  deadAccountFilePath,
  hasOpenCommitment,
  isPastDeadCutoff,
  istDateTime,
  istDayKeyMinus,
  pickDeadDebtors,
  type CallLogLite,
} from "../src/lib/dead-accounts-shared";

const log = (over: Partial<CallLogLite>): CallLogLite => ({
  id: "l1",
  debtor_id: "d1",
  agent_id: "a1",
  outcome: "no_answer",
  created_at: "2026-09-01T06:00:00Z",
  ...over,
});

describe("istDayKeyMinus", () => {
  test("crosses month and year boundaries on the calendar, not in UTC", () => {
    expect(istDayKeyMinus("2026-03-01", 1)).toBe("2026-02-28");
    expect(istDayKeyMinus("2027-01-10", 60)).toBe("2026-11-11");
    expect(istDayKeyMinus("2026-10-21", 60)).toBe("2026-08-22");
  });
});

describe("isPastDeadCutoff", () => {
  test(`needs a close at least ${DEAD_AFTER_DAYS} IST days ago`, () => {
    // Closed 2026-08-22 IST -> first eligible on 2026-10-21.
    expect(isPastDeadCutoff("2026-08-22T06:00:00Z", "2026-10-20")).toBe(false);
    expect(isPastDeadCutoff("2026-08-22T06:00:00Z", "2026-10-21")).toBe(true);
  });
  test("uses the IST day of the close, not the UTC day", () => {
    // 2026-08-21 20:00 UTC is 2026-08-22 01:30 IST — counts from the 22nd.
    expect(isPastDeadCutoff("2026-08-21T20:00:00Z", "2026-10-20")).toBe(false);
  });
  test("an open portfolio is never dead", () => {
    expect(isPastDeadCutoff(null, "2030-01-01")).toBe(false);
    expect(isPastDeadCutoff(undefined, "2030-01-01")).toBe(false);
  });
});

describe("hasOpenCommitment", () => {
  const today = "2026-11-30";
  test("no calls, or a latest call that isn't a commitment, is not open", () => {
    expect(hasOpenCommitment([], today)).toBe(false);
    expect(hasOpenCommitment([log({ outcome: "refused" })], today)).toBe(false);
  });
  test("a PTP due inside the window keeps the account alive", () => {
    expect(
      hasOpenCommitment([log({ outcome: "promised", promise_date: "2026-11-01" })], today),
    ).toBe(true);
  });
  test("a PTP that went stale before the window does not", () => {
    expect(
      hasOpenCommitment([log({ outcome: "promised", promise_date: "2026-09-01" })], today),
    ).toBe(false);
  });
  test("callbacks are judged on callback_date, not promise_date", () => {
    expect(
      hasOpenCommitment(
        [log({ outcome: "callback", callback_date: "2026-11-20", promise_date: null })],
        today,
      ),
    ).toBe(true);
  });
  test("a commitment with no date fails safe — treated as open", () => {
    expect(hasOpenCommitment([log({ outcome: "promised", promise_date: null })], today)).toBe(true);
  });
  test("only the LATEST disposition counts", () => {
    const newestFirst = [
      log({ id: "new", outcome: "refused", created_at: "2026-11-10T00:00:00Z" }),
      log({ id: "old", outcome: "promised", promise_date: "2026-11-25" }),
    ];
    expect(hasOpenCommitment(newestFirst, today)).toBe(false);
  });
});

describe("pickDeadDebtors", () => {
  test("keeps open-retention and open-commitment accounts, archives the rest", () => {
    const logs = new Map([
      ["ptp", [log({ debtor_id: "ptp", outcome: "promised", promise_date: "2026-11-25" })]],
      ["done", [log({ debtor_id: "done", outcome: "refused" })]],
    ]);
    const { archive, skipped } = pickDeadDebtors(
      ["ptp", "done", "silent", "ret"],
      logs,
      new Set(["ret"]),
      "2026-11-30",
    );
    expect(archive.sort()).toEqual(["done", "silent"]);
    expect(skipped).toEqual([
      { id: "ptp", reason: "open_commitment" },
      { id: "ret", reason: "open_retention" },
    ]);
  });
});

describe("buildDeadAccountSheets", () => {
  const debtor = {
    id: "d1",
    name: "Ravi Kumar",
    phone_primary: "9876543210",
    alt_phones: ["9123456780"],
    loan_reference: "L-1",
  };
  const logs = new Map([
    [
      "d1",
      [
        log({
          outcome: "promised",
          raw_notes: "will pay friday",
          promise_amount: "5000",
          promise_date: "2026-09-05",
          created_at: "2026-09-01T06:00:00Z",
        }),
      ],
    ],
  ]);
  const traces = new Map([
    [
      "d1",
      [
        {
          id: "t1",
          debtor_id: "d1",
          service_id: "employment-latest",
          provider_status: "1",
          cost: "5",
          response: { status: 1, data: { employer_name: "Acme", message: "ok" } },
          created_at: "2026-09-02T06:00:00Z",
        },
      ],
    ],
  ]);
  const sheets = buildDeadAccountSheets([debtor], logs, traces, new Map([["a1", "Asha"]]));
  const [accounts, calls, insights] = sheets;

  test("three sheets, slim — no bank-file columns", () => {
    expect(sheets.map((s) => s.name)).toEqual(["Accounts", "Calls & feedback", "Insights"]);
    expect(accounts.columns.join("|")).not.toMatch(/extra|address|employer/i);
  });
  test("accounts sheet summarises the last disposition", () => {
    expect(accounts.rows[0].slice(0, 5)).toEqual([
      "Ravi Kumar",
      "L-1",
      "9876543210",
      "9123456780",
      "PTP",
    ]);
  });
  test("each call keeps its feedback, agent name and promise", () => {
    const row = calls.rows[0];
    expect(row[4]).toBe("Asha");
    expect(row[5]).toBe("PTP");
    expect(row[7]).toBe("will pay friday");
    expect(row[9]).toBe(5000);
    expect(row[10]).toBe("2026-09-05");
  });
  test("each Insights result is labelled and its fields flattened, without envelope noise", () => {
    const row = insights.rows[0];
    expect(row[4]).toBe("Found");
    expect(row[6]).toBe(5);
    expect(String(row[7])).toContain("Employer Name: Acme");
    expect(String(row[7])).not.toContain("ok");
  });
});

describe("istDateTime", () => {
  test("formats in IST", () => {
    expect(istDateTime("2026-09-01T20:00:00Z")).toBe("2026-09-02 01:30");
    expect(istDateTime(null)).toBe("");
    expect(istDateTime("garbage")).toBe("");
  });
});

describe("deadAccountFilePath", () => {
  test("company first, then portfolio, with a safe file name", () => {
    expect(deadAccountFilePath("c1", "p1", "CC Sep 2026 / RBL", "2026-10-21", 812)).toBe(
      "c1/p1/2026-10-21_CC-Sep-2026-RBL_812-accounts.xlsx",
    );
    expect(deadAccountFilePath("c1", "p1", "///", "2026-10-21", 1)).toBe(
      "c1/p1/2026-10-21_portfolio_1-accounts.xlsx",
    );
  });
});
