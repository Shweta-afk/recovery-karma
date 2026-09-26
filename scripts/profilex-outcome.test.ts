// The Insights outcome report's judgement calls: whether a lookup found anything, which numbers it
// surfaced, and how the account turned out after it. Getting these wrong credits Insights with
// recoveries it didn't touch, or hides the ones it did.
import { describe, expect, test } from "bun:test";
import {
  OUTCOME_EXPORT_HEADERS,
  classifyTurnout,
  istStamp,
  lookupResult,
  outcomeExportRow,
  toOutcomeRow,
  totals,
  type OutcomeRpcRow,
} from "../src/lib/profilex/outcome";

function rpc(over: Partial<OutcomeRpcRow> = {}): OutcomeRpcRow {
  return {
    trace_id: "t1",
    created_at: "2026-09-22T13:00:00Z",
    service_id: "get-alternate-phone",
    state: "done",
    provider_status: "1",
    billable: true,
    cost: "8.00",
    response: {
      status: "OK",
      message: "Data Fetched Successfully",
      data: { status: "1", phone: "+919839530109", alternate_phones: ["7905207727", "7355676346"] },
    },
    requested_by_name: "Prince",
    requested_by_role: "manager",
    debtor_id: "d1",
    debtor_name: "RAJESH",
    loan_reference: "A0001",
    phone_primary: "9839530109",
    loan_amount: "50000",
    dpd: 120,
    portfolio_id: "p1",
    portfolio_name: "AU CC Sep",
    lender_name: "AU Small Finance Bank",
    product_type: "Credit Card",
    manager_id: "m1",
    manager_name: "Prince",
    agent_name: "Mahesh",
    calls_before: 3,
    contacted_before: false,
    calls_after: 0,
    contacts_after: 0,
    first_call_after_at: null,
    first_contact_after_at: null,
    best_outcome_after: null,
    best_notes_after: null,
    last_outcome_after: null,
    last_outcome_at: null,
    last_notes_after: null,
    ptp_amount: null,
    ptp_date: null,
    dialed_after: [],
    dialed_contacted_after: [],
    paid_amount_after: "0",
    last_paid_at: null,
    paid_file_amount_after: "0",
    paid_before: false,
    debtor_status: "pending",
    ...over,
  };
}

describe("lookupResult", () => {
  test("status 1 is found, 2/3/201 are not", () => {
    expect(lookupResult("done", "1", null)).toBe("found");
    expect(lookupResult("done", "2", null)).toBe("not_found");
    expect(lookupResult("done", "201", null)).toBe("not_found");
  });
  test("an envelope-only OK reads the message and nested status_code", () => {
    expect(
      lookupResult("done", "OK", { message: "No record(s) found", data: { status: null } }),
    ).toBe("not_found");
    expect(
      lookupResult("done", "OK", {
        message: "Data Fetched Successfully",
        data: { status: "OK", status_code: "1", upi_id: ["x@ybl"] },
      }),
    ).toBe("found");
  });
  test("failed and pending are never found", () => {
    expect(lookupResult("failed", "1", null)).toBe("failed");
    expect(lookupResult("pending", null, null)).toBe("pending");
  });
});

describe("toOutcomeRow", () => {
  test("new numbers exclude the account's own primary, however it was formatted", () => {
    const r = toOutcomeRow(rpc({ phone_primary: "+91 9839530109" }));
    expect(r.newNumbers.sort()).toEqual(["7355676346", "7905207727"]);
    expect(r.dataFound).toBe("2 numbers");
  });
  test("a found number that was dialled and reached counts as connected", () => {
    const r = toOutcomeRow(
      rpc({
        calls_after: 2,
        contacts_after: 1,
        dialed_after: ["+917905207727", "9839530109"],
        dialed_contacted_after: ["07905207727"],
        best_outcome_after: "promised",
        ptp_amount: "1000",
      }),
    );
    expect(r.newNumberCalled).toBe(true);
    expect(r.newNumberConnected).toBe(true);
    expect(r.turnout).toBe("ptp");
  });
  test("reaching only the primary is not credited to a found number", () => {
    const r = toOutcomeRow(
      rpc({
        calls_after: 1,
        contacts_after: 1,
        dialed_contacted_after: ["9839530109"],
        dialed_after: ["9839530109"],
      }),
    );
    expect(r.newNumberConnected).toBe(false);
    expect(r.turnout).toBe("contacted");
  });
  test("a miss is 'no data' even if the account later paid", () => {
    const r = toOutcomeRow(rpc({ provider_status: "2", paid_amount_after: "5000" }));
    expect(r.turnout).toBe("no_data");
    expect(r.newNumbers).toEqual([]);
  });
});

