// When a scheduled MIS email is due (pure; IST throughout — India has no DST).
import type { MisSheetKey } from "./collection-mis-email";

export interface ReportSchedule {
  id: string;
  clientId: string;
  listId: string;
  name: string;
  sheets: MisSheetKey[];
  /** "HH:MM" IST */
  sendTime: string;
  /** 0 = Sunday … 6 = Saturday */
  weekdays: number[];
  reportDay: "yesterday" | "today";
  enabled: boolean;
  /** "YYYY-MM-DD" IST day last sent */
  lastSentOn: string | null;
  lastResult: string | null;
}

/** IST calendar parts of an instant. */
export function istParts(at: Date): { day: string; time: string; weekday: number } {
  const ist = new Date(at.getTime() + 5.5 * 3600_000);
  const iso = ist.toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16), weekday: ist.getUTCDay() };
}

export function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** Due once per IST day: on a chosen weekday, at or after the send time, not already sent today.
 *  A send missed while the server was down still goes out later that same day. */
export function isDue(s: ReportSchedule, at: Date): boolean {
  if (!s.enabled || !s.sheets.length) return false;
  const { day, time, weekday } = istParts(at);
  if (!s.weekdays.includes(weekday)) return false;
  if (time < s.sendTime) return false;
  return !s.lastSentOn || s.lastSentOn < day;
}

/** The day the MIS covers for a send made at `at`. */
export function reportDayFor(s: Pick<ReportSchedule, "reportDay">, at: Date): string {
  const { day } = istParts(at);
  return s.reportDay === "yesterday" ? previousDay(day) : day;
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
