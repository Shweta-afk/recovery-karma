// Pure call-lifecycle state machine — the single source of truth for how a call
// moves between states. Reused by the dialer engine, the simulated provider, and
// the real webhook handler so the sim path and the SIP path behave identically.
//
// PURE module: no I/O, no browser/server globals. Safe to unit-test in isolation.
import type { CallState, TerminalCallState, TelephonyEvent, CallStatus } from "./types";

const TERMINAL: ReadonlySet<CallState> = new Set<CallState>([
  "completed",
  "no_answer",
  "busy",
  "failed",
  "abandoned",
  "canceled",
]);

export function isTerminal(state: CallState): boolean {
  return TERMINAL.has(state);
}

// Allowed forward transitions. A call can be canceled/abandoned from any live state.
const NEXT: Record<CallState, readonly CallState[]> = {
  queued: ["dialing", "canceled"],
  dialing: ["ringing", "no_answer", "busy", "failed", "abandoned", "canceled"],
  ringing: ["connected", "no_answer", "busy", "failed", "abandoned", "canceled"],
  connected: ["wrapup", "completed", "failed"],
  wrapup: ["completed"],
  // terminal states have no outgoing edges
  completed: [],
  no_answer: [],
  busy: [],
  failed: [],
  abandoned: [],
  canceled: [],
};

export function canTransition(from: CallState, to: CallState): boolean {
  return NEXT[from]?.includes(to) ?? false;
}

/** Strict transition — throws on an illegal move. Use for deliberate engine moves
 * where an out-of-order transition indicates a bug. */
export function transition(from: CallState, to: CallState): CallState {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal call transition: ${from} -> ${to}`);
  }
  return to;
}

/** Lenient reducer for provider-sourced events, which can arrive out of order or
 * duplicated. Applies the event if legal, otherwise no-ops (returns current state). */
export function applyEvent(state: CallState, event: TelephonyEvent): CallState {
  switch (event.type) {
    case "ring":
      return canTransition(state, "ringing") ? "ringing" : state;
    case "answer":
      return canTransition(state, "connected") ? "connected" : state;
    case "hangup": {
      // A connected call that hangs up is "completed" regardless of the raw result;
      // a leg that never connected takes the provider's terminal result (no_answer/busy/…).
      if (state === "connected" || state === "wrapup") {
        return canTransition(state, "completed") ? "completed" : state;
      }
      return canTransition(state, event.result) ? event.result : state;
    }
    case "dtmf":
    case "recording":
    case "sms_status":
      return state; // metadata events do not change call state
  }
}

/** Map the legacy coarse CallStatus (from parseStatusWebhook) onto the lifecycle. */
export function stateFromStatus(status: CallStatus): CallState {
  switch (status) {
    case "ringing":
      return "ringing";
    case "connected":
      return "connected";
    case "no_answer":
      return "no_answer";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
  }
}
