import { describe, expect, test } from "bun:test";
import {
  NO_DPD_LABEL,
  buildAllocation,
  bucketFor,
  defaultToLines,
  formatLetterDate,
  purgeLetterText,
  purgePeriodLabel,
  type PurgeCertificate,
} from "../src/lib/data-purge";

describe("DPD buckets", () => {
  test("edges land in the right bucket", () => {
    expect(bucketFor(0)).toBe("0-30");
    expect(bucketFor(90)).toBe("61-90");
    expect(bucketFor(91)).toBe("91-120");
    expect(bucketFor(500)).toBe("361-500");
    expect(bucketFor(501)).toBe("501+");
    expect(bucketFor(5000)).toBe("501+");
    expect(bucketFor(120.7)).toBe("91-120");
  });

  test("missing or negative DPD is its own row, last", () => {
    expect(bucketFor(null)).toBe(NO_DPD_LABEL);
    expect(bucketFor(-3)).toBe(NO_DPD_LABEL);
    const a = buildAllocation([
      { dpd: null, outstanding: 10 },
      { dpd: 700, outstanding: 100 },
    ]);
    expect(a.rows.map((r) => r.bucket)).toEqual(["501+", NO_DPD_LABEL]);
  });
});

describe("buildAllocation", () => {
  test("counts and sums per bucket in bucket order, empty buckets dropped", () => {
    const a = buildAllocation([
      { dpd: 600, outstanding: 1000.105 },
      { dpd: 95, outstanding: 200 },
      { dpd: 700, outstanding: 0.2 },
      { dpd: 100, outstanding: null },
    ]);
    expect(a.rows).toEqual([
      { bucket: "91-120", accounts: 2, outstanding: 200 },
      { bucket: "501+", accounts: 2, outstanding: 1000.31 },
    ]);
    expect(a.totalAccounts).toBe(4);
    expect(a.totalOutstanding).toBe(1200.31);
  });

  test("an empty portfolio gives an empty table", () => {
    expect(buildAllocation([])).toEqual({ rows: [], totalAccounts: 0, totalOutstanding: 0 });
  });
});

describe("letter", () => {
  test("period and date in the sample letter's style", () => {
    expect(purgePeriodLabel("2026-04-17")).toBe("April-2026");
    expect(formatLetterDate("2026-05-05")).toBe("05/05/2026");
  });

  test("addressee defaults to the company's signatory, name and address", () => {
    expect(
      defaultToLines({
        legalName: "Acme Ltd",
        address: "Mumbai",
        signatoryDesignation: "Director",
      }),
    ).toEqual(["The Director", "Acme Ltd", "Mumbai"]);
    expect(defaultToLines({ legalName: "Acme Ltd", address: "" })).toEqual([
      "The Authorised Signatory",
      "Acme Ltd",
    ]);
  });

  test("text names the month, company, portfolio and lender", () => {
    const c: PurgeCertificate = {
      letter: { letterDate: "2026-05-05", period: "April-2026", toLines: [], lenderName: "North" },
      portfolioName: "North April",
      company: { legalName: "Acme Ltd", address: "" },
      supplier: {
        legalName: "SamvadX",
        address: "",
        signatoryName: null,
        signatoryDesignation: null,
      },
      allocation: { rows: [], totalAccounts: 0, totalOutstanding: 0 },
    };
    const t = purgeLetterText(c);
    expect(t.subject).toBe("Data Purging April-2026");
    expect(t.beforeTable[0]).toContain('from Acme Ltd the allocation "North April" of North');
    expect(t.tableCaption).toBe("Allocation Details North April-2026");
    const noLender = purgeLetterText({ ...c, letter: { ...c.letter, lenderName: "" } });
    expect(noLender.beforeTable[0]).toContain('"North April" for collection');
  });
});
