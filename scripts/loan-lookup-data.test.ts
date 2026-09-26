// "Lookup data by Loan ID" — merging every lookup on an account into one row and setting it beside
// the bank file. Shapes below are the real ones from production responses (values invented).
import { describe, expect, test } from "bun:test";
import {
  buildLoanLookupData,
  dateKey,
  type LoanTraceInput,
} from "../src/lib/profilex/loan-lookup-data";

function trace(over: Partial<LoanTraceInput> = {}): LoanTraceInput {
  return {
    traceId: "t1",
    debtorId: "d1",
    serviceId: "get-alternate-phone",
    state: "done",
    providerStatus: "1",
    billable: true,
    cost: 8,
    createdAt: "2026-09-20T10:00:00Z",
    response: { data: { status: "1", phone: "+919839530109", alternate_phones: ["7905207727"] } },
    loanReference: "A0001",
    name: "RAJMANI K VISHWAKARMA",
    phonePrimary: "9839530109",
    email: "raj@example.com",
    bankExtra: {
      address: "12 MG Road",
      city: "Mumbai",
      state: "MH",
      dob: "1978-07-16",
      employer: "Tata Motors Ltd",
    },
    ...over,
  };
}

const skipTrace = trace({
  traceId: "t2",
  serviceId: "skip-tracing",
  cost: 46,
  createdAt: "2026-09-21T10:00:00Z",
  response: {
    data: {
      status: "1",
      vrePanAdvance: {
        pan: "ABCDE1234F",
        full_name: "RAJMANI KANHAIYALAL VISHWAKARMA",
        dob: "16-07-1978",
        address_line1: "Flat 4",
        address_line3: "Ghatkopar Mumbai",
        pincode: 400083,
      },
      vrePanToFathersName: { father_name: "KANHAIYALAL" },
      vrePhoneToPrefill: {
        alternatePhone: [{ phoneNumber: "+919876543210" }, { phoneNumber: "7905207727" }],
        email: [{ email: "raj@example.com" }, { email: "rk@mail.com" }],
        address: [{ Address: "Room 9 Chawl", State: "MH", Postal: "400086" }],
        name: { fullName: "RAJMANI VISHWAKARMA" },
        age: "48",
      },
      vreMultipleUpiCheck: { upi_id: ["9839530109@ybl"] },
      getAlternateAddress: { addresses: [{ address_text: "Plot 7, Thane" }] },
      vreEmploymentLatest: {
        summary: {
          is_employed: true,
          recent_employer_data: {
            establishment_name: "TATA MOTORS LIMITED",
            date_of_joining: "2019-04-01",
          },
        },
      },
      vreMobileToUan: { uan: "101190326985" },
    },
  },
});

describe("buildLoanLookupData", () => {
  const { rows, details } = buildLoanLookupData([trace(), skipTrace]);
  const r = rows[0];

  test("one row per loan, every lookup kept in the details", () => {
    expect(rows.length).toBe(1);
    expect(details.length).toBe(2);
    expect(r.lookups).toBe(2);
    expect(r.cost).toBe(54);
    expect(r.services.sort()).toEqual(["get-alternate-phone", "skip-tracing"]);
  });

  test("numbers merged across lookups, de-duplicated, primary excluded", () => {
    expect(r.newNumbers.sort()).toEqual(["7905207727", "9876543210"]);
  });

  test("identity and employment pulled out of the bundle", () => {
    expect(r.pan).toBe("ABCDE1234F");
    expect(r.fatherName).toBe("KANHAIYALAL");
    expect(r.uan).toBe("101190326985");
    expect(r.employer).toBe("TATA MOTORS LIMITED");
    expect(r.employed).toBe("Yes");
    expect(r.upiIds).toEqual(["9839530109@ybl"]);
    expect(r.emails).toEqual(["raj@example.com", "rk@mail.com"]);
    expect(r.addresses).toContain("Plot 7, Thane");
    expect(r.addresses).toContain("Room 9 Chawl, MH, 400086");
    expect(r.addresses).toContain("Flat 4, Ghatkopar Mumbai, 400083");
  });

  test("compared with the bank file", () => {
    expect(r.compare.name).toBe("match");
    expect(r.compare.dob).toBe("match"); // 16-07-1978 vs 1978-07-16
    expect(r.compare.employer).toBe("match"); // "Tata Motors Ltd" vs "TATA MOTORS LIMITED"
    expect(r.compare.email).toBe("match");
    expect(r.compare.city).toBe("match");
    expect(r.bank.address).toBe("12 MG Road, Mumbai, MH");
  });

  test("differences and missing data are told apart", () => {
    const bank = {
      bankExtra: { city: "Pune", employer: "Infosys", dob: "1980-01-01" },
      email: null,
    };
    const [x] = buildLoanLookupData([trace(bank), { ...skipTrace, ...bank }]).rows;
    expect(x.compare.city).toBe("differs");
    expect(x.compare.employer).toBe("differs");
    expect(x.compare.dob).toBe("differs");
    expect(x.compare.email).toBe(""); // bank file has no email — nothing to compare
  });

  test("a not-found lookup contributes nothing but is still listed", () => {
    const out = buildLoanLookupData([
      trace({
        providerStatus: "2",
        response: { data: { status: "2", alternate_phones: ["7000000000"] } },
      }),
    ]);
    expect(out.rows[0].newNumbers).toEqual([]);
    expect(out.rows[0].lookupsFound).toBe(0);
    expect(out.details[0].result).toBe("Not found");
  });
});

