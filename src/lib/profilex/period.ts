// The reporting windows offered on the Insights reports (admin and superadmin). Since-only on
// purpose: the report RPCs take a single `p_since`, and "last month" would need an upper bound
// they don't have. Every boundary is midnight IST, like the rest of the app's day arithmetic.

import { istMonthStart } from "./billing";

export type InsightsPeriod = "this-month" | "last-90" | "all";

export const INSIGHTS_PERIODS: { value: InsightsPeriod; label: string }[] = [
  { value: "this-month", label: "This month" },
  { value: "last-90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export const periodLabel = (p: InsightsPeriod) =>
  INSIGHTS_PERIODS.find((x) => x.value === p)?.label ?? "This month";

/** ISO timestamp the window starts at. */
export function periodSince(p: InsightsPeriod, now: Date = new Date()): string {
  if (p === "all") return new Date(0).toISOString();
  if (p === "last-90") {
    // Start of the IST day 90 days ago: shift into IST, floor to midnight, shift back.
    const IST = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + IST);
    const midnightIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
    return new Date(midnightIst - 90 * 86_400_000 - IST).toISOString();
  }
  return istMonthStart(now).toISOString();
}
