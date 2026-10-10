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
import { GLOSSARY, HELP_SECTIONS } from "../src/lib/superadmin-glossary";
import {
  EMPTY_PRICE_LIST,
  creditableTaxable,
  invoiceBalance,
  monthlyInvoiceLines,
  priceListChanges,
} from "../src/lib/invoice-math";
import {
  DEFAULT_TEMPLATE_BODY,
  PLACEHOLDERS,
  fillTemplate,
  parseTemplateBlocks,
  templateValueMap,
} from "../src/lib/contract-template";
import { insightsPriceChanges } from "../src/lib/profilex/price-changes";
import { PROFILEX_SERVICES } from "../src/lib/profilex/catalogue";

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
  payments: [],
  creditNotes: [],
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
        creditNotes: 0,
        invoiceTaxable: 1000,
        creditTaxable: 0,
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

  test("part payments count on the day they arrived; outstanding is what's left", () => {
    const r = buildRevenueReport(
      [
        inv({
          invoiceNumber: "SX/9",
          issueDate: "2026-09-01",
          dueDate: "2026-09-16",
          payments: [
            // Before the range: not "received" now, but still reduces what is owed.
            { amount: 500, receivedOn: "2026-09-20", method: "upi", reference: "UTR1" },
            { amount: 300, receivedOn: "2026-10-05", method: "bank_transfer", reference: null },
          ],
        }),
      ],
      { from: "2026-10-01", to: "2026-10-09" },
      "2026-10-09",
    );
    expect(r.received).toEqual({ count: 1, total: 300 });
    expect(r.receipts.map((p) => p.reference)).toEqual([null]);
    expect(r.outstanding).toEqual({ count: 1, total: 380 }); // 1180 − 500 − 300
    expect(r.unpaid[0].due).toBe(380);
    expect(r.overdue.total).toBe(380);
  });

  test("credit notes count in their own month and reduce what is owed", () => {
    const cn = {
      number: "SXC/2627/0001",
      issueDate: "2026-10-03",
      reason: "Wrong seat count",
      taxable: 200,
      cgst: 18,
      sgst: 18,
      igst: 0,
      total: 236,
    };
    const r = buildRevenueReport(
      // Invoice from September, credited in October.
      [inv({ issueDate: "2026-09-25", dueDate: "2026-10-10", creditNotes: [cn] })],
      { from: "2026-10-01", to: "2026-10-31" },
      "2026-10-09",
    );
    expect(r.billed.count).toBe(0);
    expect(r.credited).toEqual({ count: 1, total: 236, taxable: 200 });
    expect(r.netBilled).toBe(-236);
    expect(r.gstMonthly).toEqual([
      {
        month: "2026-10",
        invoices: 0,
        cancelled: 0,
        creditNotes: 1,
        invoiceTaxable: 0,
        creditTaxable: 200,
        taxable: -200,
        cgst: -18,
        sgst: -18,
        igst: 0,
        total: -236,
      },
    ]);
    expect(r.creditRegister[0]).toMatchObject({
      number: "SXC/2627/0001",
      invoiceNumber: "SX/2627/0001",
    });
    expect(r.outstanding.total).toBe(944); // 1180 − 236
  });

  test("a fully paid invoice isn't outstanding; a cancelled one never is", () => {
    const r = buildRevenueReport(
      [
        inv({
          invoiceNumber: "A",
          status: "paid",
          payments: [{ amount: 1180, receivedOn: "2026-10-02", method: "upi", reference: null }],
        }),
        inv({ invoiceNumber: "B", status: "cancelled" }),
      ],
      { from: "2026-10-01", to: "2026-10-09" },
      "2026-10-09",
    );
    expect(r.outstanding.count).toBe(0);
    expect(r.received.total).toBe(1180);
  });
});

