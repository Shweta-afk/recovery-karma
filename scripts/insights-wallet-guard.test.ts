// Every server action that records a paid Insights lookup must take the money from a wallet
// first (holdInsightsSpend). Until 2026-10-28 an admin's lookups were priced in the ledger but
// came off no wallet — 2,390 lookups, ₹24,359.81, found only by reconciling by hand (CLAUDE.md,
// "Admin lookups come off the company wallet"). This fails the build if a new path that writes a
// lookup row (debtor_traces / insights_manual_lookups) leaves the hold out again.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const LOOKUP_TABLES = ["debtor_traces", "insights_manual_lookups"];

function serverFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return serverFiles(p);
    return /\.server\.ts$/.test(name) ? [p] : [];
  });
}

/** Each `export const X = createServerFn(...)` with its source, up to the next one. */
function serverFns(src: string): { name: string; body: string }[] {
  const re = /export const (\w+) = createServerFn\(/g;
  const starts = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index ?? 0 }));
  return starts.map((s, i) => ({
    name: s.name,
    body: src.slice(s.at, starts[i + 1]?.at ?? src.length),
  }));
}

/** Does this code insert/upsert into a lookup table? (`.from("t")` then `.insert(`/`.upsert(`
 * within the same statement.) */
function writesLookup(body: string): boolean {
  return LOOKUP_TABLES.some((t) =>
    new RegExp(`\\.from\\(\\s*"${t}"\\s*\\)[^;]*?\\.(insert|upsert)\\(`).test(body),
  );
}

const writers = serverFiles("src").flatMap((file) =>
  serverFns(readFileSync(file, "utf8"))
    .filter((fn) => writesLookup(fn.body))
    .map((fn) => ({ file, ...fn })),
);

describe("paid Insights lookups come off a wallet", () => {
  test("the known paid paths are found (so the scan itself still works)", () => {
    const names = writers.map((w) => w.name).sort();
    for (const n of ["runCibilBorrower", "runCibilManual", "runManualInsight", "runProfilexTrace"])
      expect(names).toContain(n);
  });

  test("every server action that records a lookup holds wallet money first", () => {
    const missing = writers
      .filter((w) => !/holdInsightsSpend\(/.test(w.body))
      .map((w) => `${w.file}: ${w.name}`);
    expect(missing).toEqual([]);
  });
});
