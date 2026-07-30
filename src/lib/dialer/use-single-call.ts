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

export function useSingleCall(
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>,
  args?: UseSingleCallArgs,
): UseSingleCall {
  const { user } = useAuth();
  const mode = args?.mode ?? "local";
  const agentPhone = args?.agentPhone ?? user?.agentPhone ?? "agent-self";
  const simRef = useRef<SimProvider | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef<CallState>("queued");
  const pidRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const reset = useCallback(() => {
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
      reset();
      // Use provided phone (manual dial) or fall back to auth context phone
      const phoneToUse = opts?.agentPhone ?? agentPhone;

      if (mode === "server") {
        // Server mode: call real provider via server function
        stateRef.current = "dialing";
        setActiveCall((c) =>
          c
            ? { ...c, phase: "ringing" }
            : {
                id: debtor.id,
                debtorName: debtor.name,
                phase: "ringing",
                durationSeconds: 0,
              },
        );

        startTransition(async () => {
          try {
            const result = await serverStartCall({
              data: {
                callLogId: debtor.id,
                agentNumber: phoneToUse,
                debtorNumber: debtor.phone,
                callerId: opts?.callerId,
                aiScore: debtor.aiScore,
              },
            });
            pidRef.current = result.providerCallId;
            // The provider reports progress out-of-band (webhook, or the server's fallback
            // poll of the call-records API). A single agent call belongs to no DialerRun, so
            // nothing pushes those events at this component — poll the server for the latest
            // status instead, matching on either id the provider might report back.
            timerRef.current = setInterval(async () => {
              const status = await serverGetCallStatus({
                data: { keys: [result.providerCallId, debtor.id] },
              });
              if (!status) return;
              const phase = toCallPhase(callStateFor(status.status));
              setActiveCall((c) => (c ? { ...c, phase } : c));
              if (status.status !== "ringing" && status.status !== "connected") reset();
            }, STATUS_POLL_MS);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("Failed to start call:", msg);
            setActiveCall((c) =>
              c ? { ...c, phase: "failed", errorMessage: msg } : c,
            );
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
