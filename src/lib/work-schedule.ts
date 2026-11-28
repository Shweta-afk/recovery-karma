// Rules for a company's shift + fixed break (Admin → Settings → Shift & break). Pure.
export interface WorkScheduleInput {
  shiftStart: string;
  shiftEnd: string;
  breakStart: string | null;
  breakEnd: string | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** null = fine; otherwise a plain-English reason to refuse the save. */
export function validateWorkSchedule(s: WorkScheduleInput): string | null {
  if (!HHMM.test(s.shiftStart) || !HHMM.test(s.shiftEnd)) return "Enter the shift as HH:MM.";
  if (s.shiftEnd <= s.shiftStart) return "The shift must end after it starts (same day).";
  const hasBreak = !!(s.breakStart || s.breakEnd);
  if (!hasBreak) return null;
  if (!s.breakStart || !s.breakEnd || !HHMM.test(s.breakStart) || !HHMM.test(s.breakEnd))
    return "Enter both break times as HH:MM, or turn the fixed break off.";
  if (s.breakEnd <= s.breakStart) return "The break must end after it starts.";
  if (s.breakStart < s.shiftStart || s.breakEnd > s.shiftEnd)
    return "The break must be inside the shift.";
  return null;
}
