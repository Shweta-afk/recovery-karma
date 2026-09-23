import { describe, expect, test } from "bun:test";
import { monthsBetween, shapeSheet, ARCHIVE_SHEETS } from "../src/lib/archive-shared";

describe("monthsBetween", () => {
  test("lists every month inclusive, across a year boundary", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });
  test("a single month", () => {
    expect(monthsBetween("2026-09", "2026-09")).toEqual(["2026-09"]);
  });
  test("returns nothing for reversed or malformed input rather than looping forever", () => {
    expect(monthsBetween("2026-10", "2026-09")).toEqual([]);
    expect(monthsBetween("2026-13", "2026-14")).toEqual([]);
    expect(monthsBetween("garbage", "2026-09")).toEqual([]);
  });
});

describe("shapeSheet", () => {
  test("unions columns in first-seen order and pads missing cells with null", () => {
    const { columns, values } = shapeSheet([
      { a: 1, b: "x" },
      { b: "y", c: true },
    ]);
    expect(columns).toEqual(["a", "b", "c"]);
    expect(values).toEqual([
      [1, "x", null],
      [null, "y", true],
    ]);
  });
  test("spreads the bank file's extra columns into one column each", () => {
    const { columns, values } = shapeSheet([
      { name: "Ravi", extra: { city: "Pune", branch: "B1" } },
    ]);
    expect(columns).toEqual(["name", "extra: city", "extra: branch"]);
    expect(values[0]).toEqual(["Ravi", "Pune", "B1"]);
  });
  test("keeps other nested values whole, as JSON text", () => {
    const { values } = shapeSheet([{ response: { employer: "X" } }]);
    expect(values[0][0]).toBe('{"employer":"X"}');
  });
  test("truncates a cell over Excel's limit instead of corrupting the workbook", () => {
    const { values } = shapeSheet([{ t: "a".repeat(40_000) }]);
    expect(String(values[0][0]).length).toBeLessThan(32_767);
    expect(String(values[0][0])).toContain("[truncated]");
  });
  test("null and undefined become empty cells", () => {
    expect(shapeSheet([{ a: null, b: undefined }]).values[0]).toEqual([null, null]);
  });
});

describe("ARCHIVE_SHEETS", () => {
  test("covers every kind the database allows, with unique sheet names", () => {
    const kinds = ARCHIVE_SHEETS.map((s) => s.kind).sort();
    expect(kinds).toEqual(
      [
        "call_log",
        "debtor",
        "dispute",
        "message",
        "payment",
        "portfolio",
        "portfolio_target",
        "settlement",
        "trace",
      ].sort(),
    );
    expect(new Set(ARCHIVE_SHEETS.map((s) => s.sheet)).size).toBe(ARCHIVE_SHEETS.length);
  });
});
