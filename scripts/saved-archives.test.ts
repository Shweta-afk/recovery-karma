// SamvadX's own archive copies: which portfolios the daily run saves (never a back-fill of every
// portfolio that ever closed), where files go (company first — downloads trust that), and that a
// portfolio copy keeps the whole bank file.
import { describe, expect, test } from "bun:test";
import {
  AUTO_SAVE_WINDOW_DAYS,
  buildPortfolioArchiveSheets,
  downloadName,
  endedWithoutCopy,
  endingKey,
  monthArchivePath,
  portfolioArchivePath,
  portfolioEnding,
  sheetCounts,
} from "../src/lib/saved-archives";

const TODAY = "2026-10-29";

describe("portfolioEnding", () => {
  test("still running: no close, end date today or later", () => {
    expect(portfolioEnding({ closed_at: null, end_date: null }, TODAY)).toBeNull();
    expect(portfolioEnding({ closed_at: null, end_date: TODAY }, TODAY)).toBeNull();
    expect(portfolioEnding({ closed_at: null, end_date: "2026-11-30" }, TODAY)).toBeNull();
  });

  test("end date passed", () => {
    expect(portfolioEnding({ closed_at: null, end_date: "2026-10-28" }, TODAY)).toEqual({
      endedOn: "2026-10-28",
      endedBy: "end_date",
    });
  });

  test("closed wins, and its day is the IST day", () => {
    // 20:00 UTC on the 27th is 01:30 IST on the 28th.
    expect(
      portfolioEnding({ closed_at: "2026-10-27T20:00:00Z", end_date: "2026-10-01" }, TODAY),
    ).toEqual({ endedOn: "2026-10-28", endedBy: "closed" });
  });
});

describe("endedWithoutCopy", () => {
  const p = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: `P ${id}`,
    closed_at: null as string | null,
    end_date: null as string | null,
    deleted_at: null as string | null,
    ...over,
  });

  test("the daily window skips old endings (no back-fill)", () => {
    const rows = [
      p("recent", { end_date: "2026-10-25" }),
      p("edge", { end_date: "2026-10-22" }), // exactly AUTO_SAVE_WINDOW_DAYS ago
      p("old", { end_date: "2026-10-21" }),
      p("ancient", { closed_at: "2026-06-01T06:00:00Z" }),
      p("running", { end_date: "2026-11-30" }),
    ];
    expect(AUTO_SAVE_WINDOW_DAYS).toBe(7);
    const due = endedWithoutCopy(rows, new Set(), TODAY, AUTO_SAVE_WINDOW_DAYS);
    expect(due.map((d) => d.id)).toEqual(["recent", "edge"]);
  });

  test("without a window, every ending without a copy (newest first)", () => {
    const rows = [p("a", { end_date: "2026-01-10" }), p("b", { end_date: "2026-09-10" })];
    expect(endedWithoutCopy(rows, new Set(), TODAY).map((d) => d.id)).toEqual(["b", "a"]);
  });

  test("an ending that already has a copy is skipped; a later re-close is not", () => {
    const rows = [p("x", { closed_at: "2026-10-28T06:00:00Z" })];
    expect(endedWithoutCopy(rows, new Set([endingKey("x", "2026-10-28")]), TODAY)).toEqual([]);
    // Reopened and closed again on another day -> a second, dated copy.
    expect(endedWithoutCopy(rows, new Set([endingKey("x", "2026-10-01")]), TODAY)).toHaveLength(1);
  });

  test("deleted portfolios are skipped", () => {
    const rows = [p("d", { end_date: "2026-10-28", deleted_at: "2026-10-28T10:00:00Z" })];
    expect(endedWithoutCopy(rows, new Set(), TODAY)).toEqual([]);
  });

  test("keeps the caller's own fields (client_id)", () => {
    const rows = [{ ...p("c", { end_date: "2026-10-28" }), client_id: "client-1" }];
    expect(endedWithoutCopy(rows, new Set(), TODAY)[0].client_id).toBe("client-1");
  });
});

