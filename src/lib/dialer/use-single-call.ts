// Drives a single agent-initiated call through the real engine machinery: a simulated
// provider emits ring → answer events, the call-machine advances the state, and each state
// maps to the coarse ActiveCall phase (ringing/connected/ended) the UI already renders.
//
// This replaces the old blind `setTimeout(() => phase = "connected", 3000)`. When a real SIP
// provider is wired, the same flow carries real ring/answer/no-answer events with no UI change.
// Manual dials use the sim's `manual` hint (always connect, no auto-hangup — the agent ends it).
//
// Supports both "local" (simulator) and "server" (real provider) modes.
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useTransition } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { applyEvent, isTerminal } from "@/lib/telephony/call-machine";
import { createSimProvider, type SimProvider } from "@/lib/telephony/sim-provider";
import type { CallState, TelephonyEvent } from "@/lib/telephony/types";
import { toCallPhase } from "./live-adapter";
import {
  startCall as serverStartCall,
  hangupCall as serverHangupCall,
  getCallStatus as serverGetCallStatus,
} from "@/lib/telephony/server";
import type { CallStatus } from "@/lib/telephony/types";
// Type-only (erased) — avoids a runtime cycle with the route module that imports this hook.
import type { ActiveCall, QueueDebtor } from "@/routes/dashboard.call-queue";

const TICK_MS = 500;
/** How often the browser asks the server what the provider last said about this call. */
const STATUS_POLL_MS = 2000;
/** tata-provider.ts's own fetchWithTimeout bounds server→Tata; this bounds browser→our
 * server, so a stall anywhere in the chain (not just at Tata) still surfaces as an error
 * instead of leaving the call stuck on "ringing" with no explanation. */
const START_CALL_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

/** The coarse provider status maps onto the call-machine's state vocabulary. */
function callStateFor(status: CallStatus): CallState {
  switch (status) {
    case "ringing":
      return "ringing";
    case "connected":
      return "connected";
    case "no_answer":
      return "no_answer";
    case "completed":
      return "completed";
    default:
      return "failed";
  }
}

export interface DialOptions {
  /** Override the agent leg (the number Tata rings first). Defaults to the signed-in agent. */
  agentPhone?: string;
  /** DID shown to the debtor as caller ID. Must be a DID on the Tata account. */
  callerId?: string;
}

export interface UseSingleCall {
  /** Begin a fresh outbound dial: rings, then connects, driven by provider events. */
  dial: (debtor: QueueDebtor, opts?: DialOptions) => void;
  /** Agent ends the call → phase "ended" (also tells the provider to drop the leg). */
  hangup: () => void;
  /** Tear down any in-flight sim/timer without touching the ActiveCall UI state. */
  reset: () => void;
}

export interface UseSingleCallArgs {
  mode?: "local" | "server";
  agentPhone?: string;
}

/** Sentinel used when the signed-in agent has no `agents.agent_phone` configured. Never a
 * real number Tata can ring — dial() refuses to place a server-mode call with this, rather
 * than silently sending a placeholder every unconfigured agent would otherwise share. */
const NO_AGENT_PHONE = "agent-self";

