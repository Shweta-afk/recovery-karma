// Lifts the agent's in-progress call out of the Call Queue page so it survives navigation.
// The page still owns queue-specific business logic (disposition submit side-effects, transfer
// handling); this provider only owns the two pieces of state that need to outlive the page:
// `activeCall` (so a minimized call bar can render at the dashboard layout level) and
// `disposition` (so notes typed before minimizing aren't lost if the agent navigates away and
// back). It also owns the elapsed-time ticker centrally so the timer keeps running regardless
// of which UI (full panel or minimized bar) is currently mounted.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  HEARTBEAT_MS,
  endLiveCall,
  startLiveCall,
  touchLiveCall,
  updateLiveCall,
} from "./live-calls-store";
import { isUuid } from "./disposition-store";
// Type-only import — erased at compile time, so this does not create a runtime circular
// dependency with the route file (which imports `useCallSession` from this module).
import type { ActiveCall, DispositionForm } from "@/routes/dashboard.call-queue";

// Mirrors EMPTY_DISPOSITION in dashboard.call-queue.tsx — kept as a local literal (rather than
// a value import from the route file) to avoid a runtime circular import.
const EMPTY_DISPOSITION: DispositionForm = {
  outcome: "",
  reason: "",
  ptpAmount: "",
  ptpDate: "",
  ptpTime: "",
  callbackDate: "",
  callbackTime: "",
  paidAmount: "",
  paidRef: "",
  disputeReason: "",
  settlementAmount: "",
  settlementDate: "",
  settlementWaiver: "",
  escalate: false,
  notes: "",
  followUpDate: "",
  attachLoanId: "",
};

interface CallSessionCtx {
  activeCall: ActiveCall | null;
  setActiveCall: React.Dispatch<React.SetStateAction<ActiveCall | null>>;
  disposition: DispositionForm;
  setDisposition: React.Dispatch<React.SetStateAction<DispositionForm>>;
}

const Ctx = createContext<CallSessionCtx | null>(null);

export function CallSessionProvider({ children }: { children: ReactNode }) {
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [disposition, setDisposition] = useState<DispositionForm>(EMPTY_DISPOSITION);

  // Single source of truth for the live-call timer so it keeps ticking whether the full call
  // panel, the minimized bar, or neither is currently on screen.
  useEffect(() => {
    if (!activeCall || activeCall.phase !== "connected") return;
    const id = setInterval(() => {
      setActiveCall((c) => (c && c.phase === "connected" ? { ...c, elapsed: c.elapsed + 1 } : c));
    }, 1000);
    return () => clearInterval(id);
    // Intentionally keyed only on phase: the interval uses a functional update, so it never
    // reads a stale activeCall. Depending on `activeCall` would tear down/recreate it every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCall?.phase]);

  /**
   * Publish this agent's call to `live_calls` so managers and admins can see it.
   *
   * Done HERE, not in useSingleCall, because this provider is the one place that sees every
   * call regardless of where it was started — the queue, the PTP tracker, a dialer leg, or the
   * Manual Dial dock all funnel through `activeCall`.
   *
   * ⚠️ Known gap: manager.queue.tsx keeps its OWN activeCall useState instead of using this
   * context, so a call a manager places from My Queue is not published. Same root cause as the
   * dock/dialer clash fixed on 2026-08-27. Worth unifying, but that is a bigger refactor than
   * this feature.
   *
   * Every write is best-effort. Failing to publish presence must never interrupt a real call
   * the agent is already on, so nothing here throws or blocks.
   */
  const publishedPhase = useRef<string | null>(null);
  useEffect(() => {
    const phase = activeCall?.phase;

    // Call over (or gone) — stamp it ended and stop.
    if (!activeCall || phase === "ended") {
      if (publishedPhase.current) {
        publishedPhase.current = null;
        void endLiveCall();
      }
      return;
    }

    const livePhase = phase === "ringing" ? "ringing" : "connected";

    if (!publishedPhase.current) {
      publishedPhase.current = livePhase;
      void startLiveCall({
        // A synthetic `manual-<timestamp>` id is not a real debtor FK.
        debtorId: isUuid(activeCall.debtor.id) ? activeCall.debtor.id : null,
        debtorName: activeCall.debtor.name,
        phone: activeCall.debtor.phone,
        loanReference: activeCall.debtor.loanReference,
        phase: livePhase,
        dialMode: activeCall.dialMode,
      });
    } else if (publishedPhase.current !== livePhase) {
      publishedPhase.current = livePhase;
      void updateLiveCall(livePhase);
    }
  }, [activeCall]);

  // Heartbeat. A row that stops being touched is shown as stale rather than live — see
  // STALE_AFTER_MS. This is what stops a crashed tab leaving a call on the board forever.
  useEffect(() => {
    if (!activeCall || activeCall.phase === "ended") return;
    const id = setInterval(() => void touchLiveCall(), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [activeCall?.phase, activeCall]);

  // Best-effort close on tab/window teardown. Not reliable (the browser may kill the tab before
  // the request leaves), which is exactly why the heartbeat above exists as the real defence.
  useEffect(() => {
    const bye = () => void endLiveCall();
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, []);

  return (
    <Ctx.Provider value={{ activeCall, setActiveCall, disposition, setDisposition }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCallSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCallSession must be used within CallSessionProvider");
  return ctx;
}
