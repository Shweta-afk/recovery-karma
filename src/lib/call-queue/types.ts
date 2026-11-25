import type React from "react";
// Shared call-queue types + type-tied constants, extracted from dashboard.call-queue.tsx.
// Other agent/manager surfaces (manager.queue.tsx, call-session, the dialer hooks) import
// these; the route file re-exports them for backward compatibility.
import type { Debtor } from "@/lib/mock-debtors";

export const QUEUE_FILTERS = [
  "all",
  "retained",
  "callback",
  "ptp",
  "settlement",
  "no_answer",
  "fresh",
  "escalated",
  "switch_off",
  "nc",
  "paid",
  "refused",
  "dispute",
  "wrong_number",
  "deceased",
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
  | "partial_paid"
  | "promised"
  | "refused"
  | "no_answer"
  | "callback"
  | "voicemail"
  | "dispute"
  | "settlement";

/** Where an account sits in the queue, from its latest (effective) disposition. "fresh" = never
 * called (user, 2026-11-24) — every other outcome has its own status. The database's
 * debtor_list makes the same mapping; change both together. */
export type QueueStatus =
  | "fresh"
  | "callback"
  | "ptp"
  | "settlement"
  | "no_answer"
  | "paid"
  | "refused"
  | "dispute"
  | "wrong_number"
  | "deceased"
  | "escalated";

// Keyed by the stored outcome text: wrong_number / deceased / escalated are saved by the
// disposition form but aren't in this file's CallOutcome union.
const OUTCOME_QUEUE_STATUS: Record<string, QueueStatus | undefined> = {
  promised: "ptp",
  callback: "callback",
  settlement: "settlement",
  no_answer: "no_answer",
  voicemail: "no_answer",
  paid: "paid",
  partial_paid: "paid",
  refused: "refused",
  dispute: "dispute",
  wrong_number: "wrong_number",
  deceased: "deceased",
  escalated: "escalated",
};

/** Queue status for an account whose effective latest outcome is `outcome` (none = fresh). */
export function queueStatusForOutcome(outcome: string | null | undefined): QueueStatus {
  return (outcome && OUTCOME_QUEUE_STATUS[outcome]) || "fresh";
}

export interface QueueDebtor extends Debtor {
  queueStatus: QueueStatus;
  scheduledAt: string;
  ptpAmount?: number;
  retained?: boolean;
  retainedFrom?: string;
  portfolioId?: string; // owning UploadedPortfolio.id — drives per-portfolio call mode
  loanReference?: string; // the CSV's own loan/account ID, for display — id is an opaque row identifier
}

export interface ActiveCall {
  debtor: QueueDebtor;
  /** ISO instants for the call's own timeline, stamped by CallSessionProvider as the phase
   * moves. They exist so ring and wrap time can be MEASURED at disposition instead of invented
   * — see agent-time-stats.ts. Absent on a call that never left "ringing". */
  dialStartedAt?: string;
  answeredAt?: string;
  endedAt?: string;
  /** How this call was placed — set at dial time, read when the disposition is written so
   * call_logs.dial_mode reflects what the agent actually did. */
  dialMode?: DialMode;
  phase: CallPhase;
  view: CallView;
  /** While ringing: show the whole call screen (account details) instead of the slim bar. Off by
   *  default; the agent opens it with Expand (user, 2026-11-12). */
  expandRinging?: boolean;
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
  /** Loan/Account ID typed AFTER an unmapped manual call, to bind it to the right debtor on
   * save. Empty for every other call — the queue already knows whose account it is. */
  attachLoanId: string;
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
  /** Borrower asked not to be called again — adds their number to the company's do-not-call list */
  doNotCall: boolean;
  notes: string;
  followUpDate: string;
}

export const EMPTY_DISPOSITION: DispositionForm = {
  attachLoanId: "",
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
};

export const OUTCOME_META: Record<CallOutcome, { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-success/8 text-success/70 border-success/15" },
  partial_paid: {
    label: "Partially Paid",
    cls: "bg-emerald-500/8 text-emerald-700/70 border-emerald-400/15",
  },
  promised: { label: "PTP", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
  refused: { label: "Refused", cls: "bg-destructive/8 text-destructive/70 border-destructive/15" },
  no_answer: { label: "No Answer", cls: "bg-muted text-muted-foreground border-border" },
  callback: { label: "Callback", cls: "bg-warning/8 text-warning-foreground/70 border-warning/15" },
  voicemail: { label: "Voicemail", cls: "bg-purple-500/8 text-purple-600/70 border-purple-400/15" },
  dispute: { label: "Dispute", cls: "bg-orange-500/8 text-orange-600/70 border-orange-400/15" },
  settlement: { label: "Settlement", cls: "bg-teal-500/8 text-teal-600/70 border-teal-400/15" },
};

// Sub-reasons offered once an agent picks an outcome — free text on the backend
// (call_logs.outcome_reason, requires migrations/20260811_call_logs_outcome_reason.sql), this
// list is what's actually shown, not a schema-enforced enum. Keep in sync with any new
// CallOutcome — an outcome with no entry here just shows no reason dropdown at all. Shared
// between the in-call disposition form (active-call.tsx) and the Call Queue Disposition
// filter (dashboard.call-queue.tsx), which is why it lives here rather than in either.
//
// Sourced from the org's Call Disposition Matrix. The matrix's category headers map onto the
// app's existing CallOutcome values rather than becoming new outcomes of their own — that
// keeps PTP tracking / escalations / DRR, which all key off CallOutcome, working unchanged:
//   PAID → paid · CALL BACK → callback · POSITIVE POOL–PTP → promised
//   POSITIVE POOL–SETTLEMENT → settlement · NOT CONTACTED → no_answer
//   RTP → refused · DISPUTE + DISPUTE–OTHER → dispute (combined; both log the same outcome)
// "Voicemail" appears as a reason under NOT CONTACTED in the matrix, but the app also has a
// standalone `voicemail` outcome predating this matrix — left as-is, not folded in, since
// removing it would reclassify already-logged calls.
export const OUTCOME_REASONS: Record<CallOutcome, string[]> = {
  paid: [
    "Payment Collected Fully",
    "Payment Details Shared",
    "On-Call Online Payment",
    "Claim Paid",
  ],
  partial_paid: [
    "Part Payment Collected",
    "Balance Promised Later",
    "Financial Difficulty",
    "Paid What They Could",
  ],
  callback: [
    "Left Message",
    "Supervisor Follow Up",
    "Language Barrier",
    "No Payment Signals",
    "Customer Is Busy",
    "Call Back PTP",
    "Third Party Call Back",
    "Disconnected – Purpose of Call Shared Partially",
    "Disconnected – Purpose of Call Shared",
    "Call Back",
  ],
  promised: [
    "Payment Details Not Shared",
    "Payment Collected – Partially",
    "PTP",
    "Future PTP",
    "Maintain Balance",
  ],
  settlement: [
    "Settlement Instalment Follow Up",
    "CIBIL Instalment Follow Up",
    "Asset Surrender",
    "Settlement Letter Received",
    "CIBIL Letter Received",
    "Settlement Letter Awaited",
    "CIBIL Letter Awaited",
    "Settlement Request Raised",
    "CIBIL Request Raised",
    "CIBIL Proposed",
    "Settlement Proposed",
    "Positive – CIBIL Cleanup",
    "Positive – Foreclosure",
    "Positive – Settlement",
    "Already Settled",
  ],
  no_answer: [
    "Switched Off",
    "Engaged Tone",
    "Ringing",
    "Not Reachable (No Contact)",
    "Busy",
    "Waiting",
    "Out of Coverage Area",
    "Out of Service",
    "Wrong Number",
    "Not Available",
    "Does Not Exist",
    "Not in Use",
    "Voicemail",
    "Field Visit Recommended – No Contact",
    "Branch Contact",
    "Disconnected – No Info Shared",
    "Redial",
  ],
  refused: [
    "Broken Promise to Pay",
    "Pay Later – Financial Reason",
    "Pay Later – Medical Reason",
    "Unable to Pay – Financial Reason",
    "Unable to Pay – Medical Reason",
    "Intentional",
    "Field Visit Recommended – RTP",
    "Black Customer",
    "Black FE",
    "CIBIL Done",
    "Card Not Received",
    "Card Not Used",
    "Misselling – Annual Charges Were Not Informed",
    "Stop Follow Up",
    "Pay Later – Death",
    "Death in Family",
    "Customer's Demise",
    "Closed",
  ],
  voicemail: [
    "Left voicemail",
    "Mailbox full",
    "No voicemail option",
    "Auto-attendant only, no human",
  ],
  dispute: [
    "Follow Up",
    "Sales Issue – New Connection Given",
    "Sales Issue – Sold as Free Number",
    "Sales Issue – Wrong Commitment",
    "Delay in Disconnection",
    "Sales Issue – Sold as Prepaid",
    "Frequent Network Issue",
    "No Usage/Low Usage",
    "Billing Issue – IR Charges",
    "Installation Related",
    "Device Already Collected",
    "Vehicle with Third Party",
  ],
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
    settlement: {
      label: "Settlement",
      cls: "bg-teal-500/8 text-teal-600/70 border-teal-400/15",
    },
    no_answer: { label: "No Answer", cls: "bg-muted text-muted-foreground border-border" },
    paid: { label: "Paid", cls: "bg-success/10 text-success border-success/25" },
    refused: { label: "Refused", cls: "bg-rose-500/8 text-rose-600/80 border-rose-400/20" },
    dispute: { label: "Dispute", cls: "bg-purple-500/8 text-purple-600/80 border-purple-400/20" },
    wrong_number: {
      label: "Wrong Number",
      cls: "bg-zinc-500/8 text-zinc-600/80 border-zinc-400/20",
    },
    deceased: { label: "Deceased", cls: "bg-zinc-700/10 text-zinc-700 border-zinc-500/25" },
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
  phone: string;
  status: "ringing" | "connected" | "on_hold" | "no_answer" | "done";
  duration: string;
  type: "agent" | "ai";
  incoming?: boolean; // true = another agent/AI is transferring this call to me
  /** Provider's id for this leg, once startCall has resolved — needed to hang it up
   * individually (see hangupDialerLeg in telephony/server.ts). Absent while still queued. */
  providerCallId?: string;
  /** Productive Dial through the calling service's own queue: the borrower is rung first and the
   * agent's phone stays quiet until one answers. */
  vendorRouted?: boolean;
  /** The extension the calling service put this call through to (Productive Dial). */
  agentHandle?: string;
  /** Productive Dial: the borrower picked up and is waiting for a free agent since then (ms). */
  waitingSince?: number;
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
/** Productive = the borrower engaged (callback, promise, settlement, paid). */
export const PRODUCTIVE_STATUSES: QueueStatus[] = ["callback", "ptp", "settlement", "paid"];
export const NON_PRODUCTIVE_STATUSES: QueueStatus[] = [
  "fresh",
  "no_answer",
  "refused",
  "dispute",
  "wrong_number",
  "deceased",
  "escalated",
];

export interface CallControlProps {
  call: ActiveCall;
  /** Shown across the top of the full call screen — Productive Dial's "Waiting for you" list,
   *  which the call screen otherwise covers (2026-11-25: a borrower waited unseen and hung up). */
  banner?: React.ReactNode;
  disposition: DispositionForm;
  onDisposition: (d: DispositionForm) => void;
  onMute: () => void;
  onHold: () => void;
  onEnd: () => void;
  /** Saves the disposition. `override` fills fields in one click (the ringing row's "No answer
   *  — save"), since a state update made just before would not be visible yet. */
  onSubmit: (override?: Partial<DispositionForm>) => void;
  onSwitchView: () => void;
  /** Omitted where there is no floating call bar to minimise to (Manager → My Queue's own
   * calls) — the button is then hidden rather than doing nothing. */
  onMinimize?: () => void;
  /** Adds a number the agent just learned to the debtor's file. Throws on failure (e.g.
   * duplicate) so the input can keep what was typed instead of clearing it. */
  onAddPhone: (phone: string) => Promise<void>;
  /** Places a fresh call to a specific number for the debtor already on screen. */
  onCallNumber: (phone: string) => void;
  /** Opens the debtor's full profile. Omitted where the page has no profile sheet; the name is
   * then plain text. Never offered for an ad-hoc Manual Dial contact (no account behind it). */
  onOpenProfile?: () => void;
  /** Ringing call: switch between the slim bar and the full call screen. */
  onToggleRingingDetails?: () => void;
  /** The agent heard the borrower pick up: show the call as connected. SkyCRM sends no
   *  "answered" event, so without this the screen says Ringing until the call ends. */
  onMarkAnswered?: () => void;
}

/**
 * How a call was originated — stored on call_logs.dial_mode (20260827_call_logs_dial_mode.sql).
 * Distinct from `callType`, which records who HANDLED the call (human/ai/ivr/bot).
 */
export type DialMode = "manual" | "single" | "multi_line" | "sequential" | "no_call";

/**
 * ⚠️ The single place the stored dial mode is translated to what the agent sees. Keep it that
 * way — the dialer's UI labels and its internal enum are swapped from each other on purpose:
 * the button reading "Productive Dial" is internally `dialerMode: "predictive"`, and the one
 * reading "Progressive Dial" is internally `dialerMode: "productive"`. The stored values
 * deliberately use neither word, so the confusion stops at this boundary instead of spreading
 * into the database and every query written against it.
 */
export const DIAL_MODE_META: Record<DialMode, { label: string; short: string; cls: string }> = {
  manual: {
    label: "Manual Dial",
    short: "Manual",
    cls: "bg-purple-500/8 text-purple-500/80 border-purple-400/15",
  },
  single: {
    label: "Call Queue",
    short: "Queue",
    cls: "bg-muted text-muted-foreground border-border",
  },
  // Button label: "Productive Dial" (internally dialerMode "predictive") — several lines open
  // at once.
  multi_line: {
    label: "Productive Dial",
    short: "Productive",
    cls: "bg-success/8 text-success/70 border-success/15",
  },
  // Button label: "Progressive Dial" (internally dialerMode "productive") — one debtor at a
  // time, in list order.
  sequential: {
    label: "Progressive Dial",
    short: "Progressive",
    cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15",
  },
  // Not a call: the disposition was changed from the debtor profile without ringing anyone
  // (20261105_call_logs_dial_mode_no_call.sql). Logged as its own row so the earlier
  // disposition stays in the history unchanged.
  no_call: {
    label: "Updated without a call",
    short: "No call",
    cls: "bg-amber-500/8 text-amber-600/80 border-amber-400/20",
  },
};

/** Rows logged before dial_mode existed carry NULL — shown as this rather than guessed at. */
export const UNKNOWN_DIAL_MODE_LABEL = "Before tracking";

/** The internal dialerMode enum -> what actually happened on the wire. The enum's two values
 * mean the opposite of what their names suggest; see DIAL_MODE_META. */
export function dialModeFromDialerMode(mode: "predictive" | "productive"): DialMode {
  return mode === "predictive" ? "multi_line" : "sequential";
}
