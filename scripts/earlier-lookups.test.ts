import { describe, expect, test } from "bun:test";
import { sameLoanAndBorrower } from "../src/lib/profilex/earlier-lookups";

const me = { loanReference: " LL12345 ", name: "Ramesh  Kumar", phone: "9876543210" };

describe("earlier lookups: same loan and same borrower", () => {
  test("same loan ID (any case / spacing) and same phone", () => {
    expect(
      sameLoanAndBorrower(me, { loanReference: "ll12345", name: "R K", phone: "+91 98765 43210" }),
    ).toBe(true);
  });
  test("same loan ID and same name, phone changed", () => {
    expect(
      sameLoanAndBorrower(me, {
        loanReference: "LL12345",
        name: "ramesh kumar",
        phone: "9000000000",
      }),
    ).toBe(true);
  });
  test("same loan ID but a different borrower is not matched", () => {
    expect(
      sameLoanAndBorrower(me, { loanReference: "LL12345", name: "Suresh", phone: "9000000000" }),
    ).toBe(false);
  });
  test("different loan ID is never matched, even for the same phone", () => {
    expect(
      sameLoanAndBorrower(me, {
        loanReference: "LL99999",
        name: "Ramesh Kumar",
        phone: "9876543210",
      }),
    ).toBe(false);
  });
  test("a blank loan ID matches nothing", () => {
    const blank = { ...me, loanReference: "  " };
    expect(sameLoanAndBorrower(blank, { ...blank })).toBe(false);
  });
});
