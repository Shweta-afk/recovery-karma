// Per-agent time breakdown — Calling, Ringing, Wrap, Break, Idle, Login/Logout.
//
// ── This file used to make its numbers up ─────────────────────────────────────────────────
// Until 2026-08-30 only `callingSeconds` was real. Ringing, wrap, break, idle and the
// login/logout clock were produced by a seeded RNG (stable per agent+day, which made them look
// convincingly like data) because the schema recorded none of it. Those figures appear on the
// agent dashboard, Team Activity and the Reports "Time & Effort" report — places where people
// judge how someone spent their working day.
//
// They are now MEASURED:
//   callingSeconds      Σ call_logs.duration_seconds        (always was real)
//   ringingSeconds      Σ call_logs.ring_seconds            (dialer, 20260830 migration)
//   dispositionSeconds  Σ call_logs.wrap_seconds            (disposition submit)
//   break / idle / login / logout   from agent_status_log   (the status picker, now persisted)
//
// ── Null means NOT RECORDED, and must never be rendered as zero ───────────────────────────
// Tracking is forward-only: nothing can reconstruct a day that predates the migration, and an
// agent who took no breaks must not look identical to one whose breaks were never tracked.
// Every field that can be unknown is `number | null`, and `presenceRecorded` says whether the
// day was tracked at all. Rendering null as "—" is the point of the type.
import type { DispositionRecord } from "./disposition-store";
import type { AgentStatus } from "./call-queue/types";
import type { StatusInterval } from "./agent-presence-store";

export interface AgentTimeStats {
  agentId: string;
  /** REAL — Σ call_logs.duration_seconds. Never null; a day with no calls is genuinely 0. */
  callingSeconds: number;
  /** Σ ring_seconds. Null when no call in the period carries one (all pre-migration). */
  ringingSeconds: number | null;
  /** Σ wrap_seconds — call end to disposition submit. */
  dispositionSeconds: number | null;
  /** Break + lunch + training, from agent_status_log. Null when the day was not tracked. */
  breakSeconds: number | null;
  /** Logged-in time not spent calling, ringing, wrapping or on break. Null when untracked. */
  idleSeconds: number | null;
  /** First non-offline interval of the day. */
  loginTime: Date | null;
  /** End of the last closed interval, or null when the agent is still logged in. */
  logoutTime: Date | null;
  /** Total non-offline time. Null when the day was not tracked. */
  loggedInSeconds: number | null;
  /** False when agent_status_log has nothing for this agent on this day. */
  presenceRecorded: boolean;
}

const BREAK_STATUSES: AgentStatus[] = ["break", "lunch", "training"];

/** Working hours that every figure here is measured over (user, 2026-11-27: "timing should be
 *  recorded from morning 8 to evening 8"). IST, 08:00–20:00. Time outside it — an early login, a
 *  late call, a laptop left on overnight — counts toward nothing. */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 20;

/** The IST working window of a day, as epoch ms. +05:30 is fixed for India — no DST. */
export function workWindow(dateIso: string): { start: number; end: number } {
  const hh = (h: number) => String(h).padStart(2, "0");
  return {
    start: new Date(`${dateIso}T${hh(WORK_START_HOUR)}:00:00+05:30`).getTime(),
    end: new Date(`${dateIso}T${hh(WORK_END_HOUR)}:00:00+05:30`).getTime(),
  };
}

/** Overlap in seconds between an interval and the IST day, so a shift spanning midnight is
 * counted against each day only for the part that fell in it. */
function secondsInDay(interval: StatusInterval, dayStart: number, dayEnd: number): number {
  const from = Math.max(new Date(interval.startedAt).getTime(), dayStart);
  // An interval still open is counted up to now, never to the end of the day — an agent who
  // is 20 minutes into their shift has not been available for 14 hours.
  const rawEnd = interval.endedAt ? new Date(interval.endedAt).getTime() : Date.now();
  const to = Math.min(rawEnd, dayEnd);
  return to > from ? Math.round((to - from) / 1000) : 0;
}

/**
 * One agent's time breakdown for a day.
 *
 * `allDisps` should already be that agent's, filtered to the day. `intervals` come from
 * fetchStatusIntervals; pass an empty array when presence has not been loaded, and every
 * presence-derived field comes back null rather than fabricated.
 */
