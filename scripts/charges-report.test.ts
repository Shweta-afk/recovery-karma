// The company-facing Insights charges report: totals must add up to exactly what was charged,
// split by found / not found, with corrections shown against the lookup they corrected.
import { describe, expect, test } from "bun:test";
import {
  buildChargesReport,
  lookupCellText,
  walletCellText,
  type ChargeLookupInput,
} from "../src/lib/profilex/charges-report";

const look = (
  id: string,
  serviceId: string,
  status: string | null,
  cost: number,
  at: string,
): ChargeLookupInput => ({
  id,
  at,
  source: "borrower",
  serviceId,
  providerStatus: status,
  cost,
  runBy: "Asha",
  borrower: "R K",
  loanId: "L1",
  portfolio: "WeRize",
});

describe("buildChargesReport", () => {
  const lookups = [
    look("a", "employment-latest", "1", 7, "2026-10-01T10:00:00Z"),
    look("b", "employment-latest", "2", 2, "2026-10-02T10:00:00Z"),
    look("c", "phone-to-prefill", "2", 4, "2026-10-03T10:00:00Z"),
    look("d", "phone-to-prefill", "1", 8, "2026-10-04T10:00:00Z"),
  ];
  const report = buildChargesReport(
    lookups,
    [
      {
        source: "borrower",
        lookupId: "c",
        oldCost: 8,
        newCost: 4,
        refunded: 4,
        refundedTo: "manager_wallet",
        at: "2026-10-29T10:00:00Z",
      },
    ],
    [
      {
        at: "2026-10-05T00:00:00Z",
        scope: "company_to_manager",
        amount: 500,
        note: null,
        manager: "Asha",
      },
      {
        at: "2026-10-29T10:00:00Z",
        scope: "manager_refund",
        amount: 4,
        note: "Refund",
        manager: "Asha",
      },
      {
        at: "2026-10-06T00:00:00Z",
        scope: "manager_charge",
        amount: 7,
        note: null,
        manager: "Asha",
      },
    ],
    "manager",
  );

  test("totals equal the sum of what was charged, split found / not found", () => {
    expect(report.totals).toEqual({
      lookups: 4,
      amount: 21,
      found: 2,
      foundAmount: 15,
      notFound: 2,
      notFoundAmount: 6,
      corrected: 1,
      refunded: 4,
    });
  });

  test("by service adds up per side", () => {
    const pp = report.byService.find((s) => s.serviceId === "phone-to-prefill")!;
    expect(pp).toMatchObject({
      found: 1,
      foundAmount: 8,
      notFound: 1,
      notFoundAmount: 4,
      totalAmount: 12,
    });
    expect(report.byService.reduce((t, s) => t + s.totalAmount, 0)).toBe(report.totals.amount);
  });

  test("a correction is attached to its own lookup only, newest lookup first", () => {
    expect(report.lookups.map((l) => l.id)).toEqual(["d", "c", "b", "a"]);
    expect(report.lookups.find((l) => l.id === "c")!.correction).toMatchObject({
      was: 8,
      refunded: 4,
    });
    expect(report.lookups.filter((l) => l.correction)).toHaveLength(1);
  });

  test("an odd stored status counts as not found, never found", () => {
    const r = buildChargesReport(
      [look("x", "mobile-to-gst", "OK", 3.42, "2026-10-01T00:00:00Z")],
      [],
      [],
      "company",
    );
    expect(r.totals.notFound).toBe(1);
  });

  test("the wallet shows money in and refunds, not per-lookup charges", () => {
    expect(report.wallet.map((w) => [w.scope, w.direction])).toEqual([
      ["manager_refund", 1],
      ["company_to_manager", 1],
    ]);
  });
});

describe("Excel cells are never blank", () => {
  const row = (over: Partial<ChargeLookupInput>) =>
    buildChargesReport(
      [{ ...look("x", "phone-to-prefill", "1", 8, "2026-10-04T10:00:00Z"), ...over }],
      [],
      [],
      "company",
    ).lookups[0];

  test("real values pass through", () => {
    expect(lookupCellText(row({}), "Was ₹8")).toEqual({
      loanId: "L1",
      portfolio: "WeRize",
      correction: "Was ₹8",
    });
  });

  test("a borrower whose bank file had no loan ID says so", () => {
    const c = lookupCellText(row({ loanId: "  ", portfolio: "" }), "");
    expect(c).toEqual({
      loanId: "Not in bank file",
      portfolio: "No portfolio",
      correction: "None",
    });
  });

  test("a typed-in lookup has no loan or portfolio by design", () => {
    const c = lookupCellText(row({ source: "typed", loanId: "", portfolio: "" }), "");
    expect(c.loanId).toBe("Not applicable (typed-in lookup)");
    expect(c.portfolio).toBe("Not applicable (typed-in lookup)");
  });

  test("wallet rows without a manager or note say so", () => {
    const [w] = buildChargesReport(
      [],
      [],
      [
        {
          at: "2026-10-01T00:00:00Z",
          scope: "master_to_company",
          amount: 500,
          note: null,
          manager: "",
        },
      ],
      "company",
    ).wallet;
    expect(walletCellText(w)).toEqual({
      manager: "Company wallet (no manager)",
      note: "No note recorded",
    });
  });
});
