// Date ranges for the superadmin portal. Every page uses the one shared DateRangeFilter
// (components/date-range-filter.tsx, the same control admins use) over "YYYY-MM-DD" IST days;
// this module turns those days into the instants servers query with, and offers presets.
//
// Day boundaries are midnight IST, like everywhere else in the app (CLAUDE.md "Dates").

import { todayIstKey, type DateRange } from "./date-filter";

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight IST at the start of an IST day, as a UTC instant. */
export function istDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

/** "YYYY-MM-DD" IST day `n` days before/after `day`. */
export function shiftDay(day: string, n: number): string {
  // Noon UTC keeps the arithmetic clear of any day-boundary edge.
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const isDayKey = (s: string) => DAY_RE.test(s) && !Number.isNaN(istDayStart(s).getTime());

export type RangePreset = "7d" | "30d" | "90d" | "this-month" | "last-month";

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
];

export function presetRange(p: RangePreset, today: string = todayIstKey()): DateRange {
  switch (p) {
    case "7d":
      return { from: shiftDay(today, -6), to: today };
    case "30d":
      return { from: shiftDay(today, -29), to: today };
    case "90d":
      return { from: shiftDay(today, -89), to: today };
    case "this-month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last-month": {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = shiftDay(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
  }
}

export const DEFAULT_RANGE_PRESET: RangePreset = "30d";

/** Which preset (if any) the range currently equals — highlights the preset chip. */
export function matchingPreset(r: DateRange, today: string = todayIstKey()): RangePreset | null {
  for (const { value } of RANGE_PRESETS) {
    const p = presetRange(value, today);
    if (p.from === r.from && p.to === r.to) return value;
  }
  return null;
}

/** A bounded range for reports that need one (usage, revenue): fills a missing end with today
 *  and a missing start with 30 days before the end; swaps a backwards range. */
export function boundedRange(r: DateRange, today: string = todayIstKey()): DateRange {
  let to = r.to && isDayKey(r.to) ? r.to : today;
  let from = r.from && isDayKey(r.from) ? r.from : shiftDay(to, -29);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

/** Number of IST days the range covers, inclusive. */
export function rangeDays(r: DateRange): number {
  return Math.round((istDayStart(r.to).getTime() - istDayStart(r.from).getTime()) / DAY_MS) + 1;
}

/** Half-open instants [since, until) for a bounded range — `until` is midnight IST after `to`. */
export function rangeInstants(r: DateRange): { since: string; until: string } {
  return {
    since: istDayStart(r.from).toISOString(),
    until: istDayStart(shiftDay(r.to, 1)).toISOString(),
  };
}

/** Instants for an OPTIONAL range (list pages): an unset end means unbounded on that side. */
export function openRangeInstants(r: DateRange): { since?: string; until?: string } {
  const out: { since?: string; until?: string } = {};
  let { from, to } = r;
  if (from && to && from > to) [from, to] = [to, from];
  if (from && isDayKey(from)) out.since = istDayStart(from).toISOString();
  if (to && isDayKey(to)) out.until = istDayStart(shiftDay(to, 1)).toISOString();
  return out;
}

/** The equally long range immediately before `r` — what "vs previous period" compares with. */
export function previousRange(r: DateRange): DateRange {
  const n = rangeDays(r);
  return { from: shiftDay(r.from, -n), to: shiftDay(r.from, -1) };
}

/** "1 Oct – 9 Oct 2026" style label. */
export function rangeLabel(r: DateRange): string {
  const fmt = (d: string, withYear: boolean) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  if (r.from === r.to) return fmt(r.from, true);
  return `${fmt(r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} – ${fmt(r.to, true)}`;
}
