/**
 * DRR maths.
 *
 * The cases that matter are the ones where a naive implementation quietly lies: the last day
 * of the month (divisor must not hit zero), a target already met (zero, not negative), and no
 * target at all (null, not zero — "done" and "undefined" must not render the same).
 */
import { expect, test } from "bun:test";
import { computeDrr, monthDays } from "../src/lib/daily-run-rate";

// Midday UTC keeps these unambiguous once converted to IST (+05:30).
const at = (iso: string) => new Date(iso);

test("month days: mid-month, today still counts as collectable", () => {
  const m = monthDays(at("2026-08-22T06:00:00Z"));
  expect(m.month).toBe(8);
  expect(m.today).toBe(22);
  expect(m.total).toBe(31);
  expect(m.elapsed).toBe(21);
  expect(m.remaining).toBe(10); // 22nd..31st inclusive
});

test("month days: last day of month leaves one day, never zero", () => {
  expect(monthDays(at("2026-08-31T06:00:00Z")).remaining).toBe(1);
});

test("month days: short months are real, not assumed 30", () => {
  expect(monthDays(at("2026-02-10T06:00:00Z")).total).toBe(28);
  expect(monthDays(at("2026-09-10T06:00:00Z")).total).toBe(30);
});

test("month days: rolls at midnight IST, not UTC", () => {
  // 20:00 UTC on the 31st is already 01:30 IST on the 1st — a new month.
  const m = monthDays(at("2026-08-31T20:00:00Z"));
  expect(m.month).toBe(9);
  expect(m.today).toBe(1);
});

test("DRR is the remaining ask spread over the days left", () => {
  // 100k target, 40k collected, 10 days left -> 6k/day.
  const r = computeDrr(100_000, 40_000, at("2026-08-22T06:00:00Z"));
  expect(r.shortfall).toBe(60_000);
  expect(r.daysRemaining).toBe(10);
  expect(r.drr).toBe(6_000);
  expect(r.met).toBe(false);
});

test("DRR rises as the month runs out on an unchanged shortfall", () => {
  const early = computeDrr(100_000, 40_000, at("2026-08-05T06:00:00Z"));
  const late = computeDrr(100_000, 40_000, at("2026-08-28T06:00:00Z"));
  expect(late.drr!).toBeGreaterThan(early.drr!);
});

test("target met reports zero, never a negative", () => {
  const r = computeDrr(100_000, 120_000, at("2026-08-22T06:00:00Z"));
  expect(r.shortfall).toBe(0);
  expect(r.drr).toBe(0);
  expect(r.met).toBe(true);
});

test("no target reports null, which is NOT zero", () => {
  const r = computeDrr(0, 40_000, at("2026-08-22T06:00:00Z"));
  expect(r.drr).toBeNull();
  expect(r.baseline).toBeNull();
  expect(r.met).toBe(false); // no target cannot be 'met'
});

test("baseline is the flat pace the month opened with", () => {
  // 310k over a 31-day month = 10k/day, regardless of where we are now.
  const r = computeDrr(310_000, 200_000, at("2026-08-22T06:00:00Z"));
  expect(r.baseline).toBe(10_000);
});
