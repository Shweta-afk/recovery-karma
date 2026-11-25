/**
 * Agent presence — the real backing for "how long was this agent available, on break, offline".
 *
 * The Call Queue has had a status picker (available / break / lunch / training / offline) since
 * the beginning, but it was local React state that nothing persisted. agent-time-stats.ts then
 * invented break and idle figures with a seeded RNG because there was nothing to read.
 *
 * This writes the picker's changes to `agent_status_log` as intervals: one row per continuous
 * period in a status, closed when the agent moves to another one.
 *
 * ⚠️ FORWARD-ONLY. Nothing here can reconstruct a day that was never recorded. Any period
 * before this shipped has no rows, and callers must report that as "not recorded" rather than
 * as zero — an agent who took no breaks and an agent whose breaks were never tracked must not
 * look the same.
 */
import { supabase, getMyAgentRow } from "./supabase";
import { setQueuePresence } from "./telephony-actions.server";
import { getAccessToken } from "./access-token";
import { istDayKey } from "./monthly-trend";
import type { AgentStatus } from "./call-queue/types";

export interface StatusInterval {
  /** The key the caller asked with — the account email everywhere in the app (AgentRef.id),
   *  or agents.id (uuid). Rows are stored by uuid; see resolveAgentKeys. */
  agentId: string;
  status: AgentStatus;
  startedAt: string;
  /** Null while the agent is still in this status. */
  endedAt: string | null;
  /** Last heartbeat from the agent's app on this interval (null on rows before 2026-11-25). */
  lastSeenAt: string | null;
}

/** An open interval not heartbeated for this long means the app is gone (laptop closed, tab
 *  killed): the person is not signed in any more. The app heartbeats every minute. */
export const PRESENCE_STALE_MS = 3 * 60_000;

/** The row this tab has open, so a status change closes the right interval. */
let openIntervalId: string | null = null;

/** Closes whatever interval this tab has open. Safe to call when there is none. */
export async function closeOpenStatus(): Promise<void> {
  const id = openIntervalId;
  openIntervalId = null; // cleared first — a failed write must not leave a stale id behind
  if (!id) return;
  await supabase
    .from("agent_status_log")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", id);
}

/**
 * Record that this agent is now in `status`. Closes the previous interval first so the two
 * never overlap — overlapping intervals would double-count a day.
 *
 * Best-effort: presence is telemetry, and failing to record it must never block an agent from
 * actually changing their status in the UI.
 */
