// Error codes users see (src/lib/app-error.ts): every code used once, every code listed in
// docs/ERROR_CODES.md, and the browser filter hides database/vendor text but keeps our own
// plain sentences.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { appError, errorText, GENERIC_CODE } from "../src/lib/app-error";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !p.endsWith("app-error.ts") ? [p] : [];
  });
}

const used = sourceFiles("src").flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/appError\(\s*"(SX-\d{4})"/g)].map((m) => ({
    code: m[1],
    file,
  })),
);
const doc = readFileSync("docs/ERROR_CODES.md", "utf8");

describe("error codes", () => {
  test("some codes are in use", () => {
    expect(used.length).toBeGreaterThan(50);
  });

  test("no code is used twice", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const { code, file } of used) {
      if (seen.has(code)) dupes.push(`${code}: ${seen.get(code)} and ${file}`);
      seen.set(code, file);
    }
    expect(dupes).toEqual([]);
  });

  test("every code is listed in docs/ERROR_CODES.md", () => {
    const missing = used.filter(({ code }) => !doc.includes(`| ${code} |`)).map((u) => u.code);
    expect(missing).toEqual([]);
    expect(doc.includes(`| ${GENERIC_CODE} |`)).toBe(true);
  });
});

describe("errorText", () => {
  const original = console.error;
  beforeAll(() => {
    console.error = () => {};
  });
  afterAll(() => {
    console.error = original;
  });

  test("keeps our coded messages", () => {
    const e = appError("SX-1003", "Could not load your Insights wallet.");
    expect(errorText(e, "x")).toBe("Could not load your Insights wallet. (SX-1003)");
  });

  test("keeps plain validation sentences", () => {
    expect(errorText(new Error("Enter a valid 10-digit mobile number."), "x")).toBe(
      "Enter a valid 10-digit mobile number.",
    );
    expect(errorText(new Error("That email already has an account."), "x")).toBe(
      "That email already has an account.",
    );
  });

  test.each([
    'new row violates row-level security policy for table "debtors"',
    "column debtors.extra_named does not exist",
    "Could not find the function public.debtor_list(p) in the schema cache",
    "PayPrime did not return a report (No Record Found).",
    "Insights is not configured. Set PROFILEX_SECRET_KEY",
    "The data provider rejected this request (HTTP 500: Invalid service url)",
    "Failed to fetch",
    "duplicate key value violates unique constraint",
  ])("hides %s", (message) => {
    expect(errorText(new Error(message), "Could not save")).toBe(
      `Could not save. Please try again (${GENERIC_CODE}).`,
    );
  });

  test("hides a raw database error object", () => {
    const pg = { message: "permission denied", code: "42501", details: null, hint: null };
    expect(errorText(pg, "Could not load")).toContain(GENERIC_CODE);
  });

  test("falls back when there is no message", () => {
    expect(errorText(undefined, "Upload failed")).toBe(
      `Upload failed. Please try again (${GENERIC_CODE}).`,
    );
  });
});
