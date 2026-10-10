// CIBIL via PayPrime: what is sent, what counts as charged, and what the form prefills.
// Under-recording a charge or sending a wrong field (PayPrime answers "Bad Parameter Request"
// with no detail) are the two failures that cost money or a day of debugging.
import { describe, expect, test } from "bun:test";
import {
  buildPrefill,
  cibilRequestBody,
  findScore,
  isInvalidToken,
  parseTokens,
  isoDob,
  readCibilOutcome,
  stateCodeFor,
  validateCibilForm,
  type CibilForm,
} from "../src/lib/cibil/payprime";
import { CIBIL_SERVICE, getService, priceFor } from "../src/lib/profilex/catalogue";

const good: CibilForm = {
  firstName: "Ravi",
  lastName: "Kumar",
  pan: "ABCDE1234F",
  dob: "1997-01-02",
  gender: "Male",
  email: "ravi@example.com",
  streetAddress: "12 MG Road, Near Bus Stand",
  city: "Kadapa",
  postalCode: "516401",
  region: "28",
  addressType: "1",
};

describe("request body", () => {
  test("matches PayPrime's documented payload, consent fields fixed, no token", () => {
    const body = cibilRequestBody(good, "9010665440");
    expect(body).toEqual({
      first_name: "Ravi",
      last_name: "Kumar",
      id_type: "TaxId",
      id_number: "ABCDE1234F",
      street_address: "12 MG Road, Near Bus Stand",
      city: "Kadapa",
      postal_code: 516401,
      region: "28",
      address_type: 1,
      email: "ravi@example.com",
      phone: 9010665440,
      dob: "1997-01-02",
      gender: "Male",
      legal_copy_status: "Accept",
      user_consent_data_share: true,
    });
    expect("token" in body).toBe(false);
  });
});

describe("validation", () => {
  test("a complete form passes", () => {
    expect(validateCibilForm(good)).toEqual({});
  });
  test("flags bad PAN, PIN, missing surname and state", () => {
    const e = validateCibilForm({
      ...good,
      pan: "ABC123",
      postalCode: "01234",
      lastName: "",
      region: "",
    });
    expect(Object.keys(e).sort()).toEqual(["lastName", "pan", "postalCode", "region"]);
  });
  test("rejects a future date of birth", () => {
    expect(validateCibilForm({ ...good, dob: "2999-01-01" }).dob).toBeTruthy();
  });
});

describe("outcome / billing", () => {
  test("success is status 1, billable, with url and score", () => {
    const o = readCibilOutcome(200, {
      status: true,
      txn_id: "PP1405490326",
      txn_status: "success",
      message: "Generate Cibil Report",
      data: {
        data: {
          htmlUrl: "https://myscore.cibil.com/x",
          cibilData: { GetCustomerAssetsResponse: { CreditScore: { riskScore: "742" } } },
        },
      },
    });
    expect(o).toMatchObject({
      status: "1",
      billable: true,
      txnId: "PP1405490326",
      htmlUrl: "https://myscore.cibil.com/x",
      score: 742,
    });
  });
  test("invalid token / bad parameters are not charged", () => {
    expect(readCibilOutcome(200, { statuscode: "ERR", status: "Invalid Api token" })).toMatchObject(
      {
        status: null,
        billable: false,
        message: "Invalid Api token",
      },
    );
    expect(
      readCibilOutcome(200, { statuscode: "BPR", message: "Bad Parameter Request" }).billable,
    ).toBe(false);
  });
  test("a transaction id without a report is treated as charged (fail expensive)", () => {
    expect(
      readCibilOutcome(200, { status: false, txn_id: "PP1", txn_status: "failed" }),
    ).toMatchObject({
      status: "2",
      billable: true,
    });
  });
  test("an HTML error page (e.g. IP not allowed) is not charged", () => {
    expect(readCibilOutcome(403, null)).toMatchObject({ status: null, billable: false });
  });
  test("price: ₹76.70 for a report and for an unpriced outcome", () => {
    const s = getService(CIBIL_SERVICE)!;
    expect(s.adminOnly).toBe(true);
    expect(s.provider).toBe("payprime");
    expect(priceFor(s, "1")).toBe(76.7);
    expect(priceFor(s, "2")).toBe(76.7);
    expect(priceFor(s, "1", { [CIBIL_SERVICE]: { "1": 99 } })).toBe(99);
  });
});

describe("score", () => {
  test("ignores out-of-range and score-name fields", () => {
    expect(findScore({ scoreName: "CIBILTUSC3", score: { value: "-1" } })).toBeNull();
    expect(findScore({ a: [{ creditScore: 812 }] })).toBe(812);
  });
});

describe("prefill", () => {
  test("bank file first, earlier lookups fill gaps", () => {
    const f = buildPrefill({
      name: "Ravi  Kumar Reddy",
      email: null,
      extra: {
        Address: "12 MG Road",
        City: "Kadapa",
        State: "ANDHRA PRADESH",
        Pincode: "516 401",
        DOB: "02/01/1997",
      },
      lookup: { pan: "abcde1234f", gender: "M", emails: ["ravi@example.com"] },
    });
    expect(f).toMatchObject({
      firstName: "Ravi",
      lastName: "Kumar Reddy",
      pan: "ABCDE1234F",
      dob: "1997-01-02",
      gender: "Male",
      email: "ravi@example.com",
      streetAddress: "12 MG Road",
      city: "Kadapa",
      postalCode: "516401",
      region: "28",
    });
  });
  test("state names and aliases", () => {
    expect(stateCodeFor("Telangana")).toBe("36");
    expect(stateCodeFor("Orissa")).toBe("21");
    expect(stateCodeFor("Tamil Nadu")).toBe("33");
    expect(stateCodeFor("Atlantis")).toBe("");
  });
  test("dates", () => {
    expect(isoDob("16-07-1978")).toBe("1978-07-16");
    expect(isoDob("1978/7/6")).toBe("1978-07-06");
    expect(isoDob("July 1978")).toBe("");
  });
});

describe("tokens", () => {
  test("comma/space separated, de-duplicated", () => {
    expect(parseTokens(" a1, b2 ,a1\nc3 ")).toEqual(["a1", "b2", "c3"]);
    expect(parseTokens(undefined)).toEqual([]);
  });
  test("only an untransacted Invalid Api token moves to the next token", () => {
    expect(isInvalidToken({ statuscode: "ERR", status: "Invalid Api token" })).toBe(true);
    expect(isInvalidToken({ statuscode: "BPR", message: "Bad Parameter Request" })).toBe(false);
    expect(isInvalidToken({ txn_id: "PP1", message: "Invalid Api token" })).toBe(false);
    expect(isInvalidToken(null)).toBe(false);
  });
});
