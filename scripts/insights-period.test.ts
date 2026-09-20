import { expect, test } from "bun:test";
import { periodSince } from "../src/lib/profilex/period";

test("this month starts at the first IST midnight, not the UTC one", () => {
  // 2026-09-01 02:00 IST is still 2026-08-31 20:30 UTC.
  const now = new Date("2026-08-31T20:30:00Z");
  expect(periodSince("this-month", now)).toBe("2026-08-31T18:30:00.000Z");
});

test("last 90 days starts at an IST midnight 90 days back", () => {
  const now = new Date("2026-09-20T10:00:00Z"); // 15:30 IST on the 20th
  // 90 days before 2026-09-20 is 2026-06-22; its IST midnight is 2026-06-21T18:30Z.
  expect(periodSince("last-90", now)).toBe("2026-06-21T18:30:00.000Z");
});

test("last 90 days rolls at IST midnight, not UTC", () => {
  // 01:00 IST on the 21st is still the 20th in UTC; the window must already be the 21st's.
  const now = new Date("2026-09-20T19:30:00Z");
  expect(periodSince("last-90", now)).toBe("2026-06-22T18:30:00.000Z");
});

test("all time reaches back to the epoch", () => {
  expect(periodSince("all")).toBe("1970-01-01T00:00:00.000Z");
});
