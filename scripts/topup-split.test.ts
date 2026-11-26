import { describe, expect, test } from "bun:test";
import { topupPartOf, toInvoiceRecord, TOPUP_PART_LABEL } from "../src/lib/invoice-math";

const row = (lines: unknown) =>
  ({
    id: "i1",
    client_id: "c1",
    invoice_number: "SX/2627/0001",
    kind: "insights_topup",
    issue_date: "2026-11-26",
    due_date: "2026-12-10",
    description: "d",
    lines,
    sac: null,
    place_of_supply: "27",
    taxable_amount: "1000",
    cgst: "90",
    sgst: "90",
    igst: "0",
    total: "1180",
    supplier: {},
    recipient: {},
    wallet_ledger_id: "w1",
    status: "unpaid",
    paid_at: null,
    notes: null,
    disclaimer: "",
    created_at: "2026-11-26T00:00:00Z",
  }) as unknown as Parameters<typeof toInvoiceRecord>[0];

describe("one recharge, two invoices", () => {
  test("a line with no mark (every invoice issued before the split) is the recharge", () => {
    expect(topupPartOf([{ description: "x", amount: 1 }])).toBe("recharge");
    expect(topupPartOf([])).toBe("recharge");
    expect(topupPartOf(undefined)).toBe("recharge");
  });
  test("the extra-credit mark survives the round trip through the invoices row", () => {
    const rec = toInvoiceRecord(
      row([{ description: "Extra", amount: 1000, chargedOn: "2026-11-25", part: "extra_credit" }]),
    );
    expect(topupPartOf(rec.lines)).toBe("extra_credit");
    expect(topupPartOf(toInvoiceRecord(row([{ description: "Top-up", amount: 1000 }])).lines)).toBe(
      "recharge",
    );
  });
  test("both parts have a label", () => {
    expect(Object.keys(TOPUP_PART_LABEL).sort()).toEqual(["extra_credit", "recharge"]);
  });
});
