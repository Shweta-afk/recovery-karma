// Lifts the agent's in-progress call out of the Call Queue page so it survives navigation.
// The page still owns queue-specific business logic (disposition submit side-effects, transfer
// handling); this provider only owns the two pieces of state that need to outlive the page:
// `activeCall` (so a minimized call bar can render at the dashboard layout level) and
// `disposition` (so notes typed before minimizing aren't lost if the agent navigates away and
// back). It also owns the elapsed-time ticker centrally so the timer keeps running regardless
// of which UI (full panel or minimized bar) is currently mounted.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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
   * Stamp the call's own timeline as it moves through its phases.
   *
   * This is what turns ring and wrap time into MEASUREMENTS. Both were previously produced by
   * a seeded RNG in agent-time-stats.ts because nothing recorded when a call was answered or
   * when it ended — the information existed only as a transient React phase and was thrown
   * away.
   *
   * Done here rather than in useSingleCall because this provider sees every call regardless of
   * which dialer path started it, and because both of that hook's modes (sim and server) reach
   * the same phases through different code.
   */
  useEffect(() => {
    const phase = activeCall?.phase;
    if (!phase) return;
    setActiveCall((c) => {
      if (!c) return c;
      if (phase === "connected" && !c.answeredAt) {
        return { ...c, answeredAt: new Date().toISOString() };
      }
      // Stamped once, so wrap time runs from when the call actually finished rather than from
      // whenever the agent got round to opening the disposition form.
      if (phase === "ended" && !c.endedAt) {
        return { ...c, endedAt: new Date().toISOString() };
      }
      return c;
    });
  }, [activeCall?.phase]);

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
