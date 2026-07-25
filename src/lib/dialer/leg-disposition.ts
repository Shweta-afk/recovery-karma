// Derive a call_logs record from a terminal AI- or IVR-handled dialer leg.
//
// Agent-handled legs are NOT covered here — those are logged when the agent submits a
// disposition (disposition-store.saveDisposition). This closes the audit-trail gap for calls
// a human never touched. Pure + provider-neutral; the DB write lives in
// disposition-store.saveCallLog, invoked server-side once real (non-sim) calls run.
import type { CallRecord } from "@/lib/telephony/types";
import { isTerminal } from "@/lib/telephony/call-machine";
// Type-only (erased) — never pulls the supabase client fetch-debtors depends on.
import type { CallLogOutcome } from "@/lib/fetch-debtors";

export interface LegCallLog {
  debtorId: string;
  callType: "ai" | "ivr";
  outcome: CallLogOutcome;
  durationSeconds: number;
}

// IVR keypress conventions (shared by the sim menu and a real IVR): "1" = talk to an agent
// (the engine bridges that leg to participant "agent", so it never reaches here), "2" =
// promise to pay, "3" = request a callback.
const IVR_PTP_DIGIT = "2";
const IVR_CALLBACK_DIGIT = "3";

/** Map a terminal AI/IVR leg to a call_logs record, or null when it shouldn't be logged here:
 * agent legs (logged via a disposition), non-terminal legs, or system-terminal states
 * (failed / abandoned / canceled) that aren't a debtor-facing outcome. */
export function legToCallLog(leg: CallRecord): LegCallLog | null {
  if (leg.participant !== "ai" && leg.participant !== "ivr") return null;
  if (!isTerminal(leg.state)) return null;

  let outcome: CallLogOutcome;
  if (leg.state === "no_answer" || leg.state === "busy") {
    outcome = "no_answer";
  } else if (leg.state === "completed") {
    const dtmf = leg.dtmf ?? [];
    if (leg.participant === "ivr") {
      outcome = dtmf.includes(IVR_PTP_DIGIT)
        ? "promised"
        : dtmf.includes(IVR_CALLBACK_DIGIT)
          ? "callback"
          : "no_answer"; // IVR played but the debtor made no actionable choice
    } else {
      // AI bot completed a conversation. The sim carries no resolved outcome, so mark it for
      // human follow-up; a real AI provider supplies the actual outcome (PTP / refused / …).
      outcome = "callback";
    }
  } else {
    return null; // failed / abandoned / canceled
  }

  return {
    debtorId: leg.debtorId,
    callType: leg.participant,
    outcome,
    durationSeconds: leg.durationSeconds ?? 0,
  };
}

/** Newly-loggable AI/IVR legs not already persisted (tracked by leg id). Pure — no mutation. */
export function collectLoggableLegs(
  legs: CallRecord[],
  alreadyLogged: ReadonlySet<string>,
): { leg: CallRecord; log: LegCallLog }[] {
  const out: { leg: CallRecord; log: LegCallLog }[] = [];
  for (const leg of legs) {
    if (alreadyLogged.has(leg.id)) continue;
    const log = legToCallLog(leg);
    if (log) out.push({ leg, log });
  }
  return out;
}
