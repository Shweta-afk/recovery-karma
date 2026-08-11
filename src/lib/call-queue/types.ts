// Shared call-queue types + type-tied constants, extracted from dashboard.call-queue.tsx.
// Other agent/manager surfaces (manager.queue.tsx, call-session, the dialer hooks) import
// these; the route file re-exports them for backward compatibility.
import type { Debtor } from "@/lib/mock-debtors";

export const QUEUE_FILTERS = [
  "all",
  "retained",
  "callback",
  "ptp",
  "no_answer",
  "fresh",
  "escalated",
  "switch_off",
  "nc",
  "paid",
] as const;

export type QueueFilter = (typeof QUEUE_FILTERS)[number];
export type ProdFilter = "all" | "productive" | "non_productive";
export type QueueSortKey = "name" | "outstanding" | "dpd" | "aiScore" | "status" | "scheduled";
export type SortKey = "time" | "debtorName" | "duration" | "outcome";
export type SortKeyAny = QueueSortKey | SortKey;
export type SortDir = "asc" | "desc";
export type ActiveTab = "agent" | "ai";
export type CallPhase = "ringing" | "connected" | "ended";
export type CallView = "panel" | "modal" | "minimized";

export type CallOutcome =
  | "paid"
  | "promised"
  | "refused"
  | "no_answer"
  | "callback"
  | "voicemail"
  | "dispute"
  | "settlement";

export interface QueueDebtor extends Debtor {
  queueStatus: "fresh" | "callback" | "ptp" | "escalated" | "no_answer";
  scheduledAt: string;
  ptpAmount?: number;
  retained?: boolean;
  retainedFrom?: string;
  portfolioId?: string; // owning UploadedPortfolio.id — drives per-portfolio call mode
  loanReference?: string; // the CSV's own loan/account ID, for display — id is an opaque row identifier
}

export interface ActiveCall {
  debtor: QueueDebtor;
  phase: CallPhase;
  view: CallView;
  muted: boolean;
  held: boolean;
  elapsed: number; // seconds
  /** Provider's id for this call leg, needed to correlate status and recordings. */
  providerCallId?: string;
  /** Set once the provider reports a recording for this call. Providers publish it
   * asynchronously — often only at or after hangup — so it is frequently absent while
   * the call is still live. */
  recordingUrl?: string;
}

export interface DispositionForm {
  outcome: CallOutcome | "";
  /** Sub-reason for the chosen outcome, e.g. "Switched off" for no_answer — see
   * OUTCOME_REASONS in active-call.tsx. Cleared whenever outcome changes. */
  reason: string;
  ptpAmount: string;
  ptpDate: string;
  ptpTime: string;
  callbackDate: string;
  callbackTime: string;
  paidAmount: string;
  paidRef: string;
  disputeReason: string;
  settlementAmount: string;
  settlementDate: string;
  settlementWaiver: string;
  escalate: boolean;
  notes: string;
  followUpDate: string;
}

export const EMPTY_DISPOSITION: DispositionForm = {
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
};

export const OUTCOME_META: Record<CallOutcome, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-success/8 text-success/70 border-success/15" },
  promised: { label: "PTP", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
  refused: { label: "Refused", cls: "bg-destructive/8 text-destructive/70 border-destructive/15" },
  no_answer: { label: "No Answer", cls: "bg-muted text-muted-foreground border-border" },
  callback: { label: "Callback", cls: "bg-warning/8 text-warning-foreground/70 border-warning/15" },
  voicemail: { label: "Voicemail", cls: "bg-purple-500/8 text-purple-600/70 border-purple-400/15" },
  dispute: { label: "Dispute", cls: "bg-orange-500/8 text-orange-600/70 border-orange-400/15" },
  settlement: { label: "Settlement", cls: "bg-teal-500/8 text-teal-600/70 border-teal-400/15" },
};

export const AI_STATUS_META: Record<string, { label: string; dot: string; cls: string }> = {
  in_call: { label: "In Call", dot: "bg-success animate-pulse", cls: "text-success" },
  waiting: { label: "Queued", dot: "bg-warning", cls: "text-warning-foreground" },
  done: { label: "Done", dot: "bg-muted-foreground", cls: "text-muted-foreground" },
  escalated: { label: "Escalated", dot: "bg-destructive", cls: "text-destructive" },
};

export const QUEUE_STATUS_META: Record<QueueDebtor["queueStatus"], { label: string; cls: string }> =
  {
    fresh: { label: "Fresh", cls: "bg-success/8 text-success/70 border-success/15" },
    callback: {
      label: "Callback",
      cls: "bg-warning/8 text-warning-foreground/70 border-warning/15",
    },
    ptp: { label: "PTP", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
    no_answer: { label: "No Answer", cls: "bg-muted text-muted-foreground border-border" },
    escalated: {
      label: "Escalated",
      cls: "bg-destructive/8 text-destructive/70 border-destructive/15",
    },
  };

// Live calls floating panel entry
export interface LiveCallEntry {
  id: string;
  agent: string;
  debtor: string;
  loanId: string;
  status: "ringing" | "connected" | "on_hold" | "no_answer" | "done";
  duration: string;
  type: "agent" | "ai";
  incoming?: boolean; // true = another agent/AI is transferring this call to me
}

// Agent availability — lives on the call queue since this is where the agent takes calls
export type AgentStatus = "available" | "break" | "lunch" | "training" | "offline";

export const STATUS_META: Record<AgentStatus, { label: string; dot: string; txt: string }> = {
  available: { label: "Available", dot: "bg-success animate-pulse", txt: "text-success" },
  break: { label: "On Break", dot: "bg-orange-400", txt: "text-orange-500" },
  lunch: { label: "Lunch", dot: "bg-amber-400", txt: "text-amber-500" },
  training: { label: "Training", dot: "bg-blue-400", txt: "text-blue-500" },
  offline: { label: "Offline", dot: "bg-muted-foreground", txt: "text-muted-foreground" },
};

// Module-scope so they're stable across renders (used in filteredQueue's useMemo deps).
export const PRODUCTIVE_STATUSES: QueueDebtor["queueStatus"][] = ["callback", "ptp"];
export const NON_PRODUCTIVE_STATUSES: QueueDebtor["queueStatus"][] = [
  "fresh",
  "no_answer",
  "escalated",
];

export interface CallControlProps {
  call: ActiveCall;
  disposition: DispositionForm;
  onDisposition: (d: DispositionForm) => void;
  onMute: () => void;
  onHold: () => void;
  onEnd: () => void;
  onSubmit: () => void;
  onSwitchView: () => void;
  onMinimize: () => void;
  /** Adds a number the agent just learned to the debtor's file. Throws on failure (e.g.
   * duplicate) so the input can keep what was typed instead of clearing it. */
  onAddPhone: (phone: string) => Promise<void>;
  /** Places a fresh call to a specific number for the debtor already on screen. */
  onCallNumber: (phone: string) => void;
}
