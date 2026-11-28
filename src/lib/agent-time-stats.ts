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
import { PRESENCE_STALE_MS } from "./agent-presence-constants";

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
  /** The company's fixed daily break (e.g. Axiotta 1:10–2:30 pm) as it applied to this agent:
   *  the part of that window that fell inside their day, up to now. NOT counted in logged-in,
   *  idle or break above — it is shown on its own. Null when the company has no fixed break. */
  lunchSeconds: number | null;
}

const BREAK_STATUSES: AgentStatus[] = ["break", "lunch", "training"];

/** Working hours that every figure here is measured over (user, 2026-11-27: "timing should be
 *  recorded from morning 8 to evening 8"). IST, 08:00–20:00. Time outside it — an early login, a
 *  late call, a laptop left on overnight — counts toward nothing. */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 20;

/** A company's fixed daily break, "HH:MM" IST (user, 2026-11-28: Axiotta's is 1:10–2:30 pm). It is
 *  excluded from idle and logged-in time — nobody is idle at lunch — and reported separately. */
export interface FixedBreak {
  start: string;
  end: string;
}

let fixedBreak: FixedBreak | null = null;

/** Set once when the signed-in user's company is known (auth.tsx). Module state on purpose:
 *  every screen that shows time (leaderboard, reports, agent dashboard) goes through
 *  getAgentTimeStats, and threading a parameter through all of them would miss one. */
export function setFixedBreak(b: FixedBreak | null | undefined): void {
  fixedBreak = b && /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end) ? b : null;
}
export function getFixedBreak(): FixedBreak | null {
  return fixedBreak;
}

/** The fixed break of an IST day as epoch ms [from, to], or null (none set, or end ≤ start). */
export function fixedBreakWindow(dateIso: string, b: FixedBreak | null = fixedBreak) {
  if (!b) return null;
  const from = new Date(`${dateIso}T${b.start}:00+05:30`).getTime();
  const to = new Date(`${dateIso}T${b.end}:00+05:30`).getTime();
  return to > from ? ([from, to] as [number, number]) : null;
}

/** `ranges` with the part inside `cut` removed. */
export function subtractRange(ranges: [number, number][], cut: [number, number] | null) {
  if (!cut) return ranges;
  const out: [number, number][] = [];
  for (const [s, e] of ranges) {
    if (e <= cut[0] || s >= cut[1]) out.push([s, e]);
    else {
      if (s < cut[0]) out.push([s, cut[0]]);
      if (e > cut[1]) out.push([cut[1], e]);
    }
  }
  return out;
}

/** The IST working window of a day, as epoch ms. +05:30 is fixed for India — no DST. */
export function workWindow(dateIso: string): { start: number; end: number } {
  const hh = (h: number) => String(h).padStart(2, "0");
  return {
    start: new Date(`${dateIso}T${hh(WORK_START_HOUR)}:00:00+05:30`).getTime(),
    end: new Date(`${dateIso}T${hh(WORK_END_HOUR)}:00:00+05:30`).getTime(),
  };
}

/** When an interval really ended. Never later than its last heartbeat (+ the stale allowance):
 *  on 25 Nov rows left open since September were closed with "now" as their end, and an open row
 *  whose app went away (closed laptop) would otherwise run until now. */
export function effectiveEnd(i: StatusInterval, now = Date.now()): number {
  const seen = i.lastSeenAt ? Date.parse(i.lastSeenAt) : null;
  const bound = seen != null ? seen + PRESENCE_STALE_MS : Number.POSITIVE_INFINITY;
  if (i.endedAt) return Math.min(Date.parse(i.endedAt), bound);
  return Math.min(now, bound);
}

/** The part of an interval inside [dayStart, dayEnd), as [from, to] ms, or null. */
function clip(i: StatusInterval, dayStart: number, dayEnd: number): [number, number] | null {
  const from = Math.max(Date.parse(i.startedAt), dayStart);
  const to = Math.min(effectiveEnd(i), dayEnd);
  return to > from ? [from, to] : null;
}

/** Seconds covered by a set of ranges, counting overlaps once — two tabs, or a stale row next to
 *  a live one, must not double an agent's logged-in time. */
