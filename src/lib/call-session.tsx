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
  outcome: "", ptpAmount: "", ptpDate: "", callbackDate: "", callbackTime: "",
  paidAmount: "", paidRef: "", disputeReason: "", settlementAmount: "", settlementDate: "", settlementWaiver: "", escalate: false, notes: "", followUpDate: "",
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
      setActiveCall(c => (c && c.phase === "connected" ? { ...c, elapsed: c.elapsed + 1 } : c));
    }, 1000);
    return () => clearInterval(id);
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
