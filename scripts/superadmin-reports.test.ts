import { describe, expect, test } from "bun:test";
import {
  boundedRange,
  matchingPreset,
  openRangeInstants,
  presetRange,
  previousRange,
  rangeDays,
  rangeInstants,
  shiftDay,
} from "../src/lib/superadmin-range";
import { ageingKey, buildRevenueReport, type RevenueInvoice } from "../src/lib/revenue-report";

describe("superadmin-range", () => {
  const today = "2026-10-09";

  test("presets", () => {
    expect(presetRange("7d", today)).toEqual({ from: "2026-10-03", to: today });
    expect(presetRange("30d", today)).toEqual({ from: "2026-09-10", to: today });
    expect(presetRange("this-month", today)).toEqual({ from: "2026-10-01", to: today });
    expect(presetRange("last-month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("last-month", "2026-03-15")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(matchingPreset({ from: "2026-10-01", to: today }, today)).toBe("this-month");
    expect(matchingPreset({ from: "2026-10-02", to: today }, today)).toBeNull();
  });

  test("instants are midnight IST, end exclusive", () => {
    expect(rangeInstants({ from: "2026-10-01", to: "2026-10-09" })).toEqual({
      since: "2026-09-30T18:30:00.000Z",
      until: "2026-10-09T18:30:00.000Z",
    });
    expect(openRangeInstants({ from: "", to: "" })).toEqual({});
    expect(openRangeInstants({ from: "2026-10-05", to: "2026-10-01" })).toEqual({
      since: "2026-09-30T18:30:00.000Z",
      until: "2026-10-05T18:30:00.000Z",
    });
  });

  test("previous period, bounding, day counts", () => {
    expect(rangeDays({ from: "2026-10-01", to: "2026-10-09" })).toBe(9);
    expect(previousRange({ from: "2026-10-01", to: "2026-10-09" })).toEqual({
      from: "2026-09-22",
      to: "2026-09-30",
    });
    expect(boundedRange({ from: "", to: "" }, today)).toEqual({ from: "2026-09-10", to: today });
    expect(boundedRange({ from: "2026-10-09", to: "2026-10-01" }, today)).toEqual({
      from: "2026-10-01",
      to: "2026-10-09",
    });
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});

const inv = (over: Partial<RevenueInvoice>): RevenueInvoice => ({
  id: Math.random().toString(36).slice(2),
  clientId: "a",
  companyName: "A",
  invoiceNumber: "SX/2627/0001",
  kind: "setup",
  issueDate: "2026-10-01",
  dueDate: "2026-10-16",
  taxable: 1000,
  cgst: 90,
  sgst: 90,
  igst: 0,
  total: 1180,
  status: "unpaid",
  paidAt: null,
  recipientName: "A Pvt Ltd",
  recipientGstin: null,
  placeOfSupply: "27",
  ...over,
});

describe("buildRevenueReport", () => {
  test("ageing buckets", () => {
    expect(ageingKey(-3)).toBe("notDue");
    expect(ageingKey(0)).toBe("notDue");
    expect(ageingKey(1)).toBe("d1_30");
    expect(ageingKey(45)).toBe("d31_60");
    expect(ageingKey(90)).toBe("d61_90");
    expect(ageingKey(91)).toBe("d90plus");
  });

  test("billed, received, outstanding, overdue and GST by month", () => {
    const r = buildRevenueReport(
      [
        // Issued in range, unpaid, not yet due.
        inv({ invoiceNumber: "SX/1", issueDate: "2026-10-01", dueDate: "2026-10-16" }),
        // Issued before the range, unpaid and 40 days overdue — outstanding, not billed.
        inv({
          invoiceNumber: "SX/2",
          clientId: "b",
          companyName: "B",
          issueDate: "2026-08-15",
          dueDate: "2026-08-30",
          kind: "insights_topup",
          igst: 180,
          cgst: 0,
          sgst: 0,
        }),
        // Issued before, paid inside the range (IST day 2026-10-05) — received.
        inv({
          invoiceNumber: "SX/3",
          issueDate: "2026-09-01",
          dueDate: "2026-09-16",
          status: "paid",
          paidAt: "2026-10-04T20:00:00.000Z",
        }),
        // Cancelled in range: in the register and GST count of cancelled, not in amounts.
        inv({ invoiceNumber: "SX/4", issueDate: "2026-10-02", status: "cancelled" }),
      ],
      { from: "2026-10-01", to: "2026-10-09" },
      "2026-10-09",
    );
    expect(r.billed).toEqual({ count: 1, total: 1180, taxable: 1000, gst: 180 });
    expect(r.received).toEqual({ count: 1, total: 1180 });
    expect(r.outstanding).toEqual({ count: 2, total: 2360 });
    expect(r.overdue).toEqual({ count: 1, total: 1180 });
    expect(r.ageing.notDue.count).toBe(1);
    expect(r.ageing.d31_60.count).toBe(1);
    expect(r.gstMonthly).toEqual([
      {
        month: "2026-10",
        invoices: 1,
        cancelled: 1,
        taxable: 1000,
        cgst: 90,
        sgst: 90,
        igst: 0,
        total: 1180,
      },
    ]);
    expect(r.register.map((i) => i.invoiceNumber)).toEqual(["SX/1", "SX/4"]);
    const b = r.byCompany.find((c) => c.clientId === "b")!;
    expect(b.oldestOverdueDays).toBe(40);
    expect(b.billed.count).toBe(0);
    expect(r.unpaid[0].invoiceNumber).toBe("SX/2");
  });
});
