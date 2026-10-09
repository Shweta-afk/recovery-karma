import { describe, expect, test } from "bun:test";
import {
  amountInWords,
  financialYear,
  formatInvoiceNumber,
  gstBreakdown,
  invoiceDisclaimer,
  stateFromGstin,
  sumLines,
} from "../src/lib/invoice-math";

describe("gstBreakdown", () => {
  test("same state → 9% CGST + 9% SGST", () => {
    expect(gstBreakdown(10000, "27", "27")).toEqual({
      taxable: 10000,
      intraState: true,
      cgst: 900,
      sgst: 900,
      igst: 0,
      total: 11800,
    });
  });
  test("different state → 18% IGST", () => {
    expect(gstBreakdown(10000, "27", "29")).toEqual({
      taxable: 10000,
      intraState: false,
      cgst: 0,
      sgst: 0,
      igst: 1800,
      total: 11800,
    });
  });
  test("paise round per line and the total is the sum of printed lines", () => {
    const b = gstBreakdown(1234.57, "27", "27");
    expect(b.cgst).toBe(111.11);
    expect(b.sgst).toBe(111.11);
    expect(b.total).toBe(1456.79);
    const i = gstBreakdown(1234.57, "27", "07");
    expect(i.igst).toBe(222.22);
    expect(i.total).toBe(1456.79);
  });
});

describe("stateFromGstin", () => {
  test("reads the state from a well-formed GSTIN, ignoring case and spaces", () => {
    expect(stateFromGstin("27aapfu0939f1zv")).toBe("27");
    expect(stateFromGstin(" 29AAPFU0939F1ZV ")).toBe("29");
  });
  test("rejects malformed or unknown-state GSTINs", () => {
    expect(stateFromGstin("27AAPFU0939F1Z")).toBeNull();
    expect(stateFromGstin("99AAPFU0939F1ZV")).toBeNull();
    expect(stateFromGstin("")).toBeNull();
    expect(stateFromGstin(null)).toBeNull();
  });
});

describe("financialYear / formatInvoiceNumber", () => {
  test("April starts a new FY", () => {
    expect(financialYear("2026-03-31")).toBe("2025-26");
    expect(financialYear("2026-04-01")).toBe("2026-27");
    expect(financialYear("2027-01-15")).toBe("2026-27");
    expect(financialYear("2099-12-01")).toBe("2099-00");
  });
  test("number fits GST's 16-character limit", () => {
    expect(formatInvoiceNumber("SX", "2026-27", 7)).toBe("SX/2627/0007");
    expect(formatInvoiceNumber("AXTPL", "2026-27", 12345)).toBe("AXTPL/2627/12345");
    expect(() => formatInvoiceNumber("AXTPL", "2026-27", 123456)).toThrow();
  });
});

describe("amountInWords", () => {
  test("Indian numbering with paise", () => {
    expect(amountInWords(11800)).toBe("Rupees Eleven Thousand Eight Hundred Only");
    expect(amountInWords(1456.79)).toBe(
      "Rupees One Thousand Four Hundred Fifty Six and Seventy Nine Paise Only",
    );
    expect(amountInWords(12345678)).toBe(
      "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only",
    );
    expect(amountInWords(0.5)).toBe("Rupees Zero and Fifty Paise Only");
  });
});

describe("sumLines", () => {
  test("setup lines add up to the taxable value, to the paisa", () => {
    expect(
      sumLines([
        { description: "Domain Setup", amount: 5000 },
        { description: "API Configuration", amount: 10000.1 },
        { description: "Administrator Configuration", amount: 4999.95 },
        { description: "Cloud Storage", amount: 0.005 },
      ]),
    ).toBe(20000.06);
  });
});

describe("invoiceDisclaimer", () => {
  test("each invoice type carries its own MSA terms plus the shared data terms", () => {
    const topup = invoiceDisclaimer("insights_topup", "Axiotta Communication").join(" ");
    const setup = invoiceDisclaimer("setup", "Axiotta Communication").join(" ");
    expect(topup).toContain("including lookups that return no result");
    expect(topup).not.toContain("Setup fees");
    expect(setup).toContain("Setup fees are non-refundable");
    expect(setup).not.toContain("Insights results");
    for (const t of [topup, setup]) {
      expect(t).toContain("Axiotta Communication acts as Data Processor");
      expect(t).toContain("Master Service Agreement");
    }
  });
});
