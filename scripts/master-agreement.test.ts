// The master agreement is one text for every company: it must fill completely (no {{blank}}
// SamvadX doesn't know) and must not hard-code either party — renaming SamvadX's company or a
// client is supposed to flow through without editing the text.
import { describe, expect, test } from "bun:test";
import { fillTemplate, templateValueMap } from "../src/lib/contract-template";
import { DEFAULT_MASTER_AGREEMENT_BODY } from "../src/lib/master-agreement";

const values = templateValueMap({
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
});

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
