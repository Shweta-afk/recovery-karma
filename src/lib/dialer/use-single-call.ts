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
import { startCall as serverStartCall, hangupCall as serverHangupCall } from "@/lib/telephony/server";
// Type-only (erased) — avoids a runtime cycle with the route module that imports this hook.
import type { ActiveCall, QueueDebtor } from "@/routes/dashboard.call-queue";

const TICK_MS = 500;

export interface UseSingleCall {
  /** Begin a fresh outbound dial: rings, then connects, driven by provider events. */
  dial: (debtor: QueueDebtor) => void;
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
    (debtor: QueueDebtor) => {
      reset();

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
              callLogId: debtor.id,
              agentNumber: agentPhone,
              debtorNumber: debtor.phone,
              aiScore: debtor.aiScore,
            });
            pidRef.current = result.providerCallId;
            // Server-side provider will send webhook → ingestProviderWebhook → state updates
            // Webhook events flow back via polling or direct event stream
            // For now, UI shows ringing until webhook arrives
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
            agentNumber: agentPhone,
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
          await serverHangupCall({ providerCallId: pidRef.current! });
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
