import { describe, expect, test } from "bun:test";
import {
  PLATFORM_SUBDOMAIN,
  RESERVED_SUBDOMAINS,
  expectedLoginSubdomain,
  loginUrlFor,
  subdomainFromHostname,
  subdomainProblem,
  wrongAddressRedirect,
} from "../src/lib/company-address";

describe("subdomainFromHostname", () => {
  test("one label under samvadx.com", () => {
    expect(subdomainFromHostname("rrdebt.samvadx.com")).toBe("rrdebt");
    expect(subdomainFromHostname("RRDebt.SamvadX.com")).toBe("rrdebt");
    expect(subdomainFromHostname("rrdebt.samvadx.com.")).toBe("rrdebt");
  });
  test("never local dev, previews, Railway domains, the bare domain or deeper names", () => {
    expect(subdomainFromHostname("localhost")).toBeNull();
    expect(subdomainFromHostname("127.0.0.1")).toBeNull();
    expect(subdomainFromHostname("samvadx.com")).toBeNull();
    expect(subdomainFromHostname("a.b.samvadx.com")).toBeNull();
    expect(subdomainFromHostname("pwbsw6r2.up.railway.app")).toBeNull();
    expect(subdomainFromHostname("id-preview--abc.lovable.app")).toBeNull();
    expect(subdomainFromHostname("rrdebt.samvadx.com.evil.com")).toBeNull();
  });
});

describe("where a company signs in", () => {
  test("its own subdomain, else the platform address", () => {
    expect(expectedLoginSubdomain("kuber")).toBe("kuber");
    expect(expectedLoginSubdomain(null)).toBe(PLATFORM_SUBDOMAIN);
    expect(expectedLoginSubdomain("")).toBe(PLATFORM_SUBDOMAIN);
    expect(expectedLoginSubdomain(undefined)).toBe(PLATFORM_SUBDOMAIN);
  });

  test("right address: nothing happens", () => {
    expect(wrongAddressRedirect("kuber.samvadx.com", "kuber")).toBeNull();
    expect(wrongAddressRedirect("app.samvadx.com", null)).toBeNull();
    expect(wrongAddressRedirect("axiotta.samvadx.com", "axiotta")).toBeNull();
  });

  test("another company's address -> own address", () => {
    expect(wrongAddressRedirect("kuber.samvadx.com", "rrdebt")).toBe("rrdebt");
  });

  test("platform address, company has its own -> own address", () => {
    expect(wrongAddressRedirect("app.samvadx.com", "gkb")).toBe("gkb");
    expect(wrongAddressRedirect("axiotta.samvadx.com", "gkb")).toBe("gkb");
  });

  test("no subdomain yet, on someone else's or an unknown address -> platform address", () => {
    expect(wrongAddressRedirect("kuber.samvadx.com", null)).toBe(PLATFORM_SUBDOMAIN);
    expect(wrongAddressRedirect("typo.samvadx.com", null)).toBe(PLATFORM_SUBDOMAIN);
  });

  test("hosts outside samvadx.com are never redirected", () => {
    expect(wrongAddressRedirect("localhost", "kuber")).toBeNull();
    expect(wrongAddressRedirect("pwbsw6r2.up.railway.app", "kuber")).toBeNull();
  });

  test("the login URL carries only a flag, never personal data", () => {
    expect(loginUrlFor("gkb")).toBe("https://gkb.samvadx.com/login?moved=1");
  });
});

describe("subdomainProblem", () => {
  test("format", () => {
    expect(subdomainProblem("acme")).toBeNull();
    expect(subdomainProblem("acme-2")).toBeNull();
    expect(subdomainProblem("Acme")).not.toBeNull();
    expect(subdomainProblem("-acme")).not.toBeNull();
    expect(subdomainProblem("acme.co")).not.toBeNull();
    expect(subdomainProblem("")).not.toBeNull();
  });

  test("the platform address and reserved names can't be given to a company", () => {
    expect(PLATFORM_SUBDOMAIN).toBe("app");
    expect(subdomainProblem("app")).toMatch(/platform's own sign-in address/);
    expect(subdomainProblem("api")).toMatch(/reserved/);
    expect(subdomainProblem("www")).toMatch(/reserved/);
  });

  test("a grandfathered reserved name can be re-saved, but never the platform address", () => {
    expect(subdomainProblem("api", "api")).toBeNull();
    // Demo held "app" before it became the platform address; it has to move.
    expect(subdomainProblem("app", "app")).toMatch(/platform's own sign-in address/);
  });

  test("Axiotta's own company may have axiotta", () => {
    expect(subdomainProblem("axiotta")).toBeNull();
  });

  test("no live company subdomain is reserved (2026-10-10; Demo is moving off app)", () => {
    const live = [
      "axiotta",
      "demo",
      "rrdebt",
      "kuber",
      "abhiyanta",
      "quickconnect",
      "realtrack",
      "sh",
      "atsolution",
      "mathura",
      "gkb",
    ];
    for (const s of live) expect(subdomainProblem(s)).toBeNull();
    expect(RESERVED_SUBDOMAINS).toContain("app");
    expect(RESERVED_SUBDOMAINS).not.toContain("axiotta");
  });
});
