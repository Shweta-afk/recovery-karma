// Maps the engine's provider-neutral domain types onto the shapes the existing call-queue
// UI already renders (LiveCallEntry, CallPhase), so the logic layer can drive the UI without
// changing any component. Pure — safe to import from client or server.
import type { CallRecord, CallState } from "@/lib/telephony/types";
import type { LiveCallEntry } from "@/routes/dashboard.call-queue";

/** Live-calls panel status from the full call lifecycle. */
function liveStatus(state: CallState): LiveCallEntry["status"] {
  switch (state) {
    case "queued":
    case "dialing":
    case "ringing":
      return "ringing";
    case "connected":
    case "wrapup":
      return "connected";
    case "no_answer":
    case "busy":
    case "failed":
      return "no_answer";
    case "completed":
    case "abandoned":
    case "canceled":
      return "done";
  }
}

function fmtDuration(rec: CallRecord, now: number): string {
  let secs = rec.durationSeconds;
  if (secs == null && rec.connectedAt)
    secs = Math.max(0, Math.round((now - rec.connectedAt) / 1000));
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One engine call leg → one LiveCallsPanel row. */
export function toLiveEntry(rec: CallRecord, now = Date.now()): LiveCallEntry {
  const agent = rec.participant === "ai" ? "AI Bot" : rec.participant === "ivr" ? "IVR" : "Agent";
  return {
    id: rec.id,
    agent,
    debtor: rec.debtorName ?? rec.phone,
    loanId: rec.debtorId,
    status: liveStatus(rec.state),
    duration: liveStatus(rec.state) === "ringing" ? "—" : fmtDuration(rec, now),
    type: rec.participant === "ai" ? "ai" : "agent",
  };
}

export function toLiveEntries(legs: CallRecord[], now = Date.now()): LiveCallEntry[] {
  return legs.map((l) => toLiveEntry(l, now));
}

/** The agent's single-call panel uses a coarse 3-phase model — map onto it. */
export function toCallPhase(state: CallState): "ringing" | "connected" | "ended" {
  switch (state) {
    case "queued":
    case "dialing":
    case "ringing":
      return "ringing";
    case "connected":
    case "wrapup":
      return "connected";
    default:
      return "ended";
  }
}
