import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EMAIL_OTP_AMR_METHODS, roleNeedsEmailOtp, tokenHasEmailOtp } from "../src/lib/login-otp";

/** An unsigned JWT-shaped string — tokenHasEmailOtp only ever reads the payload. */
function tokenWith(payload: unknown): string {
  const b64url = (s: string) =>
    Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

describe("tokenHasEmailOtp", () => {
  test("an emailed-code sign-in counts", () => {
    expect(tokenHasEmailOtp(tokenWith({ amr: [{ method: "otp", timestamp: 1 }] }))).toBe(true);
  });
  test("clicking the link in the same email counts", () => {
    expect(tokenHasEmailOtp(tokenWith({ amr: [{ method: "magiclink", timestamp: 1 }] }))).toBe(
      true,
    );
  });
  test("a password-only sign-in does not", () => {
    expect(tokenHasEmailOtp(tokenWith({ amr: [{ method: "password", timestamp: 1 }] }))).toBe(
      false,
    );
  });
  test("missing, malformed or empty tokens read as not verified", () => {
    expect(tokenHasEmailOtp(undefined)).toBe(false);
    expect(tokenHasEmailOtp("")).toBe(false);
    expect(tokenHasEmailOtp("not-a-jwt")).toBe(false);
    expect(tokenHasEmailOtp("a.!!!.c")).toBe(false);
    expect(tokenHasEmailOtp(tokenWith({}))).toBe(false);
    expect(tokenHasEmailOtp(tokenWith({ amr: "otp" }))).toBe(false);
    expect(tokenHasEmailOtp(tokenWith({ amr: ["otp"] }))).toBe(false);
  });
  test("handles payloads whose base64url needs padding and uses - and _", () => {
    // Long enough, with characters that encode to '-'/'_', to exercise both code paths.
    const t = tokenWith({ amr: [{ method: "otp" }], sub: "??>>~~" + "x".repeat(37) });
    expect(tokenHasEmailOtp(t)).toBe(true);
  });
});

describe("roleNeedsEmailOtp", () => {
  test("admins and superadmins only", () => {
    expect(roleNeedsEmailOtp("admin")).toBe(true);
    expect(roleNeedsEmailOtp("superadmin")).toBe(true);
    expect(roleNeedsEmailOtp("manager")).toBe(false);
    expect(roleNeedsEmailOtp("agent")).toBe(false);
    expect(roleNeedsEmailOtp(undefined)).toBe(false);
  });
});

test("the SQL auth_session_email_verified() accepts exactly the same amr methods", () => {
  const sql = readFileSync(
    new URL("../src/supabase/migrations/20261006_admin_email_otp.sql", import.meta.url),
    "utf8",
  );
  const m = /e ->> 'method' IN \(([^)]*)\)/.exec(sql);
  expect(m).not.toBeNull();
  const methods = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  expect(methods).toEqual([...EMAIL_OTP_AMR_METHODS].sort());
});
