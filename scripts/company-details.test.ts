// A company's details for invoices and agreements: what counts as complete (it decides whether
// every admin page shows a red banner) and the slips the checks catch before they reach an
// invoice — a GSTIN from another state flips CGST/SGST vs IGST.
import { describe, expect, test } from "bun:test";
import {
  EMPTY_COMPANY_DETAILS,
  checkCompanyDetails,
  companyDetailsFromRow,
  companyDetailsToRow,
  fullAddress,
  isCompanyDetailsComplete,
  type CompanyDetails,
} from "../src/lib/company-details";

const full: CompanyDetails = {
  legalName: "Acme Recoveries Private Limited",
  gstUnregistered: false,
  gstin: "29AAPFU0939F1ZV",
  pan: "AAPFU0939F",
  cin: "U72900KA2020PTC123456",
  address: "12 MG Road",
  city: "Bengaluru",
  pinCode: "560001",
  stateCode: "29",
  email: "accounts@acme.example",
  phone: "9876543210",
  signatoryName: "Asha Rao",
  signatoryDesignation: "Director",
};

describe("complete or not", () => {
  test("a fully filled form is complete", () => {
    expect(checkCompanyDetails(full)).toEqual({ missing: [], invalid: {} });
    expect(isCompanyDetailsComplete(full)).toBe(true);
  });
  test("an empty form lists every required detail", () => {
    const { missing } = checkCompanyDetails(EMPTY_COMPANY_DETAILS);
    expect(missing).toContain("GSTIN");
    expect(missing).toContain("Authorised signatory name");
    expect(missing).not.toContain("CIN / LLPIN");
    expect(missing).toHaveLength(11);
  });
  test("CIN is optional; GSTIN is not needed when unregistered", () => {
    expect(isCompanyDetailsComplete({ ...full, cin: "" })).toBe(true);
    expect(isCompanyDetailsComplete({ ...full, gstin: "", gstUnregistered: true })).toBe(true);
    expect(isCompanyDetailsComplete({ ...full, gstin: "" })).toBe(false);
  });
});

describe("slips caught", () => {
  test("GSTIN from another state", () => {
    expect(checkCompanyDetails({ ...full, stateCode: "27" }).invalid.stateCode).toMatch(
      /Karnataka/,
    );
  });
  test("PAN that isn't the one inside the GSTIN", () => {
    expect(checkCompanyDetails({ ...full, pan: "BBBBB1111B" }).invalid.pan).toBeTruthy();
  });
  test("bad formats", () => {
    const { invalid } = checkCompanyDetails({
      ...full,
      gstin: "123",
      pinCode: "012345",
      email: "nope",
      phone: "12345",
      cin: "X",
    });
    expect(Object.keys(invalid).sort()).toEqual(["cin", "email", "gstin", "phone", "pinCode"]);
  });
  test("lower-case and spaces are cleaned, not rejected", () => {
    expect(
      isCompanyDetailsComplete({ ...full, gstin: " 29aapfu0939f1zv ", pan: "aapfu 0939f" }),
    ).toBe(true);
  });
});

describe("storage and printing", () => {
  test("row round trip; unregistered stores no GSTIN", () => {
    expect(companyDetailsFromRow(companyDetailsToRow(full))).toEqual(full);
    expect(companyDetailsToRow({ ...full, gstUnregistered: true }).gstin).toBeNull();
  });
  test("an older row without the new columns reads as empty, not broken", () => {
    const d = companyDetailsFromRow({ legal_name: "X", address: "Y", state_code: "29" });
    expect(d.pan).toBe("");
    expect(d.gstUnregistered).toBe(false);
  });
  test("full address joins city, state and PIN once", () => {
    expect(fullAddress(full)).toBe("12 MG Road, Bengaluru, Karnataka – 560001");
    expect(fullAddress({ ...full, address: "12 MG Road, Bengaluru 560001" })).toBe(
      "12 MG Road, Bengaluru 560001, Karnataka",
    );
  });
});
