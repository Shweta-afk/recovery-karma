// The master agreement is one text for every company: it must fill completely (no {{blank}}
// SamvadX doesn't know) and must not hard-code either party — renaming SamvadX's company or a
// client is supposed to flow through without editing the text.
import { describe, expect, test } from "bun:test";
import { entityPhrase, fillTemplate, templateValueMap } from "../src/lib/contract-template";
import { DEFAULT_MASTER_AGREEMENT_BODY } from "../src/lib/master-agreement";

const base = {
  companyName: "Acme",
  companyLegalName: "Acme Recoveries Private Limited",
  companyGstin: "29AAPFU0939F1ZV",
  companyAddress: "12 MG Road, Bengaluru, Karnataka – 560001",
  companyPan: "AAPFU0939F",
  companySignatoryName: "Asha Rao",
  companySignatoryDesignation: "Director",
  supplierLegalName: "Newco Communications Private Limited",
  supplierShortName: "Newco",
  supplierCin: "U12345MH2026PTC000001",
  supplierAddress: "Mumbai",
  supplierSignatoryName: "V. Manere",
  supplierSignatoryDesignation: "Director",
  signedBy: "Asha Rao",
  signedDate: "12 October 2026",
  effectiveDate: "12 October 2026",
  today: "12 October 2026",
  prices: { setupLines: [], monthlyLines: [], perSeatFee: 500, paymentTermsDays: null },
  paymentTermsDays: 15,
  agentSeatLimit: null,
  managerSeatLimit: null,
  insightsPrices: [],
} as const satisfies Parameters<typeof templateValueMap>[0];
const values = templateValueMap(base);

describe("master agreement", () => {
  test("every blank is one SamvadX fills", () => {
    expect(fillTemplate(DEFAULT_MASTER_AGREEMENT_BODY, values).unknown).toEqual([]);
  });
  test("no company name is hard-coded", () => {
    expect(DEFAULT_MASTER_AGREEMENT_BODY).not.toMatch(/axiotta/i);
    const text = fillTemplate(DEFAULT_MASTER_AGREEMENT_BODY, values).text;
    expect(text).toContain("Newco Communications Private Limited");
    expect(text).toContain("NEWCO WILL NOT HELP CLIENT");
    expect(text).toContain("Acme Recoveries Private Limited");
    expect(text).not.toContain("{{");
  });
});

describe("entityPhrase — how each party is described", () => {
  test("a proprietor (PAN 4th letter P, no CIN) is not called a company", () => {
    const t = entityPhrase({ pan: "AAJPZ2623H", gstinUnregistered: "Not registered" });
    expect(t).toBe("a sole proprietorship (Proprietor PAN: AAJPZ2623H; GSTIN: Not registered)");
  });
  test("a CIN means a company; an LLPIN an LLP", () => {
    expect(entityPhrase({ cin: "U12345MH2026PTC000001", pan: "AAPCU0939F" })).toMatch(
      /^a company incorporated in India \(CIN \/ LLPIN: U12345MH2026PTC000001/,
    );
    expect(entityPhrase({ cin: "AAB-1234", pan: "AAPFU0939F" })).toMatch(/^a limited liability/);
  });
  test("a firm's PAN without a CIN reads as a partnership", () => {
    expect(entityPhrase({ pan: "ABLFA5633P", gstin: "27ABLFA5633P1ZV" })).toBe(
      "a partnership firm / LLP (PAN: ABLFA5633P; GSTIN: 27ABLFA5633P1ZV)",
    );
  });
  test("the opening of the agreement uses it for both parties", () => {
    const text = fillTemplate(
      DEFAULT_MASTER_AGREEMENT_BODY,
      templateValueMap({ ...base, supplierCin: "", supplierPan: "AAJPZ2623H", companyCin: "" }),
    ).text;
    expect(text).toContain("a sole proprietorship (Proprietor PAN: AAJPZ2623H");
    expect(text).not.toContain("incorporated under the Companies Act");
  });
});
