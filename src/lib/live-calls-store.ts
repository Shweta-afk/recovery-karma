/**
 * Live call state, shared across users — what every other store here is to its table.
 *
 * Two halves:
 *   - The AGENT side writes their own row as their call moves ringing -> connected -> ended,
 *     and heartbeats it while it lasts. Driven from CallSessionProvider, which already owns
 *     `activeCall` and its ticker.
 *   - The SUPERVISOR side reads every live row they are allowed to see, over Supabase
 *     Realtime, and renders the board.
 *
 * Deliberately NOT the localStorage-cache-first pattern the other stores use. A cached live
 * call is a contradiction: the entire value is that the row is true *now*, and showing a
 * stale one from localStorage on load is the exact failure this feature exists to avoid.
 */
import { supabase, getMyAgentRow } from "./supabase";
import { istDayKey } from "./monthly-trend";
import type { DialMode } from "./call-queue/types";

/** How often the owning tab refreshes last_seen_at while a call is live. */
export const HEARTBEAT_MS = 15_000;

/**
 * A row unseen for longer than this is shown as stale, not live.
 *
 * Four missed heartbeats. Generous on purpose: a backgrounded tab gets its timers throttled by
 * the browser, and marking a real call stale because the agent switched tabs is worse than
 * carrying a dead one for another half-minute.
 */
export const STALE_AFTER_MS = 60_000;

export type LivePhase = "ringing" | "connected" | "wrapup";

export interface LiveCall {
  id: string;
  agentId: string; // agents.id (uuid)
  agentName: string;
  debtorId: string | null;
  debtorName: string;
  phone: string;
  loanReference: string;
  phase: LivePhase;
  dialMode: DialMode | null;
  startedAt: string;
  lastSeenAt: string;
  /** True when the heartbeat has gone quiet — the call may already be over. */
  stale: boolean;
}

// ─── agent side: writing your own call ────────────────────────────────────────

/** The row this tab currently owns, so updates and the final stamp target the right one. */
let ownRowId: string | null = null;

export function getOwnLiveCallId(): string | null {
  return ownRowId;
}

/**
 * Announce that this agent is now on a call. Returns the row id, or null when it could not be
 * written — the caller must NOT treat that as fatal: failing to publish presence is never a
 * reason to interrupt a real call the agent is already on.
 */
export async function startLiveCall(c: {
  debtorId: string | null;
  debtorName: string;
  phone: string;
  loanReference?: string;
  phase: LivePhase;
  dialMode?: DialMode;
}): Promise<string | null> {
  const me = await getMyAgentRow();
  if (!me?.client_id) return null;

  const { data, error } = await supabase
    .from("live_calls")
    .insert({
      client_id: me.client_id,
      agent_id: me.id,
      // A synthetic `manual-<timestamp>` id is not a debtor FK — see isUuid in
      // disposition-store. An unmapped manual dial is stored with a null debtor.
      debtor_id: c.debtorId,
      phase: c.phase,
      dial_mode: c.dialMode ?? null,
      contact_name: c.debtorName || null,
      contact_phone: c.phone || null,
      loan_reference: c.loanReference || null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.warn("[live-calls] could not publish call presence:", error?.message);
    return null;
  }
  ownRowId = data.id as string;
  return ownRowId;
}

/** Move the row through the call's phases, and keep the heartbeat fresh. */
export async function updateLiveCall(phase: LivePhase): Promise<void> {
  if (!ownRowId) return;
  await supabase
    .from("live_calls")
    .update({ phase, last_seen_at: new Date().toISOString() })
    .eq("id", ownRowId);
}

/** Heartbeat only — no phase change. */
export async function touchLiveCall(): Promise<void> {
  if (!ownRowId) return;
  await supabase
    .from("live_calls")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", ownRowId);
}

/**
 * Mark this tab's call finished. Stamps `ended_at` rather than deleting, so a provider webhook
 * has a row to reconcile against later and the board can show "just ended" briefly.
 */
export async function endLiveCall(): Promise<void> {
  const id = ownRowId;
  ownRowId = null; // cleared first: a failed write must not leave the tab thinking it still owns a row
  if (!id) return;
  await supabase
    .from("live_calls")
    .update({ ended_at: new Date().toISOString(), last_seen_at: new Date().toISOString() })
    .eq("id", id);
}

// ─── supervisor side: reading everyone's ──────────────────────────────────────

function toLiveCall(
  row: Record<string, unknown>,
  nameByAgentId: Map<string, string>,
  now: number,
): LiveCall {
  const lastSeen = String(row.last_seen_at ?? "");
  return {
    id: String(row.id),
    agentId: String(row.agent_id ?? ""),
    agentName: nameByAgentId.get(String(row.agent_id ?? "")) ?? "Unknown agent",
    debtorId: (row.debtor_id as string | null) ?? null,
    debtorName: (row.contact_name as string | null) ?? "Unknown",
    phone: (row.contact_phone as string | null) ?? "",
    loanReference: (row.loan_reference as string | null) ?? "",
    phase: (row.phase as LivePhase) ?? "connected",
    dialMode: (row.dial_mode as DialMode | null) ?? null,
    startedAt: String(row.started_at ?? ""),
    lastSeenAt: lastSeen,
    stale: lastSeen ? now - new Date(lastSeen).getTime() > STALE_AFTER_MS : true,
  };
}

/**
 * Every call currently live that the viewer may see. RLS does the scoping — an agent gets only
 * their own, a manager their team's, an admin the whole client.
 */
export async function fetchLiveCalls(): Promise<LiveCall[]> {
  const [{ data: rows, error }, { data: agentRows }] = await Promise.all([
    supabase
      .from("live_calls")
      .select(
        "id, agent_id, debtor_id, contact_name, contact_phone, loan_reference, phase, dial_mode, started_at, last_seen_at",
      )
      .is("ended_at", null)
      .order("started_at", { ascending: false }),
    supabase.from("agents").select("id, name"),
  ]);
  if (error || !rows) return [];

  const nameByAgentId = new Map((agentRows ?? []).map((a) => [String(a.id), String(a.name ?? "")]));
  const now = Date.now();
  return rows.map((r) => toLiveCall(r as Record<string, unknown>, nameByAgentId, now));
}

/**
 * Realtime subscription. `onChange` fires on any insert/update/delete to live_calls the viewer
 * can see; the caller re-fetches rather than trying to patch a local list from the payload —
 * the payload has no agent name, and a re-fetch is a single cheap indexed query.
 *
 * Returns an unsubscribe function.
 */
export function subscribeLiveCalls(onChange: () => void): () => void {
  const channel = supabase
    .channel("live-calls")
    .on("postgres_changes", { event: "*", schema: "public", table: "live_calls" }, onChange)
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

/** "12:04" — start time in IST, matching every other clock in the app. */
export function liveCallStartLabel(startedAt: string): string {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return "—";
  const today = istDayKey(new Date().toISOString());
  const day = istDayKey(startedAt);
  const time = d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  // A call that started before today is itself a signal something is wrong.
  return day === today ? time : `${day} ${time}`;
}
