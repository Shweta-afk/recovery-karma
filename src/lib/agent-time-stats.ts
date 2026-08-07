// Per-agent time/attendance breakdown — Calling, Disposition (wrap-up), Idle, Login/Logout.
//
// Calling time is REAL: it's the sum of call_logs.duration_seconds already stored for every
// logged call (see disposition-store.ts). Everything else here — disposition/wrap time, idle
// time, login/logout — is a UI PLACEHOLDER. The schema has no presence/status history at all
// today (AgentStatus in call-queue/types.ts is local React state that's never persisted), so
// there's nothing real to read yet. This file exists so all three surfaces that show these
// numbers (agent's own dashboard, the agent-facing Team Activity page, and admin Reports) stay
// consistent with each other and are trivial to swap over once a real `agent_status_log` table
// exists — see the calculation notes below each field.
//
// Placeholder values are deterministic per (agentId, date) via a seeded RNG rather than
// Math.random(), so the same agent shows the same numbers on every render/surface within a
// day instead of jittering on each remount.
import type { DispositionRecord } from "./disposition-store";

export interface AgentTimeStats {
  agentId: string;
  /** REAL — sum of call_logs.duration_seconds for the period. */
  callingSeconds: number;
  /** PLACEHOLDER — would be disposition_submitted_at − call_ended_at per call, summed. Needs
   * a `wrap_seconds` column captured client-side at disposition-submit time. */
  dispositionSeconds: number;
  /** PLACEHOLDER — would be Σ duration of Break/Lunch/Training intervals from a status log. */
  breakSeconds: number;
  /** PLACEHOLDER — loggedInSeconds − (calling + disposition + break). Time marked "Available"
   * but not on a call or wrapping one up. */
  idleSeconds: number;
  /** PLACEHOLDER — first status-log row of the day ("login"). */
  loginTime: Date;
  /** PLACEHOLDER — last status-log row of the day, or null if still logged in ("logout"). */
  logoutTime: Date | null;
  /** PLACEHOLDER — logoutTime (or now) − loginTime. */
  loggedInSeconds: number;
  /** Always true today — flips to false per-field once agent_status_log lands. Surfaced so
   * the UI can badge these numbers as estimated rather than presenting them as live fact. */
  isEstimated: boolean;
}

// Deterministic seed from a string (agent email + date) — mulberry32, good enough for stable
// UI placeholders, not for anything security- or fairness-sensitive.
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One agent's time breakdown for a given day (defaults to today). `disps` should already be
 * filtered to that agent — pass getAgentDispositions(agentId) or a date-filtered slice of it. */
export function getAgentTimeStats(
  agentId: string,
  disps: DispositionRecord[],
  dateIso: string = todayIso(),
): AgentTimeStats {
  const callingSeconds = disps.reduce((s, d) => s + (d.durationSeconds ?? 0), 0);

  const rand = seededRandom(`${agentId}|${dateIso}`);

  // Placeholder shift start somewhere in a plausible 9:00–10:30 AM window.
  const [y, m, dd] = dateIso.split("-").map(Number);
  const loginTime = new Date(y, m - 1, dd, 9, Math.round(rand() * 90));

  const isToday = dateIso === todayIso();
  // A handful of agents are shown "still logged in" for today; every past day gets a logout.
  const stillLoggedIn = isToday && rand() < 0.35;

  const dispositionSeconds = Math.round(disps.length * (25 + rand() * 35)); // ~25–60s wrap/call
  const breakSeconds = Math.round((30 + rand() * 40) * 60); // ~30–70 min of break/lunch/training

  // Idle is whatever's left of a plausible logged-in day after calling/wrap/break — never
  // negative; a quiet day (few calls) shows more idle time, which is the honest story anyway.
  const targetLoggedInSeconds = Math.round((7.5 + rand() * 1.5) * 3600); // ~7.5–9h shift
  const idleSeconds = Math.max(
    0,
    targetLoggedInSeconds - callingSeconds - dispositionSeconds - breakSeconds,
  );
  const loggedInSeconds = callingSeconds + dispositionSeconds + breakSeconds + idleSeconds;

  const logoutTime = stillLoggedIn
    ? null
    : new Date(loginTime.getTime() + loggedInSeconds * 1000);

  return {
    agentId,
    callingSeconds,
    dispositionSeconds,
    breakSeconds,
    idleSeconds,
    loginTime,
    logoutTime,
    loggedInSeconds,
    isEstimated: true,
  };
}

/** "2h 14m" / "45m" / "32s" — compact duration formatting shared by every time-stats surface. */
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