export function unionSeconds(ranges: [number, number][]): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) curEnd = e;
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return Math.round(total / 1000);
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
      lunchSeconds: null,
    };
  }

  const online: [number, number][] = [];
  const breaks: [number, number][] = [];
  let earliest = Number.POSITIVE_INFINITY;
  let latestClosed = 0;
  let anyOpen = false;
  const now = Date.now();

  // A row carried over from an earlier day (app left open overnight keeps heartbeating) is not a
  // login (user, 2026-11-27): it counts only from the agent's first call of the day, and not at
  // all on a day with no calls. A real sign-in or status change today opens a new row anyway.
  const firstCallAt = disps.reduce((min, d) => {
    const secs = (d.durationSeconds ?? 0) + (d.ringSeconds ?? 0) + (d.wrapSeconds ?? 0);
    return Math.min(min, new Date(d.time).getTime() - secs * 1000);
  }, Number.POSITIVE_INFINITY);

  const istMidnight = new Date(`${dateIso}T00:00:00+05:30`).getTime();

  for (const i of mine) {
    let r = clip(i, dayStart, dayEnd);
    if (r && Date.parse(i.startedAt) < istMidnight) {
      const from = Math.max(r[0], firstCallAt);
      r = Number.isFinite(from) && from < r[1] ? [from, r[1]] : null;
    }
    if (!r) continue;
    if (i.status !== "offline") online.push(r);
    if (BREAK_STATUSES.includes(i.status)) breaks.push(r);

    if (i.status !== "offline" && r[0] < earliest) earliest = r[0];
    // Still signed in = open AND heartbeating; an open row whose app went away has ended.
    if (!i.endedAt && effectiveEnd(i, now) >= now) anyOpen = true;
    else latestClosed = Math.max(latestClosed, r[1]);
  }

  // The company's fixed break (Axiotta 1:10–2:30 pm) is cut out of signed-in and break time, so
  // nobody is "idle" at lunch; it is reported on its own as `lunchSeconds`. Only the part of the
  // window the agent's day actually reached counts — up to now for today.
  const lunch = fixedBreakWindow(dateIso);
  let lunchSeconds: number | null = null;
  if (lunch) {
    const lo = online.length ? Math.min(...online.map((r) => r[0])) : null;
    const hi = online.length ? Math.max(...online.map((r) => r[1])) : null;
    lunchSeconds =
      lo == null || hi == null
        ? 0
        : Math.max(0, Math.round((Math.min(lunch[1], hi, now) - Math.max(lunch[0], lo)) / 1000));
  }
  const loggedInSeconds = unionSeconds(subtractRange(online, lunch));
  const breakSeconds = Math.min(unionSeconds(subtractRange(breaks, lunch)), loggedInSeconds);

  // Calls saved during the fixed break still count toward talk/ring/wrap above, but their time is
  // not part of the (lunch-free) signed-in time, so it must not be taken off idle either.
  const outsideLunch = lunch
    ? disps.filter((d) => {
        const t = new Date(d.time).getTime();
        return t < lunch[0] || t >= lunch[1];
      })
    : disps;
  const accountedCalls = outsideLunch.reduce(
    (a, d) => a + (d.durationSeconds ?? 0) + (d.ringSeconds ?? 0) + (d.wrapSeconds ?? 0),
    0,
  );

  // Whatever is left of the logged-in day after calling, ringing, wrapping and breaks. Floored
  // at zero: clock skew between an agent's browser and the server can otherwise make the parts
  // sum to slightly more than the whole and report negative idle time.
  const accounted = accountedCalls + breakSeconds;
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
    lunchSeconds,
  };
}

/** IST day keys from `from` to `to` inclusive ("YYYY-MM-DD"). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * The same breakdown summed over a range of IST days — each day measured on its own 8 am–8 pm
 * window, then added. Login is the first day's, logout the last day's.
 */
export function getAgentTimeStatsRange(
  agentId: string,
  allDisps: DispositionRecord[],
  fromDay: string,
  toDay: string,
  intervals: StatusInterval[] = [],
): AgentTimeStats {
  const days = daysBetween(fromDay, toDay);
  const per = days.map((d) => getAgentTimeStats(agentId, allDisps, d, intervals));
  if (per.length === 1) return per[0];
  const add = (f: (s: AgentTimeStats) => number | null) => {
    const vals = per.map(f).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const tracked = per.filter((s) => s.presenceRecorded);
  return {
    agentId,
    callingSeconds: per.reduce((a, s) => a + s.callingSeconds, 0),
    ringingSeconds: add((s) => s.ringingSeconds),
    dispositionSeconds: add((s) => s.dispositionSeconds),
    breakSeconds: add((s) => s.breakSeconds),
    idleSeconds: add((s) => s.idleSeconds),
    loggedInSeconds: add((s) => s.loggedInSeconds),
    loginTime: tracked[0]?.loginTime ?? null,
    logoutTime: tracked.at(-1)?.logoutTime ?? null,
    presenceRecorded: tracked.length > 0,
    lunchSeconds: add((s) => s.lunchSeconds),
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
