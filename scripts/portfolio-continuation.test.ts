// Guards for "Continues portfolio" on the upload page (src/lib/portfolio-continuation.ts).
import { describe, expect, test } from "bun:test";
import {
  describeFootprint,
  lendersDiffer,
  normaliseLender,
} from "../src/lib/portfolio-continuation";

describe("lendersDiffer", () => {
  test("the 2026-10-22 case: an RBL file continuing AU BANK is flagged", () => {
    expect(lendersDiffer("RBL", "AU BANK")).toBe(true);
  });

  test("the same lender written differently is not flagged", () => {
    expect(lendersDiffer("AU Bank", "AU BANK")).toBe(false);
    expect(lendersDiffer("AU Bank Ltd.", "au bank")).toBe(false);
    expect(lendersDiffer("RBL Bank", "RBL")).toBe(false);
    expect(lendersDiffer("BAJAJ", "Bajaj Finance")).toBe(false);
  });

  test("an abbreviation can't be told apart, so it warns (a warning, never a block)", () => {
    expect(lendersDiffer("LL", "Liquiloan")).toBe(true);
  });

  test("a blank lender on either side says nothing", () => {
    expect(lendersDiffer("", "AU BANK")).toBe(false);
    expect(lendersDiffer("RBL", null)).toBe(false);
  });

  test("normalising drops filler words and punctuation", () => {
    expect(normaliseLender("AU Small Finance Bank Ltd.")).toBe("ausmall");
  });
});

describe("describeFootprint", () => {
  test("lists only what is there", () => {
    expect(describeFootprint({ accounts: 594, lookups: 470, calls: 0 })).toBe(
      "594 accounts and 470 Insights lookups",
    );
    expect(describeFootprint({ accounts: 1, lookups: 0, calls: 0 })).toBe("1 account");
    expect(describeFootprint({ accounts: 1200, lookups: 1, calls: 3 })).toBe(
      "1,200 accounts, 1 Insights lookup and 3 calls",
    );
  });
});
