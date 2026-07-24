// Provider-agnostic contract for voice calls, SMS, and IVR status callbacks.
// Call queue UI code should depend only on this interface, never on a specific
// vendor SDK — see [name].ts in this folder for concrete implementations.
//
// This module is PURE: no browser globals, no Supabase/app-store imports. It must
// run unchanged on the server (Nitro) and inside the simulated provider, so keep
// it free of anything that couples it to the client bundle or the database layer.

// ─── Single-call + SMS request/result (unchanged public surface) ──────────────

export interface StartCallRequest {
  /** Agent's registered number/extension to bridge the call to */
  agentNumber: string;
  /** Debtor's phone number to dial out to */
  debtorNumber: string;
  /** Our internal call_logs row id, so the webhook can report status against it */
  callLogId: string;
  /** Optional advisory metadata. Real providers ignore this; the simulated provider uses
   * it to emulate a realistic outcome (answer likelihood, whether an IVR menu is played). */
  hints?: {
    /** Debtor AI score 1-10 — biases the simulated answer probability */
    aiScore?: number;
    bestContactTime?: "morning" | "afternoon" | "evening" | "any";
    /** True when the portfolio plays an IVR menu (ivr_agent / hybrid) — sim emits a keypress */
    ivr?: boolean;
  };
}

export interface StartCallResult {
  /** Provider's own identifier for this call leg, needed to correlate webhooks */
  providerCallId: string;
}

export interface SendSmsRequest {
  to: string;
  /** DLT-approved template id (India requires pre-registered templates) */
  templateId: string;
  /** Values to interpolate into the approved template, in order */
  templateParams: string[];
}

export interface SendSmsResult {
  providerMessageId: string;
}

/** Legacy coarse status used by parseStatusWebhook. Mapped to CallState at the boundary. */
export type CallStatus = "ringing" | "connected" | "no_answer" | "failed" | "completed";

export interface CallStatusEvent {
  providerCallId: string;
  status: CallStatus;
  /** Seconds, only present once the call has ended */
  durationSeconds?: number;
  /** Playable/downloadable recording URL, only present once the call has ended */
  recordingUrl?: string;
}

// ─── Domain model: call lifecycle, participants, channels ─────────────────────

/** Full call lifecycle. Non-terminal: queued/dialing/ringing/connected/wrapup.
 * Terminal: everything in TerminalCallState. Transitions are enforced by call-machine.ts. */
export type CallState =
  | "queued"
  | "dialing"
  | "ringing"
  | "connected"
  | "wrapup"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "abandoned"
  | "canceled";

export type TerminalCallState =
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "abandoned"
  | "canceled";

/** Who is on our side of the call once it connects. Drives mode routing in the engine. */
export type CallParticipant = "agent" | "ai" | "ivr";
export type CallChannel = "voice" | "sms";
export type CallDirection = "outbound" | "inbound";

export type SmsStatus = "queued" | "sent" | "delivered" | "read" | "failed";

/** One outbound/inbound call leg tracked by the engine. Provider-neutral: the pure
 * telephony layer knows call STATES, not app disposition outcomes — the state→outcome
 * mapping (e.g. no_answer → "no_answer" disposition) happens at the persistence boundary. */
export interface CallRecord {
  /** Our call id — reused as the call_logs row id when a disposition is persisted */
  id: string;
  debtorId: string;
  debtorName?: string;
  phone: string;
  portfolioId?: string;
  /** Agent email; set once the call is routed to a human */
  agentId?: string;
  direction: CallDirection;
  participant: CallParticipant;
  /** Correlates provider webhooks/events back to this record */
  providerCallId?: string;
  state: CallState;
  /** 1-based; increments each time the debtor is re-churned */
  attempt: number;
  queuedAt: number;
  ringingAt?: number;
  connectedAt?: number;
  endedAt?: number;
  durationSeconds?: number;
  recordingUrl?: string;
  /** Captured keypresses (IVR / hybrid) */
  dtmf?: string[];
}

// ─── Normalized event stream ──────────────────────────────────────────────────
// Both the simulated provider and the real webhook handler produce this exact
// shape, so the state-machine / persistence path is identical for sim and SIP.

export type TelephonyEvent =
  | { type: "ring"; providerCallId: string; at: number }
  | { type: "answer"; providerCallId: string; at: number }
  | { type: "dtmf"; providerCallId: string; at: number; digit: string }
  | { type: "recording"; providerCallId: string; at: number; recordingUrl: string }
  | {
      type: "hangup";
      providerCallId: string;
      at: number;
      result: TerminalCallState;
      durationSeconds: number;
    }
  | { type: "sms_status"; providerMessageId: string; at: number; status: SmsStatus };

export type TelephonyEventListener = (event: TelephonyEvent) => void;

// ─── Provider interface ───────────────────────────────────────────────────────

export interface TelephonyProvider {
  name: string;
  startCall(req: StartCallRequest): Promise<StartCallResult>;
  /** End a live/ringing leg (agent hangup, abandon, or manual stop) */
  hangup(providerCallId: string): Promise<void>;
  sendSms(req: SendSmsRequest): Promise<SendSmsResult>;
  /** Parses a provider's raw webhook payload into our normalized coarse shape */
  parseStatusWebhook(payload: unknown): CallStatusEvent;
  /** Push-based event seam. The simulated provider drives events through here; real
   * providers deliver events via parseStatusWebhook + a realtime broadcast instead,
   * so this is optional. Returns an unsubscribe function. */
  subscribe?(listener: TelephonyEventListener): () => void;
}
