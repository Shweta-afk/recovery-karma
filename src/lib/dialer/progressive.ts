// Progressive Dial (2026-11-12): one borrower at a time, in queue order, on the SAME path as an
// ordinary Call click — the call screen, browser-phone auto-answer, hang-up, the do-not-call
// check and the disposition all work exactly as they do for a single call. After the agent saves
// a disposition, a short countdown dials the next borrower.
//
// It replaces the server-side dialer run for this mode, which with SkyCRM's browser phone never
// worked end to end: the phone wasn't auto-answered, a connected leg had no call screen ("Take"
// dialled the borrower again), the next number rang while the agent was still writing notes, and
// a deploy killed the run (it lived in server memory). This state lives in the browser, so a
// deploy only interrupts the call in progress; the agent presses Resume.
//
// Pure: the reducer and target planning have no React or I/O, tested in
// scripts/progressive-dial.test.ts.

/** Seconds between saving a disposition and the next call. */
export const PROGRESSIVE_GAP_SECONDS = 5;

export interface ProgressiveCandidate {
  id: string;
  phone: string;
  /** IST day key ("YYYY-MM-DD") of the last contact, or null. */
  lastContacted?: string | null;
}

export interface ProgressivePlan {
  ids: string[];
  skippedDoNotCall: number;
  skippedCalledToday: number;
}

const tenDigits = (p: string) => p.replace(/\D/g, "").slice(-10);

/** Queue order, minus numbers on the do-not-call list and borrowers already contacted today. */
export function planProgressive(
  rows: ProgressiveCandidate[],
  opts: { todayKey: string; doNotCall: Set<string> },
): ProgressivePlan {
  const ids: string[] = [];
  let skippedDoNotCall = 0;
  let skippedCalledToday = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (opts.doNotCall.has(tenDigits(r.phone))) {
      skippedDoNotCall++;
      continue;
    }
    if (r.lastContacted && r.lastContacted === opts.todayKey) {
      skippedCalledToday++;
      continue;
    }
    ids.push(r.id);
  }
  return { ids, skippedDoNotCall, skippedCalledToday };
}

export type ProgressiveStatus = "idle" | "calling" | "countdown" | "paused" | "done";

export interface ProgressiveState {
  status: ProgressiveStatus;
  ids: string[];
  /** Position of the borrower being called, or of the next one to call. */
  index: number;
  /** The borrower whose call is on screen (status "calling"). */
  current: string | null;
  /** Set when status is "countdown": when the next call starts (ms since epoch). */
  dialAt: number | null;
  /** Calls placed this session. */
  called: number;
  skipped: number;
  pauseReason: string | null;
}

export const PROGRESSIVE_IDLE: ProgressiveState = {
  status: "idle",
  ids: [],
  index: 0,
  current: null,
  dialAt: null,
  called: 0,
  skipped: 0,
  pauseReason: null,
};

export type ProgressiveAction =
  | { type: "start"; ids: string[] }
  /** The page started the call for `id`. */
  | { type: "dialed"; id: string }
  /** The agent saved a disposition for `id`. */
  | { type: "dispositioned"; id: string; now: number }
  /** The call screen closed without a disposition (refused, or closed some other way). */
  | { type: "callCleared"; id: string; reason: string }
  /** The agent started a call this session didn't place. */
  | { type: "otherCall" }
  | { type: "pause"; reason?: string }
  | { type: "resume" }
  /** Skip the rest of the countdown. */
  | { type: "callNow" }
  | { type: "skip"; now: number }
  | { type: "stop" };

function advance(s: ProgressiveState, now: number): ProgressiveState {
  const index = s.index + 1;
  if (index >= s.ids.length) return { ...s, status: "done", index, current: null, dialAt: null };
  return {
    ...s,
    status: "countdown",
    index,
    current: null,
    dialAt: now + PROGRESSIVE_GAP_SECONDS * 1000,
    pauseReason: null,
  };
}

export function progressiveReducer(s: ProgressiveState, a: ProgressiveAction): ProgressiveState {
  switch (a.type) {
    case "start":
      if (!a.ids.length) return { ...PROGRESSIVE_IDLE, status: "done" };
      // The first call goes out at once: the agent just pressed the button.
      return { ...PROGRESSIVE_IDLE, status: "countdown", ids: a.ids, dialAt: 0 };
    case "dialed":
      if (s.status !== "countdown" || s.ids[s.index] !== a.id) return s;
      return { ...s, status: "calling", current: a.id, dialAt: null, called: s.called + 1 };
    case "dispositioned":
      if (s.status !== "calling" || s.current !== a.id) return s;
      return advance(s, a.now);
    case "callCleared":
      if (s.status !== "calling" || s.current !== a.id) return s;
      // Not skipped: the reason may be company-wide (calling hours, lines busy), and moving on
      // would race through the whole list refusing every call.
      return { ...s, status: "paused", current: null, dialAt: null, pauseReason: a.reason };
    case "otherCall":
      if (s.status !== "countdown") return s;
      return { ...s, status: "paused", dialAt: null, pauseReason: "You started another call" };
    case "pause":
      if (s.status !== "countdown") return s;
      return { ...s, status: "paused", dialAt: null, pauseReason: a.reason ?? null };
    case "callNow":
      if (s.status !== "countdown") return s;
      return { ...s, dialAt: 0 };
    case "resume":
      if (s.status !== "paused") return s;
      // A call that was cleared without a disposition is retried: resuming means "carry on".
      return { ...s, status: "countdown", dialAt: 0, pauseReason: null };
    case "skip":
      if (s.status !== "countdown" && s.status !== "paused") return s;
      return advance({ ...s, skipped: s.skipped + 1 }, a.now);
    case "stop":
      return PROGRESSIVE_IDLE;
  }
}

/** The borrower the countdown is waiting to call, if it's time. */
export function dueToDial(s: ProgressiveState, now: number): string | null {
  if (s.status !== "countdown" || s.dialAt === null || now < s.dialAt) return null;
  return s.ids[s.index] ?? null;
}
