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
import { getAccessToken } from "./access-token";
import { hangupCall as serverHangupCall } from "./telephony/server";
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
  doNotCall: false,
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

  /**
   * Every call opens with a blank disposition. Call Queue's own startCall cleared it, but the
   * Manual Dial dock did not, so the outcome, PTP and notes from the agent's previous call were
   * still filled in on the next one (2026-11-05). Cleared here, keyed on the call itself, so
   * every way of starting a call gets it. Earlier dispositions are shown read-only under
   * "Previous notes & call history" on the call screen instead.
   */
  const callKey = activeCall ? `${activeCall.debtor.id}|${activeCall.dialStartedAt ?? ""}` : "";
  useEffect(() => {
    setDisposition(EMPTY_DISPOSITION);
  }, [callKey]);

  /**
   * The browser phone's call ended — the borrower hung up, or the agent pressed End on the phone
   * pill. The agent's half of the call is gone, so the call is over: end it on screen (the
   * disposition opens) and ask SkyCRM to drop the borrower's leg too, so they are not left on an
   * open line. Best-effort; a call already down is fine.
   */
  const activeCallRef = useRef(activeCall);
  activeCallRef.current = activeCall;
  useEffect(() => {
    const onPhoneEnded = () => {
      const c = activeCallRef.current;
      if (!c || c.phase === "ended") return;
      if (c.providerCallId) {
        const id = c.providerCallId;
        void (async () => {
          try {
            await serverHangupCall({
              data: { accessToken: await getAccessToken(), providerCallId: id },
            });
          } catch (err) {
            console.warn("[call-session] hangup after phone ended:", err);
          }
        })();
      }
      setActiveCall((cur) => (cur && cur.phase !== "ended" ? { ...cur, phase: "ended" } : cur));
    };
    window.addEventListener("samvadx:phone-call-ended", onPhoneEnded);
    return () => window.removeEventListener("samvadx:phone-call-ended", onPhoneEnded);
  }, []);

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
  // Keyed on whether a call is live, NOT on the activeCall object: that object is replaced every
  // second (elapsed ticker) and every status poll, and each replacement restarted this 15 s
  // interval before it ever fired. No heartbeat was ever sent mid-call, so every call over a
  // minute showed as "No update from this agent's app" and hid its Listen/Whisper/Barge buttons
  // (found 2026-11-05).
  const callLive = !!activeCall && activeCall.phase !== "ended";
  useEffect(() => {
    if (!callLive) return;
    const id = setInterval(() => void touchLiveCall(), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [callLive]);

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