export function getAgentTimeStats(
  agentId: string,
  allDisps: DispositionRecord[],
  dateIso: string,
  intervals: StatusInterval[] = [],
): AgentTimeStats {
  // Only calls made inside the working window count (a call's time = its disposition time).
  const { start: dayStart, end: dayEnd } = workWindow(dateIso);
  const disps = allDisps.filter((d) => {
    const t = new Date(d.time).getTime();
    return t >= dayStart && t < dayEnd;
  });
  const callingSeconds = disps.reduce((s, d) => s + (d.durationSeconds ?? 0), 0);

  // Summed only over calls that actually carry the field. `null` when none do, so a period of
  // pre-migration calls reports "not recorded" instead of a confident 0.
  const withRing = disps.filter((d) => d.ringSeconds != null);
  const withWrap = disps.filter((d) => d.wrapSeconds != null);
  const ringingSeconds = withRing.length
    ? withRing.reduce((s, d) => s + (d.ringSeconds ?? 0), 0)
    : null;
  const dispositionSeconds = withWrap.length
    ? withWrap.reduce((s, d) => s + (d.wrapSeconds ?? 0), 0)
    : null;

  const mine = intervals.filter((i) => i.agentId === agentId);
  const presenceRecorded = mine.length > 0;

  if (!presenceRecorded) {
    return {
      agentId,
      callingSeconds,
      ringingSeconds,
      dispositionSeconds,
      breakSeconds: null,
      idleSeconds: null,
      loginTime: null,
      logoutTime: null,
      loggedInSeconds: null,
      presenceRecorded: false,
    };
  }

  let loggedInSeconds = 0;
  let breakSeconds = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latestClosed = 0;
  let anyOpen = false;

  for (const i of mine) {
    const secs = secondsInDay(i, dayStart, dayEnd);
    if (i.status !== "offline") loggedInSeconds += secs;
    if (BREAK_STATUSES.includes(i.status)) breakSeconds += secs;

    // Login/logout are shown within the working window too, and only for time that overlapped it.
    if (secs <= 0) continue;
    const startedAt = Math.max(new Date(i.startedAt).getTime(), dayStart);
    if (i.status !== "offline" && startedAt < earliest) earliest = startedAt;
    if (i.endedAt)
      latestClosed = Math.max(latestClosed, Math.min(new Date(i.endedAt).getTime(), dayEnd));
    else anyOpen = true;
  }

  // Whatever is left of the logged-in day after calling, ringing, wrapping and breaks. Floored
  // at zero: clock skew between an agent's browser and the server can otherwise make the parts
  // sum to slightly more than the whole and report negative idle time.
  const accounted =
    callingSeconds + (ringingSeconds ?? 0) + (dispositionSeconds ?? 0) + breakSeconds;
  const idleSeconds = Math.max(0, loggedInSeconds - accounted);

  return {
    agentId,
    callingSeconds,
    ringingSeconds,
    dispositionSeconds,
    breakSeconds,
    idleSeconds,
    loginTime: Number.isFinite(earliest) ? new Date(earliest) : null,
    logoutTime: anyOpen || !latestClosed ? null : new Date(latestClosed),
    loggedInSeconds,
    presenceRecorded: true,
  };
}

export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatClockTime(d: Date): string {
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

/**
 * Today's date as the agent should see it, in IST.
 *
 * Both call-queue surfaces used to print the literal string "30 Jun 2026" — not a stale
 * default that happened to be wrong, an actual hardcoded date sitting on screen above a live
 * queue. IST rather than the browser's zone for the same reason the trend buckets are: the
 * floor works Indian hours, and between 00:00 and 05:30 IST a UTC-derived date reads as
 * yesterday.
 */
export function formatISTDate(d: Date = new Date()): string {
  return d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** A duration as a % of the agent's logged-in day — the fill for a progress-bar row. Zero when
 * the day was not tracked, since there is no denominator to be a percentage of. */
export function pctOfShift(seconds: number | null, stats: AgentTimeStats): number {
  if (seconds == null || !stats.loggedInSeconds) return 0;
  return Math.round((seconds / stats.loggedInSeconds) * 100);
}

/** Durations that may be unknown render as an em dash, never as "0m". */
export function formatDurationOrDash(seconds: number | null): string {
  return seconds == null ? "—" : formatDuration(seconds);
}
