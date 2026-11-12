// Drives a Progressive Dial session (rules in progressive.ts) on top of the page's ordinary
// startCall: the page reports the disposition; this hook watches the shared call to notice a call
// that closed without one, and starts the next borrower when the countdown runs out.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  PROGRESSIVE_IDLE,
  dueToDial,
  planProgressive,
  progressiveReducer,
  toSaved,
  type ProgressivePlan,
  type SavedProgressive,
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
  /** Where the run is kept across a reload or leaving the page (one per signed-in user). Null =
   *  not kept. */
  storageKey: string | null;
  /** Borrowers by id, for a run brought back after a reload (its rows weren't kept). */
  loadTargets: (ids: string[]) => Promise<QueueDebtor[]>;
}): ProgressiveDial {
  const { activeCall, startCall, storageKey } = args;
  const [state, dispatch] = useReducer(progressiveReducer, PROGRESSIVE_IDLE);
  const loadRef = useRef(args.loadTargets);
  loadRef.current = args.loadTargets;

  // Keep the run: a manager pauses after 100 calls, goes off to use Manual Dial (not on My Queue),
  // comes back and resumes at 101 (user, 2026-11-12). Browser storage, this tab only.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) dispatch({ type: "restore", saved: JSON.parse(raw) as SavedProgressive });
    } catch {
      /* storage unavailable */
    }
  }, [storageKey]);
  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = toSaved(state);
      if (saved) sessionStorage.setItem(storageKey, JSON.stringify(saved));
      else if (state.status === "idle" || state.status === "done")
        sessionStorage.removeItem(storageKey);
    } catch {
      /* storage full or unavailable */
    }
  }, [state, storageKey]);
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
    if (!debtor) {
      // A run brought back after a reload: load the next borrowers, then this effect runs again.
      if (loading.current) return;
      loading.current = true;
      const batch = state.ids.slice(state.index, state.index + 100);
      void loadRef
        .current(batch)
        .then((rows) => {
          for (const r of rows) targets.current.set(r.id, r);
          // Gone from the queue since (paid, reassigned, closed): skip it.
          if (!rows.some((r) => r.id === id)) dispatch({ type: "skip", now: 0 });
        })
        .catch(() => dispatch({ type: "pause", reason: "Couldn't load the next borrowers" }))
        .finally(() => {
          loading.current = false;
          setNow(Date.now());
        });
      return;
    }
    dispatch({ type: "dialed", id });
    startCallRef.current(debtor);
  }, [state, now, activeCall]);
  const loading = useRef(false);

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
