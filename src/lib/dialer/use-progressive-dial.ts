// Drives a Progressive Dial session (rules in progressive.ts) on top of the page's ordinary
// startCall: the page reports the disposition; this hook watches the shared call to notice a call
// that closed without one, and starts the next borrower when the countdown runs out.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  PROGRESSIVE_IDLE,
  dueToDial,
  planProgressive,
  progressiveReducer,
  type ProgressivePlan,
} from "./progressive";
import type { ActiveCall, QueueDebtor } from "@/lib/call-queue/types";

export interface ProgressiveDial {
  state: ReturnType<typeof progressiveReducer>;
  active: boolean;
  /** Borrower by id (names for the strip). */
  target: (id: string | null | undefined) => QueueDebtor | undefined;
  /** Seconds left on the countdown, or null. */
  secondsLeft: number | null;
  start: (
    rows: QueueDebtor[],
    opts: { todayKey: string; doNotCall: Set<string> },
  ) => ProgressivePlan;
  /** Call from the page's disposition save, before it clears the call. */
  dispositioned: (debtorId: string) => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  callNow: () => void;
  stop: () => void;
}

export function useProgressiveDial(args: {
  activeCall: ActiveCall | null;
  startCall: (debtor: QueueDebtor) => void;
}): ProgressiveDial {
  const { activeCall, startCall } = args;
  const [state, dispatch] = useReducer(progressiveReducer, PROGRESSIVE_IDLE);
  const targets = useRef(new Map<string, QueueDebtor>());
  const [now, setNow] = useState(() => Date.now());
  const startCallRef = useRef(startCall);
  startCallRef.current = startCall;

  // Tick only while counting down.
  useEffect(() => {
    if (state.status !== "countdown") return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [state.status, state.dialAt]);

  // A call on screen during the countdown is one the agent started themselves: pause rather than
  // dial over it.
  useEffect(() => {
    if (state.status === "countdown" && activeCall) dispatch({ type: "otherCall" });
  }, [state.status, activeCall]);

  // The session's call closed without a disposition (refused: do-not-call, calling hours, lines
  // busy; or closed some other way). A saved disposition moves the state on first, in the same
  // render as the call clearing, so this only sees the other cases.
  const prevCallId = useRef<string | null>(null);
  useEffect(() => {
    const id = activeCall?.debtor.id ?? null;
    if (
      state.status === "calling" &&
      !id &&
      prevCallId.current === state.current &&
      state.current
    ) {
      dispatch({
        type: "callCleared",
        id: state.current,
        reason: "The last call didn't go through — check the message, then Resume or Skip",
      });
    }
    prevCallId.current = id;
  }, [activeCall, state.status, state.current]);

  // Countdown over: place the next call.
  useEffect(() => {
    const id = dueToDial(state, now);
    if (!id || activeCall) return;
    const debtor = targets.current.get(id);
    if (!debtor) return;
    dispatch({ type: "dialed", id });
    startCallRef.current(debtor);
  }, [state, now, activeCall]);

  const start = useCallback(
    (rows: QueueDebtor[], opts: { todayKey: string; doNotCall: Set<string> }) => {
      const plan = planProgressive(
        rows.map((r) => ({ id: r.id, phone: r.phone, lastContacted: r.lastContacted })),
        opts,
      );
      targets.current = new Map(rows.map((r) => [r.id, r]));
      dispatch({ type: "start", ids: plan.ids });
      setNow(Date.now());
      return plan;
    },
    [],
  );

  return {
    state,
    active: state.status !== "idle" && state.status !== "done",
    target: (id) => (id ? targets.current.get(id) : undefined),
    secondsLeft:
      state.status === "countdown" && state.dialAt !== null
        ? Math.max(0, Math.ceil((state.dialAt - now) / 1000))
        : null,
    start,
    dispositioned: (debtorId) => dispatch({ type: "dispositioned", id: debtorId, now: Date.now() }),
    pause: () => dispatch({ type: "pause" }),
    resume: () => dispatch({ type: "resume" }),
    skip: () => dispatch({ type: "skip", now: Date.now() }),
    callNow: () => dispatch({ type: "callNow" }),
    stop: () => dispatch({ type: "stop" }),
  };
}
