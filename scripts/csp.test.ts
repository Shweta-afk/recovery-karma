import { test, expect } from "bun:test";
import { buildCspReportOnly, handleCspReport, CSP_REPORT_PATH } from "../src/lib/csp";

test("csp: policy is exact about Supabase, closes plugins/frames, and reports to our endpoint", () => {
  process.env.SUPABASE_URL = "https://abc123.supabase.co";
  const p = buildCspReportOnly();
  expect(p).toContain("connect-src 'self' https://abc123.supabase.co wss://abc123.supabase.co");
  expect(p).toContain("object-src 'none'");
  expect(p).toContain("frame-src 'none'");
  expect(p).toContain("base-uri 'self'");
  expect(p).toContain(`report-uri ${CSP_REPORT_PATH}`);
  expect(p).toContain("https://fonts.gstatic.com");
});

test("csp: falls back to the hosted wildcard when the Supabase URL is missing or malformed", () => {
  process.env.SUPABASE_URL = "not a url";
  expect(buildCspReportOnly()).toContain("https://*.supabase.co wss://*.supabase.co");
});

test("csp: the report endpoint always answers 204 and survives garbage, oversize and wrong methods", async () => {
  const post = (body: string, type = "application/csp-report") =>
    handleCspReport(
      new Request("http://x/api/csp-report", {
        method: "POST",
        headers: { "content-type": type },
        body,
      }),
    );
  expect(
    (
      await post(
        JSON.stringify({
          "csp-report": {
            "blocked-uri": "https://evil.example",
            "effective-directive": "script-src",
          },
        }),
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await post(
        JSON.stringify([{ body: { blockedURL: "https://x", effectiveDirective: "img-src" } }]),
        "application/reports+json",
      )
    ).status,
  ).toBe(204);
  expect((await post("{{{ not json")).status).toBe(204);
  expect((await post("x".repeat(50_000))).status).toBe(204);
  expect(
    (await handleCspReport(new Request("http://x/api/csp-report", { method: "GET" }))).status,
  ).toBe(405);
});