describe("dateKey", () => {
  test("normalises the date formats the provider and bank files use", () => {
    expect(dateKey("16-07-1978")).toBe("19780716");
    expect(dateKey("1978-07-16")).toBe("19780716");
    expect(dateKey("6/7/1978")).toBe("19780706");
    expect(dateKey("n/a")).toBe("");
  });
});

describe("export", () => {
  test("By Loan ID row has one cell per header", async () => {
    const { LOAN_EXPORT_HEADERS, loanExportRow } =
      await import("../src/lib/profilex/loan-lookup-data");
    const { rows } = buildLoanLookupData([trace()]);
    const row = loanExportRow(rows[0], (id) => id);
    expect(row.length).toBe(LOAN_EXPORT_HEADERS.length);
    expect(row[LOAN_EXPORT_HEADERS.indexOf("New Numbers Found")]).toBe("7905207727");
  });

  test("a sheet per service with every returned field as its own column", async () => {
    const { buildServiceSheets } = await import("../src/lib/profilex/loan-lookup-data");
    const { details } = buildLoanLookupData([trace(), skipTrace]);
    const sheets = buildServiceSheets(details, (id) =>
      id === "skip-tracing" ? "Skip Tracing" : "Alt Phone",
    );
    expect(sheets.map((s) => s.name).sort()).toEqual(["Alt Phone", "Skip Tracing"]);
    const skip = sheets.find((s) => s.name === "Skip Tracing")!;
    const col = (c: string) => skip.columns.indexOf(c);
    const row = skip.rows[0];
    // deep bundle fields each get a column
    expect(row[col("Vre PAN To Fathers Name › Father Name")]).toBe("KANHAIYALAL");
    expect(row[col("Vre PAN Advance › Pincode")]).toBe("400083");
    expect(row[col("Vre Phone To Prefill › Email 1 › Email")]).toBe("raj@example.com");
    expect(row[col("Vre Phone To Prefill › Email 2 › Email")]).toBe("rk@mail.com");
    expect(row[col("Vre Employment Latest › Summary › Is Employed")]).toBe("true");
    // the raw response is kept whole, envelope included
    expect(String(row[skip.columns.length - 1])).toContain('"vrePanAdvance"');
    // every row is as wide as the header
    for (const s of sheets) for (const r of s.rows) expect(r.length).toBe(s.columns.length);
  });

  test("id-keyed blocks (one per UAN) line up by position across borrowers", async () => {
    const { buildServiceSheets } = await import("../src/lib/profilex/loan-lookup-data");
    const emp = (debtorId: string, uan: string, name: string) =>
      trace({
        debtorId,
        traceId: debtorId,
        serviceId: "employment-history",
        response: { data: { status: "1", uan_details: { [uan]: { basic_details: { name } } } } },
      });
    const { details } = buildLoanLookupData([
      emp("d1", "101190326985", "A"),
      emp("d2", "101190326986", "B"),
    ]);
    const [sheet] = buildServiceSheets(details, (id) => id);
    const c = sheet.columns.indexOf("UAN Details › #1 › Basic Details › Name");
    expect(c).toBeGreaterThan(-1);
    expect(sheet.rows.map((r) => r[c]).sort()).toEqual(["A", "B"]);
    expect(sheet.columns.filter((x) => x.includes("Basic Details › Name")).length).toBe(1);
  });

  test("sheet names are Excel-safe and unique", async () => {
    const { buildServiceSheets } = await import("../src/lib/profilex/loan-lookup-data");
    const { details } = buildLoanLookupData([trace(), { ...skipTrace }]);
    const sheets = buildServiceSheets(details, () => "Very long: service/name [with] bad*chars?");
    for (const s of sheets) {
      expect(s.name.length).toBeLessThanOrEqual(31);
      expect(/[[\]:*?/\\]/.test(s.name)).toBe(false);
    }
    expect(new Set(sheets.map((s) => s.name)).size).toBe(sheets.length);
  });
});