export function useSingleCall(
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>,
  args?: UseSingleCallArgs,
): UseSingleCall {
  const { user } = useAuth();
  const mode = args?.mode ?? "local";
  const agentPhone = args?.agentPhone ?? user?.agentPhone ?? NO_AGENT_PHONE;
  const simRef = useRef<SimProvider | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef<CallState>("queued");
  const pidRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // clearInterval only stops FUTURE ticks — it does nothing to a poll that's already mid-await
  // when hangup() fires. That poll still resolves afterward and calls setActiveCall with
  // whatever status it already had in flight, silently reasserting "connected" right after the
  // user just ended the call. Checked right after every await in the poll loop, before any
  // state update; reset() raises it, dial() lowers it for the call it's about to start.
  const stoppedRef = useRef(true);

  const reset = useCallback(() => {
    stoppedRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    unsubRef.current?.();
    unsubRef.current = null;
    simRef.current = null;
    pidRef.current = null;
    stateRef.current = "queued";
  }, []);

  const dial = useCallback(
    (debtor: QueueDebtor, opts?: DialOptions) => {
      // Use provided phone (manual dial) or fall back to auth context phone
      const phoneToUse = opts?.agentPhone ?? agentPhone;

      if (mode === "server" && phoneToUse === NO_AGENT_PHONE) {
        toast.error(
          "You don't have a phone number on file — ask an admin to set your Agent Number under Admin → Users before you can dial.",
        );
        return;
      }

      reset();

      if (mode === "server") {
        // Server mode: call real provider via server function
        stateRef.current = "dialing";
        // The caller (startCall in the route) always seeds ActiveCall before dialling, so
        // `c` is non-null here. The old fallback built a differently-shaped object that was
        // not an ActiveCall at all — leave the state alone rather than corrupt it.
        setActiveCall((c) => (c ? { ...c, phase: "ringing" } : c));

        startTransition(async () => {
          try {
            const result = await withTimeout(
              serverStartCall({
                data: {
                  callLogId: debtor.id,
                  agentNumber: phoneToUse,
                  debtorNumber: debtor.phone,
                  callerId: opts?.callerId,
                  aiScore: debtor.aiScore,
                },
              }),
              START_CALL_TIMEOUT_MS,
              "Starting the call",
            );
            pidRef.current = result.providerCallId;
            stoppedRef.current = false;
            // The provider reports progress out-of-band (webhook, or the server's fallback
            // poll of the call-records API). A single agent call belongs to no DialerRun, so
            // nothing pushes those events at this component — poll the server for the latest
            // status instead, matching on either id the provider might report back.
            timerRef.current = setInterval(async () => {
              const status = await serverGetCallStatus({
                data: { keys: [result.providerCallId, debtor.id] },
              });
              // hangup() (or a fresh dial) may have run while this request was in flight —
              // stoppedRef catches that even though clearInterval already fired, since
              // clearInterval only prevents the NEXT tick, not this one finishing late.
              if (stoppedRef.current || !status) return;
              const phase = toCallPhase(callStateFor(status.status));
              setActiveCall((c) =>
                c
                  ? {
                      ...c,
                      phase,
                      providerCallId: result.providerCallId,
                      // Keep any URL we already have: the provider publishes recordings
                      // asynchronously, so a later poll can report none.
                      recordingUrl: status.recordingUrl ?? c.recordingUrl,
                    }
                  : c,
              );
              if (status.status === "failed") {
                // Tata accepted the dial (no throw above, ref_id issued) but the call never
                // actually connected — the "200 OK, agent leg never rings" pattern: silent
                // without this, since the poll loop otherwise just reset()s with no feedback.
                toast.error(
                  "Call didn't connect — Tata accepted the request but the line never rang. Check the agent's number matches Tata SmartFlo exactly.",
                );
              }
              if (status.status !== "ringing" && status.status !== "connected") reset();
            }, STATUS_POLL_MS);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("Failed to start call:", msg);
            // The caller's own toast (e.g. "Calling X…") fires synchronously, right after
            // dial() is invoked — well before this async API call has resolved either way,
            // so it can never actually report failure. This is the ONLY place that learns
            // the real outcome, so it has to be the one to tell the agent, or a failed dial
            // silently looks identical to a successful one until the call just ends itself.
            toast.error(`Call failed to start: ${msg}`);
            // "failed" is not a CallPhase ("ringing" | "connected" | "ended") and there is
            // no errorMessage field, so the old shape left the panel stuck on a phase
            // nothing renders. End the call now that the agent has been told why.
            setActiveCall((c) => (c ? { ...c, phase: "ended" } : c));
            reset();
          }
        });
      } else {
        // Local mode: use simulator (current behavior)
        const sim = createSimProvider();
        simRef.current = sim;
        stateRef.current = "dialing";
        unsubRef.current =
          sim.subscribe?.((e: TelephonyEvent) => {
            stateRef.current = applyEvent(stateRef.current, e);
            const phase = toCallPhase(stateRef.current);
            setActiveCall((c) => (c ? { ...c, phase } : c));
            if (isTerminal(stateRef.current)) reset();
          }) ?? null;
        sim
          .startCall({
            agentNumber: phoneToUse,
            debtorNumber: debtor.phone,
            callLogId: debtor.id,
            hints: { manual: true, aiScore: debtor.aiScore },
          })
          .then(({ providerCallId }) => {
            pidRef.current = providerCallId;
          });
        timerRef.current = setInterval(
          () => simRef.current?.flushDue(Date.now()),
          TICK_MS,
        );
      }
    },
    [reset, setActiveCall, mode, agentPhone],
  );

  const hangup = useCallback(() => {
    if (!pidRef.current) return;

    if (mode === "server") {
      // Server mode: call hangup via server function
      startTransition(async () => {
        try {
          await serverHangupCall({ data: { providerCallId: pidRef.current! } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("Failed to hangup call:", msg);
        }
      });
    } else {
      // Local mode: call sim hangup
      simRef.current?.hangup(pidRef.current);
    }

    setActiveCall((c) => (c ? { ...c, phase: "ended" } : c));
    reset();
  }, [reset, setActiveCall, mode]);

  useEffect(() => () => reset(), [reset]);

  return { dial, hangup, reset };
}
