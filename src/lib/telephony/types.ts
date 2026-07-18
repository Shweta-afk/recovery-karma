// Provider-agnostic contract for voice calls, SMS, and IVR status callbacks.
// Call queue UI code should depend only on this interface, never on a specific
// vendor SDK — see [name].ts in this folder for concrete implementations.

export interface StartCallRequest {
  /** Agent's registered number/extension to bridge the call to */
  agentNumber: string;
  /** Debtor's phone number to dial out to */
  debtorNumber: string;
  /** Our internal call_logs row id, so the webhook can report status against it */
  callLogId: string;
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

export type CallStatus = "ringing" | "connected" | "no_answer" | "failed" | "completed";

export interface CallStatusEvent {
  providerCallId: string;
  status: CallStatus;
  /** Seconds, only present once the call has ended */
  durationSeconds?: number;
  /** Playable/downloadable recording URL, only present once the call has ended */
  recordingUrl?: string;
}

export interface TelephonyProvider {
  name: string;
  startCall(req: StartCallRequest): Promise<StartCallResult>;
  sendSms(req: SendSmsRequest): Promise<SendSmsResult>;
  /** Parses a provider's raw webhook payload into our normalized shape */
  parseStatusWebhook(payload: unknown): CallStatusEvent;
}
