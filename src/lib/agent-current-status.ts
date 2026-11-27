// What status an agent is in RIGHT NOW, from today's agent_status_log intervals. Shared by the
// Live Calls "everyone today" table and Reports → By Team, so both say the same thing.
//
// The open interval with a recent heartbeat is the answer. An open interval nobody has
// heartbeated for PRESENCE_STALE_MS is a closed laptop, not a signed-in agent (the same rule
// "Agents right now" uses) — that agent is "not signed in".
import type { AgentStatus } from "./call-queue/types";
import { PRESENCE_STALE_MS } from "./agent-presence-constants";
import type { StatusInterval } from "./agent-presence-store";

export interface CurrentStatus {
  status: AgentStatus;
  /** Epoch ms the agent entered this status. */
  since: number;
}

/** The agent's current status, or null when they aren't signed in (no open interval, offline,
 *  or the app stopped heartbeating). */
export function currentStatusOf(
  intervals: StatusInterval[],
  agentId: string,
  nowMs: number = Date.now(),
): CurrentStatus | null {
  let best: CurrentStatus | null = null;
  for (const i of intervals) {
    if (i.agentId !== agentId || i.endedAt) continue;
    const startedAt = Date.parse(i.startedAt);
    const seenAt = Date.parse(i.lastSeenAt ?? i.startedAt);
    if (nowMs - seenAt > PRESENCE_STALE_MS) continue;
    if (i.status === "offline") continue;
    if (!best || startedAt > best.since) best = { status: i.status, since: startedAt };
  }
  return best;
}

/** Break, lunch and training all count as "on a break" — the same set agent-time-stats uses. */
export function isOnBreak(s: CurrentStatus | null): boolean {
  return !!s && s.status !== "available";
}

const LABEL: Record<AgentStatus, string> = {
  available: "Available",
  break: "On break",
  lunch: "On lunch",
  training: "In training",
  offline: "Not signed in",
};

export function statusLabel(s: CurrentStatus | null): string {
  return s ? LABEL[s.status] : LABEL.offline;
}
