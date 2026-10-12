// Invoice and agreement emails: the link must land on the company's OWN address (a company user
// can only sign in there), and the mail-app fallback must carry exactly one recipient.
import { describe, expect, test } from "bun:test";
import {
  agreementEmail,
  companyAppLink,
  invoiceEmail,
  mailtoLink,
} from "../src/lib/billing-delivery";
import { documentStage } from "../src/lib/contracts";

describe("links", () => {
  test("company address, or the platform address without one", () => {
    expect(companyAppLink("acme", "/admin/billing", { invoice: "abc" })).toBe(
      "https://acme.samvadx.com/admin/billing?invoice=abc",
    );
    expect(companyAppLink(null, "/admin/billing")).toBe("https://app.samvadx.com/admin/billing");
  });
});

describe("emails", () => {
  test("invoice email has the amount, due date and link", () => {
    const e = invoiceEmail(
      { invoiceNumber: "SX/2627/0007", total: 11800, dueDate: "2026-10-27", description: "setup" },
      "Acme",
      "https://acme.samvadx.com/admin/billing?invoice=1",
      "Axiotta Technologies Private Limited",
    );
    expect(e.subject).toContain("SX/2627/0007");
    expect(e.text).toContain("₹11,800.00");
    expect(e.text).toContain("2026-10-27");
    expect(e.text).toContain("https://acme.samvadx.com/admin/billing?invoice=1");
  });
  test("agreement email links to sign", () => {
    const e = agreementEmail({ title: "Agreement", effectiveDate: "2026-10-12" }, "Acme", "L");
    expect(e.subject).toMatch(/sign/i);
    expect(e.text).toContain("L");
  });
  test("mailto has one recipient and an encoded body", () => {
    const m = mailtoLink("a@b.com", { subject: "Hi & bye", text: "line1\nline2" });
    expect(m.startsWith("mailto:a%40b.com?subject=Hi%20%26%20bye&body=line1%0Aline2")).toBe(true);
  });
});

describe("agreement stage", () => {
  const base = {
    documentId: "d",
    clientId: "c",
    sentAt: null,
    sentTo: null,
    sentVia: null,
    viewedAt: null,
    signedAt: null,
    signedName: null,
    signedEmail: null,
  };
  test("signed beats viewed beats sent", () => {
    expect(documentStage(null)).toBe("not_sent");
    expect(documentStage({ ...base, sentAt: "x" })).toBe("sent");
    expect(documentStage({ ...base, sentAt: "x", viewedAt: "y" })).toBe("viewed");
    expect(documentStage({ ...base, viewedAt: "y", signedAt: "z" })).toBe("signed");
  });
});
