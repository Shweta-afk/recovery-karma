/**
 * CSV parsing, which is where bad data enters the system.
 *
 * The cases below are not exotic: an address with a newline, a name with an apostrophe-quote,
 * a BOM from an Excel export. Each one used to shift or corrupt columns silently — no error,
 * no warning, just a portfolio of misaligned debtor records.
 */
import { expect, test } from "bun:test";
import { parseCsvText, parseCsvLine } from "../src/lib/utils";

test("plain rows", () => {
  expect(parseCsvText("a,b,c\n1,2,3")).toEqual([
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("CRLF line endings", () => {
  expect(parseCsvText("a,b\r\n1,2\r\n")).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("a quoted field containing a comma stays one field", () => {
  expect(parseCsvText('name,addr\nRavi,"12 MG Road, Bangalore"')).toEqual([
    ["name", "addr"],
    ["Ravi", "12 MG Road, Bangalore"],
  ]);
});

test("a quoted field containing a NEWLINE stays one row", () => {
  // The bug this parser exists for: line-splitting first turned this into two broken rows and
  // shifted every column after it.
  const rows = parseCsvText('name,addr\nRavi,"12 MG Road\nBangalore 560001"\nPriya,Delhi');
  expect(rows).toHaveLength(3);
  expect(rows[1]).toEqual(["Ravi", "12 MG Road\nBangalore 560001"]);
  expect(rows[2]).toEqual(["Priya", "Delhi"]);
});

test('"" is one literal quote, not two toggles', () => {
  expect(parseCsvText('note\n"He said ""yes"" on call"')).toEqual([
    ["note"],
    ['He said "yes" on call'],
  ]);
});

test("a UTF-8 BOM does not glue itself to the first header", () => {
  // With the BOM attached, "Loan ID" matches no alias and the column silently goes unmapped.
  const rows = parseCsvText("﻿Loan ID,Name\nLN-1,Ravi");
  expect(rows[0][0]).toBe("Loan ID");
});

test("blank lines carry no record", () => {
  expect(parseCsvText("a,b\n\n1,2\n\n")).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("a trailing empty field is preserved", () => {
  // Excel's trailing comma — the column must keep its position or every later index shifts.
  expect(parseCsvText("a,b,c\n1,2,")).toEqual([
    ["a", "b", "c"],
    ["1", "2", ""],
  ]);
});

test("parseCsvLine also stops eating escaped quotes", () => {
  expect(parseCsvLine('a,"He said ""hi""",c')).toEqual(["a", 'He said "hi"', "c"]);
});
