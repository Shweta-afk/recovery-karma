/**
 * Shared "between these two dates" filtering for the list pages (Activity History, Manager
 * Activity, Call Audit, Payments, Messages, Debtors).
 *
 * Days are bucketed in **IST**, via monthly-trend.ts's `istDayKey`. That is the whole reason
 * this helper exists rather than each page comparing `Date` objects: the day rolls over at
 * **midnight IST**, so a call logged at 00:30 IST belongs to the new day. Comparing raw
 * timestamps (or going through `toISOString()`, which is UTC) puts everything before 05:30 IST
 * on the *previous* day — which silently drops calls out of a single-day filter and moves
 * activity across month boundaries on the 1st.
 *
 * A range is two "YYYY-MM-DD" strings, either of which may be empty for an open end. That
 * format sorts lexicographically, so the comparisons below are plain string compares — no
 * parsing, and no timezone re-entering through the back door.
 */
import { istDayKey } from "./monthly-trend";

export interface DateRange {
  /** "YYYY-MM-DD", or "" for "no lower bound". */
  from: string;
  /** "YYYY-MM-DD", or "" for "no upper bound". */
  to: string;
}

export const EMPTY_RANGE: DateRange = { from: "", to: "" };

export function isRangeActive(r: DateRange): boolean {
  return Boolean(r.from || r.to);
}

/** Both ends set but backwards reads as a typo mid-entry, not an empty result — swap rather
 * than showing the user a table that has silently gone blank. */
function normalize(r: DateRange): DateRange {
  if (r.from && r.to && r.from > r.to) return { from: r.to, to: r.from };
  return r;
}

/** Range test for a value that is ALREADY a "YYYY-MM-DD" IST day key (e.g. a debtor's
 * lastContacted), so it isn't put through timezone conversion a second time. */
export function inDayRange(day: string | null | undefined, range: DateRange): boolean {
  if (!isRangeActive(range)) return true;
  if (!day) return false; // undated rows can't satisfy an active filter
  const { from, to } = normalize(range);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** Is this ISO timestamp inside the range, judged by its IST calendar day? An inactive range
 * matches everything, so callers can apply it unconditionally. */
export function inDateRange(iso: string | undefined, range: DateRange): boolean {
  if (!isRangeActive(range)) return true;
  return inDayRange(istDayKey(iso), range);
}

/** Today's "YYYY-MM-DD" in IST — the max on date inputs, so no one filters into the future. */
export function todayIstKey(): string {
  return istDayKey(new Date().toISOString());
}

/** Compact human label for an active range, for chips/summaries. */
export function describeRange(range: DateRange): string {
  if (!isRangeActive(range)) return "All dates";
  const { from, to } = normalize(range);
  if (from && to) return from === to ? from : `${from} → ${to}`;
  return from ? `From ${from}` : `Until ${to}`;
}