export async function setAgentStatus(status: AgentStatus): Promise<void> {
  const me = await getMyAgentRow();
  if (!me?.client_id) return;

  await closeOpenStatus();
  // Also any interval of THIS agent still open from another tab, a reload or yesterday: only the
  // tab that opened a row knew to close it, so 279 of 324 rows on 24-25 Nov were never closed and
  // stretched logged-in time to hours. One person is in one status at a time.
  await supabase
    .from("agent_status_log")
    .update({ ended_at: new Date().toISOString() })
    .eq("agent_id", me.id)
    .is("ended_at", null);
  void syncInboundQueue(status);

  const { data, error } = await supabase
    .from("agent_status_log")
    .insert({
      client_id: me.client_id,
      agent_id: me.id,
      status,
      last_seen_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    console.warn("[presence] could not record status change:", error?.message);
    return;
  }
  openIntervalId = data.id as string;
}

/**
 * Make sure this signed-in person has an open status interval, on ANY page (2026-11-25). The
 * interval used to be opened by the Call Queue page and closed when the agent left it, so a
 * signed-in agent on Debtors or History showed as Offline on Live Calls, and opening Call Queue
 * reset a break to Available. Now the agent/manager layout calls this once and then
 * touchPresence() every minute:
 *   - an open interval seen recently (this tab's reload, another tab) is adopted as it is —
 *     a break stays a break;
 *   - open intervals not seen for a while (closed laptop) are closed at their last heartbeat;
 *   - with none left open, a new "available" interval starts.
 */
export async function ensurePresence(): Promise<void> {
  const me = await getMyAgentRow();
  if (!me?.client_id) return;
  const { data } = await supabase
    .from("agent_status_log")
    .select("id, status, started_at, last_seen_at")
    .eq("agent_id", me.id)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(20);
  const open = (data ?? []) as {
    id: string;
    status: string;
    started_at: string;
    last_seen_at: string | null;
  }[];
  const now = Date.now();
  const seen = (r: (typeof open)[number]) => Date.parse(r.last_seen_at ?? r.started_at);
  const keep = open.find((r) => now - seen(r) < 10 * 60_000);
  for (const r of open) {
    if (r === keep) continue;
    await supabase
      .from("agent_status_log")
      .update({ ended_at: new Date(seen(r)).toISOString() })
      .eq("id", r.id);
  }
  if (keep) {
    openIntervalId = keep.id;
    await touchPresence();
    return;
  }
  await setAgentStatus("available");
}

/** Sign-out: close every open interval of this person. */
export async function endPresence(): Promise<void> {
  openIntervalId = null;
  const me = await getMyAgentRow();
  if (!me) return;
  await supabase
    .from("agent_status_log")
    .update({ ended_at: new Date().toISOString() })
    .eq("agent_id", me.id)
    .is("ended_at", null);
}

/** Heartbeat on this person's open interval — "still signed in". */
export async function touchPresence(): Promise<void> {
  const id = openIntervalId;
  if (!id) return;
  await supabase
    .from("agent_status_log")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", id)
    .is("ended_at", null);
}

/** Available agents take inbound calls; any other status pauses their softphone's queue. */
async function syncInboundQueue(status: AgentStatus): Promise<void> {
  try {
    await setQueuePresence({
      data: { accessToken: await getAccessToken(), available: status === "available" },
    });
  } catch (err) {
    console.warn("[presence] inbound queue update failed:", err);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * agent_status_log is keyed by agents.id (uuid), but every screen asks by account EMAIL (AgentRef.id).
 * Until 2026-11-25 the emails went straight into `.in("agent_id", …)`: Postgres rejected them for
 * the uuid column, the error was swallowed, and login / logout / break / idle showed nothing on
 * Team Activity, the agent dashboard and Reports. Returns uuid → the key the caller used.
 */
async function resolveAgentKeys(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const emails: string[] = [];
  for (const k of keys) {
    if (UUID_RE.test(k)) out.set(k, k);
    else if (k) emails.push(k);
  }
  if (emails.length) {
    const { data } = await supabase.from("agents").select("id, email").in("email", emails);
    for (const r of (data ?? []) as { id: string; email: string }[]) out.set(r.id, r.email);
  }
  return out;
}

function toIntervals(
  rows: Array<Record<string, unknown>>,
  keyOf: Map<string, string>,
): StatusInterval[] {
  return rows.map((r) => ({
    agentId: keyOf.get(String(r.agent_id)) ?? String(r.agent_id),
    status: r.status as AgentStatus,
    startedAt: String(r.started_at),
    endedAt: (r.ended_at as string | null) ?? null,
    lastSeenAt: (r.last_seen_at as string | null) ?? null,
  }));
}

/**
 * Every status interval overlapping the given IST day, for the given agents.
 *
 * Overlapping, not contained: a shift that starts at 09:00 and is still open at midnight must
 * still be counted for the day it began.
 */
export async function fetchStatusIntervals(
  agentIds: string[],
  dayKey: string,
): Promise<StatusInterval[]> {
  if (!agentIds.length) return [];
  // IST day boundaries expressed as instants. +05:30 is India's fixed offset — no DST.
  const dayStart = `${dayKey}T00:00:00+05:30`;
  const dayEnd = `${dayKey}T23:59:59.999+05:30`;

  const keyOf = await resolveAgentKeys(agentIds);
  if (!keyOf.size) return [];
  const { data, error } = await supabase
    .from("agent_status_log")
    .select("agent_id, status, started_at, ended_at, last_seen_at")
    .in("agent_id", [...keyOf.keys()])
    .lte("started_at", dayEnd)
    .or(`ended_at.is.null,ended_at.gte.${dayStart}`);

  if (error || !data) {
    if (error) console.warn("[presence] could not load status intervals:", error.message);
    return [];
  }
  return toIntervals(data, keyOf);
}

/**
 * Intervals overlapping a RANGE of IST days — the reports view, which spans more than one day.
 * Same overlap semantics as the single-day fetch.
 */
export async function fetchStatusIntervalsRange(
  agentIds: string[],
  fromDay: string,
  toDay: string,
): Promise<StatusInterval[]> {
  if (!agentIds.length) return [];
  const rangeStart = `${fromDay}T00:00:00+05:30`;
  const rangeEnd = `${toDay}T23:59:59.999+05:30`;

  const keyOf = await resolveAgentKeys(agentIds);
  if (!keyOf.size) return [];
  const { data, error } = await supabase
    .from("agent_status_log")
    .select("agent_id, status, started_at, ended_at, last_seen_at")
    .in("agent_id", [...keyOf.keys()])
    .lte("started_at", rangeEnd)
    .or(`ended_at.is.null,ended_at.gte.${rangeStart}`);

  if (error || !data) {
    if (error) console.warn("[presence] could not load status intervals:", error.message);
    return [];
  }
  return toIntervals(data, keyOf);
}

/** Did we record anything at all for this agent on this day? Distinguishes "nothing happened"
 * from "nothing was tracked", which the UI must never conflate. */
export function hasPresenceData(intervals: StatusInterval[], agentId: string): boolean {
  return intervals.some((i) => i.agentId === agentId);
}

/** Today's IST day key — the argument fetchStatusIntervals expects. */
export function todayPresenceKey(): string {
  return istDayKey(new Date().toISOString());
}
