// Ozonetel KooKoo CPaaS implementation of TelephonyProvider.
// Docs: https://in1-cpaas.ozonetel.com/ — server-side only, never import this from
// client code (it needs KOOKOO_API_KEY, which must stay off the browser bundle).
import type {
  TelephonyProvider,
  StartCallRequest,
  StartCallResult,
  SendSmsRequest,
  SendSmsResult,
  CallStatusEvent,
  CallStatus,
} from "./types";

const API_KEY = process.env.KOOKOO_API_KEY;
const BASE_URL = "https://in1-cpaas.ozonetel.com/api/v1";

function requireApiKey() {
  if (!API_KEY) {
    throw new Error("KOOKOO_API_KEY is not set — sign up at ozonetel.com and add it to .env.local");
  }
}

// KooKoo's own status strings, mapped to our normalized CallStatus
const STATUS_MAP: Record<string, CallStatus> = {
  ringing: "ringing",
  answered: "connected",
  "no-answer": "no_answer",
  busy: "no_answer",
  failed: "failed",
  completed: "completed",
};

export const kookooProvider: TelephonyProvider = {
  name: "kookoo",

  async startCall(req: StartCallRequest): Promise<StartCallResult> {
    requireApiKey();
    // TODO once KOOKOO_API_KEY exists: POST {BASE_URL}/calls/click-to-call with
    // { agent_number: req.agentNumber, customer_number: req.debtorNumber,
    //   custom_field: req.callLogId, status_callback: `${APP_URL}/api/telephony/webhook` }
    // and return the provider's call id from the response body.
    throw new Error("kookooProvider.startCall is not implemented yet — see TODO above");
  },

  async sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
    requireApiKey();
    // TODO once KOOKOO_API_KEY exists: POST {BASE_URL}/sms/send with
    // { to: req.to, template_id: req.templateId, params: req.templateParams }.
    // Template must already be DLT-approved — see Ozonetel onboarding docs.
    throw new Error("kookooProvider.sendSms is not implemented yet — see TODO above");
  },

  parseStatusWebhook(payload: unknown): CallStatusEvent {
    // TODO: confirm exact webhook payload shape against KooKoo's docs/dashboard
    // once a real account exists — this shape is a placeholder.
    const p = payload as {
      call_id: string;
      status: string;
      duration?: number;
      recording_url?: string;
    };
    return {
      providerCallId: p.call_id,
      status: STATUS_MAP[p.status] ?? "failed",
      durationSeconds: p.duration,
      recordingUrl: p.recording_url,
    };
  },
};
