import { describe, expect, test } from "bun:test";
import {
  changeAppliesTo,
  changeMailto,
  currentDocument,
  fileSizeLabel,
  isPendingFor,
} from "../src/lib/contracts";
import { CONTRACTS_VISIBLE_TO_COMPANIES } from "../src/lib/contracts";
import { emailConfigured, sendEmails } from "../src/lib/email.server";

const change = (over: Partial<Parameters<typeof isPendingFor>[0]> = {}) => ({
  clientIds: null as string[] | null,
  requiresAcceptance: true,
  withdrawnAt: null as string | null,
  ...over,
});
const acceptance = {
  clientId: "a",
  acceptedName: "Asha",
  acceptedEmail: "asha@example.com",
  acceptedAt: "2026-10-09T10:00:00.000Z",
};

describe("contract changes", () => {
  test("applies to every company, or only the listed ones", () => {
    expect(changeAppliesTo({ clientIds: null }, "a")).toBe(true);
    expect(changeAppliesTo({ clientIds: ["a", "b"] }, "b")).toBe(true);
    expect(changeAppliesTo({ clientIds: ["a"] }, "z")).toBe(false);
  });

  test("pending only when acceptance is needed, not given, not withdrawn, and it applies", () => {
    expect(isPendingFor(change(), "a", undefined)).toBe(true);
    expect(isPendingFor(change(), "a", acceptance)).toBe(false);
    expect(isPendingFor(change({ requiresAcceptance: false }), "a", undefined)).toBe(false);
    expect(isPendingFor(change({ withdrawnAt: "2026-10-09T00:00:00Z" }), "a", undefined)).toBe(
      false,
    );
    expect(isPendingFor(change({ clientIds: ["b"] }), "a", undefined)).toBe(false);
  });
});

describe("currentDocument", () => {
  const doc = (id: string, effectiveDate: string, createdAt = "2026-10-01T00:00:00Z") => ({
    id,
    effectiveDate,
    createdAt,
  });

  test("latest version already in effect; newest upload breaks a tie", () => {
    const docs = [
      doc("v1", "2026-01-01"),
      doc("v2", "2026-06-01"),
      doc("v2b", "2026-06-01", "2026-10-05T00:00:00Z"),
      doc("future", "2026-12-01"),
    ];
    expect(currentDocument(docs, "2026-10-09")?.id).toBe("v2b");
  });

  test("only future versions: the earliest upcoming one", () => {
    expect(
      currentDocument([doc("b", "2027-03-01"), doc("a", "2026-12-01")], "2026-10-09")?.id,
    ).toBe("a");
    expect(currentDocument([], "2026-10-09")).toBeNull();
  });
});

describe("changeMailto", () => {
  test("BCCs each admin once and fills subject and body, spaces as %20", () => {
    const link = changeMailto(["a@x.com", "b@y.com", "a@x.com", " "], {
      title: "Employment lookups added",
      body: "Now ₹5 per lookup.",
      effectiveDate: "2026-10-15",
      requiresAcceptance: true,
    });
    expect(link.startsWith("mailto:?")).toBe(true);
    const params = new URLSearchParams(link.slice("mailto:?".length));
    expect(params.get("bcc")).toBe("a@x.com,b@y.com");
    expect(params.get("subject")).toBe("SamvadX contract update: Employment lookups added");
    expect(params.get("body")).toContain("Now ₹5 per lookup.");
    expect(params.get("body")).toContain("accept it under Contracts");
    expect(link).not.toContain("+");
  });

  test("file sizes", () => {
    expect(fileSizeLabel(null)).toBe("");
    expect(fileSizeLabel(2048)).toBe("2 KB");
    expect(fileSizeLabel(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("email (Resend)", () => {
  const saved = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
  const realFetch = globalThis.fetch;
  const restore = () => {
    process.env.RESEND_API_KEY = saved.key ?? "";
    process.env.EMAIL_FROM = saved.from ?? "";
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    if (saved.from === undefined) delete process.env.EMAIL_FROM;
    globalThis.fetch = realFetch;
  };

  test("does nothing until both settings are present", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = "SamvadX <a@samvadx.com>";
    expect(emailConfigured()).toBe(false);
    expect(await sendEmails([{ to: "x@y.com", subject: "s", text: "t" }])).toBeNull();
    restore();
  });

  test("one recipient per email, batches of 100, a failed batch doesn't stop the rest", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "SamvadX <a@samvadx.com>";
    const bodies: { to: string[]; from: string }[][] = [];
    let call = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      call += 1;
      return new Response(call === 2 ? "rate limited" : "{}", { status: call === 2 ? 429 : 200 });
    }) as unknown as typeof fetch;
    const emails = Array.from({ length: 250 }, (_, i) => ({
      to: `admin${i}@x.com`,
      subject: "s",
      text: "t",
    }));
    const sent = await sendEmails(emails);
    expect(bodies.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(bodies[0][0]).toMatchObject({ to: ["admin0@x.com"], from: "SamvadX <a@samvadx.com>" });
    expect(sent).toBe(150);
    restore();
  });

  test("contracts are superadmin-only for now (user decision, 2026-10-09)", () => {
    expect(CONTRACTS_VISIBLE_TO_COMPANIES).toBe(false);
  });
});
