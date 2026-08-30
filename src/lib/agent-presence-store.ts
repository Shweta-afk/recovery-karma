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
import { istDayKey } from "./monthly-trend";
import type { AgentStatus } from "./call-queue/types";

export interface StatusInterval {
  agentId: string; // agents.id (uuid)
  status: AgentStatus;
  startedAt: string;
  /** Null while the agent is still in this status. */
  endedAt: string | null;
}

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

  const { data, error } = await supabase
    .from("agent_status_log")
    .insert({ client_id: me.client_id, agent_id: me.id, status })
    .select("id")
    .single();
  if (error || !data) {
    console.warn("[presence] could not record status change:", error?.message);
    return;
  }
  openIntervalId = data.id as string;
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

  const { data, error } = await supabase
    .from("agent_status_log")
    .select("agent_id, status, started_at, ended_at")
    .in("agent_id", agentIds)
    .lte("started_at", dayEnd)
    .or(`ended_at.is.null,ended_at.gte.${dayStart}`);

  if (error || !data) return [];
  return data.map((r) => ({
    agentId: String(r.agent_id),
    status: r.status as AgentStatus,
    startedAt: String(r.started_at),
    endedAt: (r.ended_at as string | null) ?? null,
  }));
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

  const { data, error } = await supabase
    .from("agent_status_log")
    .select("agent_id, status, started_at, ended_at")
    .in("agent_id", agentIds)
    .lte("started_at", rangeEnd)
    .or(`ended_at.is.null,ended_at.gte.${rangeStart}`);

  if (error || !data) return [];
  return data.map((r) => ({
    agentId: String(r.agent_id),
    status: r.status as AgentStatus,
    startedAt: String(r.started_at),
    endedAt: (r.ended_at as string | null) ?? null,
  }));
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