describe("paths and names", () => {
  test("company first", () => {
    expect(portfolioArchivePath("c1", "p1", "HDFC Oct / 2026", "2026-10-28")).toBe(
      "c1/portfolios/p1/2026-10-28_HDFC-Oct-2026.xlsx",
    );
    expect(monthArchivePath("c1", "2026-09")).toBe("c1/months/2026-09.xlsx");
  });

  test("download names", () => {
    expect(
      downloadName({
        kind: "month",
        portfolio_name: null,
        ended_on: null,
        month: "2026-09",
        company: "RR Debt",
      }),
    ).toBe("samvadx-archive-RR-Debt-2026-09.xlsx");
    expect(
      downloadName({
        kind: "portfolio_end",
        portfolio_name: "Kotak 30+",
        ended_on: "2026-10-28",
        month: null,
        company: "Kuber",
      }),
    ).toBe("samvadx-portfolio-Kuber-Kotak-30-ended-2026-10-28.xlsx");
  });
});

describe("buildPortfolioArchiveSheets", () => {
  const debtor = {
    id: "d1",
    name: "Asha",
    phone_primary: "9800000001",
    alt_phones: ["9800000002"],
    loan_reference: "LN-1",
    loan_amount: 50000,
    extra: { Branch: "Pune", "EMI Amount": "2500" },
  };
  const sheets = buildPortfolioArchiveSheets({
    portfolio: { name: "HDFC Oct", lender_name: "HDFC", end_date: "2026-10-28", closed_at: null },
    ending: { endedOn: "2026-10-28", endedBy: "end_date" },
    savedAtIso: "2026-10-28T20:30:00Z",
    debtors: [debtor],
    logsByDebtor: new Map([
      [
        "d1",
        [
          {
            id: "l1",
            debtor_id: "d1",
            agent_id: "a1",
            outcome: "promised",
            raw_notes: "Will pay Friday",
            promise_amount: 2500,
            promise_date: "2026-10-31",
            created_at: "2026-10-20T06:00:00Z",
          },
        ],
      ],
    ]),
    tracesByDebtor: new Map(),
    payments: [{ id: "pay1", debtor_id: "d1", amount: 2500, status: "completed" }],
    settlements: [],
    disputes: [],
    agentNameById: new Map([["a1", "Ravi"]]),
  });
  const byName = Object.fromEntries(sheets.map((s) => [s.name, s]));

  test("sheet order", () => {
    expect(sheets.map((s) => s.name)).toEqual([
      "Portfolio",
      "Accounts",
      "Calls & feedback",
      "Insights",
      "Payments",
      "Settlements",
      "Disputes",
    ]);
  });

  test("Accounts keeps every bank-file column, one column each", () => {
    const acc = byName.Accounts;
    expect(acc.columns).toContain("extra: Branch");
    expect(acc.columns).toContain("extra: EMI Amount");
    expect(acc.columns).toContain("loan_amount");
    expect(acc.rows[0][acc.columns.indexOf("extra: Branch")]).toBe("Pune");
  });

  test("calls carry the agent and feedback", () => {
    const calls = byName["Calls & feedback"];
    const row = calls.rows[0];
    expect(row[calls.columns.indexOf("Agent")]).toBe("Ravi");
    expect(row[calls.columns.indexOf("Feedback / notes")]).toBe("Will pay Friday");
  });

  test("payments name the borrower", () => {
    const pay = byName.Payments;
    expect(pay.columns.slice(0, 2)).toEqual(["Name", "Loan ID"]);
    expect(pay.rows[0].slice(0, 2)).toEqual(["Asha", "LN-1"]);
  });

  test("counts per sheet", () => {
    expect(sheetCounts(sheets)).toMatchObject({ Accounts: 1, "Calls & feedback": 1, Payments: 1 });
  });
});
