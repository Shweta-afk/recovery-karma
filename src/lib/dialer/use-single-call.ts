// Drives a single agent-initiated call through the real engine machinery: a simulated
// provider emits ring → answer events, the call-machine advances the state, and each state
// maps to the coarse ActiveCall phase (ringing/connected/ended) the UI already renders.
//
// This replaces the old blind `setTimeout(() => phase = "connected", 3000)`. When a real SIP
// provider is wired, the same flow carries real ring/answer/no-answer events with no UI change.
// Manual dials use the sim's `manual` hint (always connect, no auto-hangup — the agent ends it).
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { applyEvent, isTerminal } from "@/lib/telephony/call-machine";
import { createSimProvider, type SimProvider } from "@/lib/telephony/sim-provider";
import type { CallState, TelephonyEvent } from "@/lib/telephony/types";
import { toCallPhase } from "./live-adapter";
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

export function useSingleCall(
  setActiveCall: Dispatch<SetStateAction<ActiveCall | null>>,
): UseSingleCall {
  const simRef = useRef<SimProvider | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef<CallState>("queued");
  const pidRef = useRef<string | null>(null);

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
          agentNumber: "agent-self",
          debtorNumber: debtor.phone,
          callLogId: debtor.id,
          hints: { manual: true, aiScore: debtor.aiScore },
        })
        .then(({ providerCallId }) => {
          pidRef.current = providerCallId;
        });
      timerRef.current = setInterval(() => simRef.current?.flushDue(Date.now()), TICK_MS);
    },
    [reset, setActiveCall],
  );

  const hangup = useCallback(() => {
    if (pidRef.current) simRef.current?.hangup(pidRef.current);
    setActiveCall((c) => (c ? { ...c, phase: "ended" } : c));
    reset();
  }, [reset, setActiveCall]);

  useEffect(() => () => reset(), [reset]);

  return { dial, hangup, reset };
}