describe("classifyTurnout", () => {
  const base = {
    result: "found" as const,
    paidAfter: 0,
    bestOutcome: null,
    contactsAfter: 0,
    callsAfter: 0,
  };
  test("payment beats PTP beats contact beats a call", () => {
    expect(
      classifyTurnout({
        ...base,
        paidAfter: 1,
        bestOutcome: "promised",
        contactsAfter: 1,
        callsAfter: 1,
      }),
    ).toBe("recovered");
    expect(
      classifyTurnout({ ...base, bestOutcome: "settlement", contactsAfter: 1, callsAfter: 1 }),
    ).toBe("ptp");
    expect(
      classifyTurnout({ ...base, bestOutcome: "callback", contactsAfter: 1, callsAfter: 1 }),
    ).toBe("contacted");
    expect(classifyTurnout({ ...base, bestOutcome: "no_answer", callsAfter: 3 })).toBe(
      "worked_no_contact",
    );
    expect(classifyTurnout(base)).toBe("not_worked");
  });
});

describe("totals", () => {
  test("spend counts billed lookups only; first-time contacts need no prior contact", () => {
    const t = totals([
      toOutcomeRow(rpc({ calls_after: 1, contacts_after: 1 })),
      toOutcomeRow(
        rpc({
          trace_id: "t2",
          billable: false,
          contacted_before: true,
          calls_after: 1,
          contacts_after: 1,
        }),
      ),
      toOutcomeRow(rpc({ trace_id: "t3", paid_amount_after: "2500", calls_after: 1 })),
    ]);
    expect(t.lookups).toBe(3);
    expect(t.spend).toBe(16);
    expect(t.contacted).toBe(2);
    expect(t.newContacts).toBe(1);
    expect(t.recovered).toBe(1);
    expect(t.recoveredAmount).toBe(2500);
  });
});

describe("paid via bank paid file", () => {
  const v = (over: Partial<OutcomeRpcRow>) => toOutcomeRow(rpc(over));
  test("paid-file amounts are split out and count as recovered", () => {
    const r = v({ paid_amount_after: "5000", paid_file_amount_after: "5000" });
    expect(r.paidFileAfter).toBe(5000);
    expect(r.turnout).toBe("recovered");
    expect(totals([r]).recoveredViaFile).toBe(1);
    const cells = outcomeExportRow(r, (id) => id);
    expect(cells[OUTCOME_EXPORT_HEADERS.indexOf("Paid Via")]).toBe("Bank paid file");
  });
  test("a no-amount paid-file mark counts, unless the account was paid before the lookup", () => {
    expect(v({ debtor_status: "paid" }).turnout).toBe("recovered");
    expect(v({ debtor_status: "paid", paid_before: true }).markedPaidByFile).toBe(false);
  });
});

describe("export", () => {
  test("one cell per header, IST timestamps", () => {
    const row = outcomeExportRow(toOutcomeRow(rpc()), (id) => id);
    expect(row.length).toBe(OUTCOME_EXPORT_HEADERS.length);
    expect(istStamp("2026-09-22T13:07:35Z")).toBe("2026-09-22 18:37:35");
    expect(istStamp(null)).toBe("");
  });
});
