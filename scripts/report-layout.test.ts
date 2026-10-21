// buildReportLayout — Insights / credit reports as sections and tables (src/lib/profilex/report-layout.ts).
// Shapes mirror the live Financial Behaviour and CRIF responses (2026-10-21); values are made up.
import { describe, expect, test } from "bun:test";
import {
  buildReportLayout,
  countValues,
  label,
  reportLayoutHtml,
  unwrap,
} from "../src/lib/profilex/report-layout";

const financialBehaviour = {
  status: "1",
  message: "Data Fetched Successfully",
  success: true,
  data: {
    status: "1",
    Score: { score: 728, scoreType: "PERFORM CONSUMER 2.2", scoreFactors: "SF03|SF33|" },
    Header: { status: "SUCCESS", reportId: "CCR1", dateOfIssue: "21-10-2026" },
    Applicant: { name: "RAVI KUMAR", pan: "ABCDE1234F", phone: "9800000000" },
    AccountSummary: {
      primaryAccounts: { "PRIMARY-NUMBER-OF-ACCOUNTS": "3", "PRIMARY-OVERDUE-AMOUNT": "1200" },
      derivedAttributes: { "INQURIES-IN-LAST-SIX-MONTHS": "2" },
    },
    LoanAccounts: [
      {
        "LOAN-DETAILS": {
          "ACCOUNT-TYPE": "Personal Loan",
          "CURRENT-BAL": "5000",
          "SECURITY-DETAILS": { "SECURITY-DETAIL": { "SECURITY-TYPE": "None" } },
        },
      },
      { "LOAN-DETAILS": { "ACCOUNT-TYPE": "Credit Card", "OVERDUE-AMT": "1200" } },
    ],
    InquiryHistory: [
      { memberName: "BANK A", inquiryDate: "01-09-2026", amount: "50000" },
      { memberName: "BANK B", inquiryDate: "02-09-2026" },
    ],
    PersonalInfoVariations: {
      "NAME-VARIATIONS": { VARIATION: [{ VALUE: "RAVI KUMAR" }, { VALUE: "R KUMAR" }] },
      "PASSPORT-VARIATIONS": "",
    },
    EmploymentDetails: null,
  },
};

describe("buildReportLayout", () => {
  const r = buildReportLayout(financialBehaviour, "Financial Behaviour");

  test("drops the envelope and shows the report's own sections", () => {
    expect(r.title).toBe("Financial Behaviour");
    expect(r.sections.map((s) => s.title)).toEqual([
      "Score",
      "Header",
      "Applicant",
      "Account Summary",
      "Personal Info Variations",
    ]);
    expect(r.fields.find((f) => f.label === "Message")).toBeUndefined();
  });

  test("labels hyphenated and camelCase keys as words", () => {
    expect(label("PRIMARY-NUMBER-OF-ACCOUNTS")).toBe("Primary Number Of Accounts");
    expect(label("dateOfIssue")).toBe("Date Of Issue");
    expect(label("pan")).toBe("PAN");
  });

  test("lists become row tables, one row per item, unwrapped from a shared key", () => {
    const loans = r.tables.find((t) => t.title === "Loan Accounts")!;
    expect(loans.rows).toHaveLength(2);
    expect(loans.columns).toContain("Account Type");
    expect(loans.columns).toContain("Overdue Amt");
    const typeCol = loans.columns.indexOf("Account Type");
    expect(loans.rows.map((row) => row[typeCol])).toEqual(["Personal Loan", "Credit Card"]);
    // Missing values are blank cells, not shifted columns.
    expect(loans.rows[1][loans.columns.indexOf("Current Bal")]).toBe("");
  });

  test("a {VARIATION: [...]} wrapper is a table titled by its parent", () => {
    const pv = r.sections.find((s) => s.title === "Personal Info Variations")!;
    const names = pv.tables.find((t) => t.title === "Name Variations")!;
    expect(names.rows).toEqual([["RAVI KUMAR"], ["R KUMAR"]]);
  });

  test("blank and null values are left out", () => {
    const pv = r.sections.find((s) => s.title === "Personal Info Variations")!;
    expect(pv.fields.find((f) => f.label === "Passport Variations")).toBeUndefined();
    expect(r.sections.find((s) => s.title === "Employment Details")).toBeUndefined();
  });

  test("the score sits in its own section", () => {
    const score = r.sections.find((s) => s.title === "Score")!;
    expect(score.fields[0]).toEqual({ label: "Score", value: "728" });
  });

  test("an empty bureau answer has nothing to show", () => {
    const empty = {
      status: "OK",
      message: "Data Fetched Successfully",
      data: { Score: null, Header: null, LoanAccounts: [], InquiryHistory: [], Applicant: null },
    };
    expect(countValues(buildReportLayout(empty))).toBe(0);
    expect(countValues(r)).toBeGreaterThan(10);
  });
});

describe("unwrap", () => {
  test("peels the CRIF report's three data layers", () => {
    const crif = {
      status: "1",
      request_id: "x",
      data: { status: "OK", timestamp: "t", data: { data: { HEADER: { STATUS: "SUCCESS" } } } },
    };
    expect(unwrap(crif)).toEqual({ HEADER: { STATUS: "SUCCESS" } });
  });

  test("stops at a data key that has siblings carrying information", () => {
    const node = { data: { a: 1 }, uan: "123" };
    expect(unwrap(node)).toBe(node);
  });
});

describe("reportLayoutHtml", () => {
  test("renders tables and escapes values", () => {
    const html = reportLayoutHtml(
      buildReportLayout({ data: { Applicant: { name: "<b>X</b>", pan: "P" }, List: [{ a: 1 }] } }),
    );
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(html).toContain('<table class="grid">');
    expect(html).not.toContain("<b>X</b>");
  });
});
