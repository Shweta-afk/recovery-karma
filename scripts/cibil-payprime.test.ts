// CIBIL via PayPrime: what is sent, what counts as charged, and what the form prefills.
// Under-recording a charge or sending a wrong field (PayPrime answers "Bad Parameter Request"
// with no detail) are the two failures that cost money or a day of debugging.
import { describe, expect, test } from "bun:test";
import {
  buildPrefill,
  cibilRequestBody,
  buildReportHtml,
  findScore,
  isUsableReportHtml,
  reportFileName,
  withBaseHref,
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

describe("minimal request", () => {
  test("blank optional fields are left out, consent fields always sent", () => {
    const body = cibilRequestBody(
      {
        ...good,
        lastName: "",
        gender: "",
        email: "",
        streetAddress: "",
        city: "",
        postalCode: "",
        region: "",
      },
      "9010665440",
    );
    expect(body).toEqual({
      first_name: "Ravi",
      id_type: "TaxId",
      id_number: "ABCDE1234F",
      phone: 9010665440,
      dob: "1997-01-02",
      legal_copy_status: "Accept",
      user_consent_data_share: true,
    });
  });
});

describe("validation", () => {
  test("a complete form passes", () => {
    expect(validateCibilForm(good)).toEqual({});
  });
  test("only name, PAN and date of birth are required", () => {
    const minimal: CibilForm = {
      ...good,
      lastName: "",
      gender: "",
      email: "",
      streetAddress: "",
      city: "",
      postalCode: "",
      region: "",
    };
    expect(validateCibilForm(minimal)).toEqual({});
    const e = validateCibilForm({ ...minimal, firstName: "", pan: "ABC123", dob: "" });
    expect(Object.keys(e).sort()).toEqual(["dob", "firstName", "pan"]);
  });
  test("optional fields are still checked when filled in", () => {
    const e = validateCibilForm({ ...good, postalCode: "01234", email: "nope" });
    expect(Object.keys(e).sort()).toEqual(["email", "postalCode"]);
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
    expect(s.provider).toBe("payprime");
    expect(priceFor(s, "1")).toBe(76.7);
    expect(priceFor(s, "2")).toBe(76.7);
    expect(priceFor(s, "1", { [CIBIL_SERVICE]: { "1": 99 } })).toBe(99);
  });
});

describe("failure reason", () => {
  test("no record found carries PayPrime's inner reason and counts as charged", () => {
    const o = readCibilOutcome(200, {
      status: false,
      txn_id: "PP9811349700",
      txn_status: "failed",
      message: "Generate Cibil Report Failed",
      data: { code: 2, message: "No Record Found", status: 200 },
    });
    expect(o).toMatchObject({
      status: "2",
      billable: true,
      message: "Generate Cibil Report Failed: No Record Found",
    });
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

describe("download", () => {
  test("an empty app shell or login page is not saved; a real page is", () => {
    expect(
      isUsableReportHtml('<html><body><div id="root"></div><script>x</script></body></html>'),
    ).toBe(false);
    expect(isUsableReportHtml(`<html><body>Please sign in ${"x".repeat(500)}</body></html>`)).toBe(
      false,
    );
    expect(
      isUsableReportHtml(
        `<html><body><table>${"<tr><td>Account 1234</td></tr>".repeat(40)}</table></body></html>`,
      ),
    ).toBe(true);
  });
  test("relative links point back at the source site", () => {
    expect(
      withBaseHref("<html><head><title>x</title></head></html>", "https://myscore.cibil.com/a/b"),
    ).toContain('<head><base href="https://myscore.cibil.com/">');
  });
  test("built report escapes what it shows", () => {
    const html = buildReportHtml({
      subject: "Ravi <b>",
      score: 742,
      createdAt: "2026-10-11T06:00:00Z",
      txnId: "PP1",
      htmlUrl: null,
      fields: [{ label: "Name", value: "<script>" }],
    });
    expect(html).toContain("Ravi &lt;b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("742");
  });
  test("file name", () => {
    expect(reportFileName("Ravi Kumar · ABCDE1234F", "2026-10-10T20:00:00Z")).toBe(
      "CIBIL-Ravi-Kumar-2026-10-11.html",
    );
  });
});