describe("superadmin help", () => {
  test("every explanation is on the Help page exactly once", () => {
    const listed = HELP_SECTIONS.flatMap((s) => s.keys);
    expect([...listed].sort()).toEqual(Object.keys(GLOSSARY).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe("price lists and monthly invoices", () => {
  const prices = {
    ...EMPTY_PRICE_LIST,
    monthlyLines: [
      { description: "Platform fee", amount: 2000 },
      { description: "Unused", amount: 0 },
    ],
    perSeatFee: 450,
  };

  test("monthly lines: fixed fees (₹0 skipped) then seats × price", () => {
    expect(monthlyInvoiceLines(prices, "2026-09", 12)).toEqual([
      { description: "Platform fee — September 2026", amount: 2000 },
      { description: "Agent seats — September 2026", quantity: 12, rate: 450, amount: 5400 },
    ]);
    expect(monthlyInvoiceLines(prices, "2026-09", 0)).toHaveLength(1);
  });

  test("what changed between two price lists, in words", () => {
    const after = {
      ...prices,
      setupLines: [{ description: "Domain Setup", amount: 5000 }],
      monthlyLines: [{ description: "Platform fee", amount: 2500 }],
      perSeatFee: 400,
      paymentTermsDays: 30,
    };
    expect(priceListChanges(prices, after)).toEqual([
      'Setup fee: added "Domain Setup" at ₹5,000',
      'Monthly fee: "Platform fee" ₹2,000 → ₹2,500',
      'Monthly fee: removed "Unused" (was ₹0)',
      "Price per agent seat per month: ₹450 → ₹400",
      "Payment terms: standard terms → 30 days",
    ]);
    expect(priceListChanges(prices, prices)).toEqual([]);
  });
});

describe("invoice balance", () => {
  const inv = { total: 1180, taxable: 1000, status: "unpaid" as const };

  test("payments and credit notes come off what is owed", () => {
    expect(invoiceBalance(inv, [{ amount: 500 }], [{ total: 236 }])).toEqual({
      net: 944,
      credited: 236,
      paid: 500,
      balance: 444,
      settled: false,
    });
    expect(invoiceBalance(inv, [{ amount: 944 }], [{ total: 236 }]).settled).toBe(true);
  });

  test("marked paid before payments were recorded counts as paid in full", () => {
    expect(invoiceBalance({ ...inv, status: "paid" }, [], []).settled).toBe(true);
  });

  test("a cancelled invoice owes nothing", () => {
    expect(invoiceBalance({ ...inv, status: "cancelled" }, [], []).net).toBe(0);
  });

  test("credit can't exceed the taxable value left", () => {
    expect(creditableTaxable(inv, [{ taxable: 300 }, { taxable: 200 }])).toBe(500);
    expect(creditableTaxable(inv, [{ taxable: 1200 }])).toBe(0);
  });
});

describe("contract templates", () => {
  const values = templateValueMap({
    companyName: "Kuber",
    companyLegalName: "Kuber Associates LLP",
    companyGstin: null,
    companyAddress: "Pune",
    supplierLegalName: "Axiotta Communication",
    effectiveDate: "15 October 2026",
    today: "10 October 2026",
    prices: {
      ...EMPTY_PRICE_LIST,
      setupLines: [{ description: "Domain Setup", amount: 5000 }],
      perSeatFee: 450,
    },
    paymentTermsDays: 15,
    agentSeatLimit: 20,
    managerSeatLimit: null,
    insightsPrices: [["Skip Tracing", "₹46 if found"]],
  });

  test("every documented blank has a value, and the starter template uses only known blanks", () => {
    for (const p of PLACEHOLDERS) expect(values[p.key]).toBeDefined();
    expect(fillTemplate(DEFAULT_TEMPLATE_BODY, values).unknown).toEqual([]);
  });

  test("fills values, tables and fallbacks; reports unknown blanks", () => {
    const { text, unknown } = fillTemplate(
      "{{company_legal_name}} / {{company_gstin}} / {{manager_seats}} / {{nope}}\n{{setup_fee_table}}",
      values,
    );
    expect(unknown).toEqual(["nope"]);
    expect(text).toContain("Kuber Associates LLP / Unregistered / Unlimited / {{nope}}");
    expect(text).toContain("| Domain Setup | ₹5,000.00 |");
    expect(text).toContain("| **Total** | **₹5,000.00** |");
    expect(values.monthly_fee_table).toBe("No fixed monthly fee.");
  });

  test("parses headings, bullets, tables and paragraphs", () => {
    const blocks = parseTemplateBlocks("# T\n\n## S\n- a\n- b\n| x | y |\n| 1 | 2 |\nplain\ntext");
    expect(blocks).toEqual([
      { type: "h1", text: "T" },
      { type: "h2", text: "S" },
      { type: "ul", items: ["a", "b"] },
      {
        type: "table",
        rows: [
          ["x", "y"],
          ["1", "2"],
        ],
      },
      { type: "p", text: "plain text" },
    ]);
  });
});

describe("Insights price changes", () => {
  const [a, b] = PROFILEX_SERVICES;
  test("added, removed and repriced services", () => {
    const changes = insightsPriceChanges(
      { enabled_services: [a.id], rate_card: {} },
      { enabled_services: [b.id], rate_card: {} },
    );
    expect(changes.some((c) => c.startsWith(`Insights: added "${b.label}"`))).toBe(true);
    expect(changes).toContain(`Insights: removed "${a.label}"`);
    const repriced = insightsPriceChanges(
      { enabled_services: [a.id], rate_card: {} },
      { enabled_services: [a.id], rate_card: { [a.id]: { "1": 999 } } },
    );
    expect(repriced).toHaveLength(1);
    expect(repriced[0]).toContain("₹999");
    expect(
      insightsPriceChanges(
        { enabled_services: [a.id], rate_card: {} },
        { enabled_services: [a.id], rate_card: {} },
      ),
    ).toEqual([]);
  });
});
