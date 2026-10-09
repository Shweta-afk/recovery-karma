import { describe, expect, test } from "bun:test";
import {
  changeAppliesTo,
  changeMailto,
  currentDocument,
  fileSizeLabel,
  isPendingFor,
} from "../src/lib/contracts";

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
