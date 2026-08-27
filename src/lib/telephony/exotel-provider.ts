// Exotel implementation of TelephonyProvider (voice + SMS), plus a WhatsApp sender that
// sits alongside the interface (WhatsApp isn't part of TelephonyProvider — see sendWhatsApp
// at the bottom, consumed by messages-store.ts instead of the dialer).
// Docs: https://developer.exotel.com/docs/voice-api/getting-started/overview,
//       https://developer.exotel.com/docs/sms-api/overview,
//       https://developer.exotel.com/docs/whatsapp-api/overview
//
// Server-side only — never import from client code (needs EXOTEL_API_KEY/TOKEN).
//
// NOT YET FULLY VERIFIED AGAINST A LIVE ACCOUNT: written from Exotel's public docs. Every
// vendor integrated here so far has had at least one live-account gotcha that its docs didn't
// mention (a hangup endpoint needing a different id than the one startCall returns, wrong
// field ordering on webhook correlation, etc.) — expect similar surprises here, especially
// around `hangup`, which Exotel's docs never actually document (see below).

import type {
  TelephonyProvider,
  StartCallRequest,
  StartCallResult,
  SendSmsRequest,
  SendSmsResult,
  CallStatusEvent,
  CallStatus,
} from "./types";

// ─── Configuration ──────────────────────────────────────────────────────────

const env = (key: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[key] : undefined;

const EXOTEL_SID = env("EXOTEL_SID");
const EXOTEL_API_KEY = env("EXOTEL_API_KEY");
const EXOTEL_API_TOKEN = env("EXOTEL_API_TOKEN");
/** "api.exotel.com" (Singapore) or "api.in.exotel.com" (Mumbai) — pick whichever region
 * your Exotel account was provisioned in; it's shown on the account dashboard. */
const EXOTEL_SUBDOMAIN = env("EXOTEL_SUBDOMAIN") ?? "api.in.exotel.com";
/** Virtual number shown to the debtor. Falls back to whatever the account's
 * default is if omitted — this must be a number Exotel has assigned to the account, not an
 * agent's personal number. */
const EXOTEL_CALLER_ID = env("EXOTEL_CALLER_ID");

function baseUrl(): string {
  return `https://${EXOTEL_SUBDOMAIN}/v1/Accounts/${EXOTEL_SID}`;
}

function requireCredentials() {
  if (!EXOTEL_SID || !EXOTEL_API_KEY || !EXOTEL_API_TOKEN) {
    // Reachable from an agent's toast when a call is attempted with no credentials, so it
    // names the env vars (which an operator needs) without naming the vendor to the agent.
    throw new Error(
      "Telephony is not configured — TELEPHONY_SID / TELEPHONY_API_KEY / TELEPHONY_API_TOKEN " +
        "(EXOTEL_* aliases) are unset. Ask your platform team to add them to the environment.",
    );
  }
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}`).toString("base64")}`;
}

// ─── Status mapping ─────────────────────────────────────────────────────────
// Exotel's own call states: queued, ringing, in-progress, completed, failed, busy, no-answer.

const EXOTEL_STATUS_MAP: Record<string, CallStatus> = {
  queued: "ringing",
  ringing: "ringing",
  "in-progress": "connected",
  completed: "completed",
  failed: "failed",
  busy: "no_answer",
  "no-answer": "no_answer",
};

// ─── Voice: Connect Two Numbers (click-to-call) ────────────────────────────

export const exotelProvider: TelephonyProvider = {
  name: "exotel",

  async startCall(req: StartCallRequest): Promise<StartCallResult> {
    requireCredentials();

    // Connect rings `From` (the agent) first, then bridges `To` (the debtor) once the
    // agent picks up.
    const callerId = req.callerId ?? EXOTEL_CALLER_ID;
    const body = new URLSearchParams({
      From: req.agentNumber,
      To: req.debtorNumber,
      CustomField: req.callLogId,
    });
    if (callerId) body.set("CallerId", callerId);

    try {
      const response = await fetch(`${baseUrl()}/Calls/connect.json`, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Call could not be placed (${response.status}): ${text}`);
      }

      const data = JSON.parse(text) as { Call?: { Sid?: string }; Sid?: string };
      const callId = data.Call?.Sid ?? data.Sid;
      if (!callId) {
        throw new Error(`Telephony provider returned no call id: ${text}`);
      }

      return { providerCallId: callId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not start the call: ${msg}`);
    }
  },

  async hangup(providerCallId: string): Promise<void> {
    requireCredentials();

    // UNCONFIRMED: Exotel's public docs describe no endpoint for terminating a live call
    // (the Voice API reference lists only "Make a Call" and "Call Details" — see the
    // module comment above). This POSTs Status=completed to the call resource, mirroring
    // the Twilio-style convention Exotel's API is modeled on, but it has never been
    // verified against a real account. Confirm against the actual dashboard/API reference
    // once a real hangup has been tested against the live account.
    try {
      const response = await fetch(`${baseUrl()}/Calls/${providerCallId}.json`, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Status: "completed" }),
      });

      const text = await response.text();
      if (!response.ok) {
        console.warn(`[exotel-provider] hangup warning: ${response.status} ${text}`);
        // Best-effort — don't fail the whole operation, call may already have ended.
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`exotelProvider.hangup warning: ${msg}`);
    }
  },

  // ─── SMS ──────────────────────────────────────────────────────────────────

  async sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
    requireCredentials();

    // India requires a DLT-registered entity + template. `req.templateId` doubles as the
    // DLT template id; the actual message text still has to match the approved template's
    // wording exactly (DLT is enforced on content, not just an id), so `templateParams` are
    // interpolated into that wording by whatever calls sendSms — this function only sends
    // whatever ends up in `Body`. See SendSmsRequest's doc comment in ./types.ts.
    const body = new URLSearchParams({
      To: req.to,
      Body: req.templateParams.join(" "),
      DltTemplateId: req.templateId,
    });
    if (EXOTEL_CALLER_ID) body.set("From", EXOTEL_CALLER_ID);

    try {
      const response = await fetch(`${baseUrl()}/Sms/send.json`, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(`SMS could not be sent (${response.status}): ${text}`);
      }

      const data = JSON.parse(text) as { SMSMessage?: { Sid?: string }; Sid?: string };
      const messageId = data.SMSMessage?.Sid ?? data.Sid;
      if (!messageId) {
        throw new Error(`Telephony provider returned no SMS id: ${text}`);
      }

      return { providerMessageId: messageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not send the SMS: ${msg}`);
    }
  },

  // ─── Status callback ──────────────────────────────────────────────────────

  parseStatusWebhook(payload: unknown): CallStatusEvent {
    // Exotel's StatusCallback currently only fires on the terminal event (no separate
    // ringing/answered callbacks).
    const p = payload as Record<string, unknown>;
    const pick = <T>(...keys: string[]): T | undefined => {
      for (const k of keys) {
        const v = p[k];
        if (v !== undefined && v !== null && v !== "") return v as T;
      }
      return undefined;
    };

    const providerCallId = pick<string>("CallSid");
    const customIdentifier = pick<string>("CustomField");
    if (!providerCallId && !customIdentifier) {
      throw new Error("Invalid telephony webhook: no call id to correlate on");
    }

    const rawStatus = pick<string>("Status");
    if (!rawStatus) throw new Error("Invalid telephony webhook: missing status");

    const duration = pick<string | number>("Duration", "ConversationDuration");

    return {
      providerCallId: providerCallId ?? customIdentifier!,
      customIdentifier,
      status: EXOTEL_STATUS_MAP[rawStatus.toLowerCase()] ?? ("failed" as CallStatus),
      durationSeconds: duration === undefined ? undefined : Number(duration) || 0,
      recordingUrl: pick<string>("RecordingUrl"),
    };
  },
};

// ─── WhatsApp ───────────────────────────────────────────────────────────────
// Not part of TelephonyProvider (voice + SMS only) — messages-store.ts calls this directly
// for the "whatsapp" channel via the server function in ./server.ts.

export interface SendWhatsAppRequest {
  to: string;
  /** Must exactly match a Meta-approved template name on this WhatsApp Business Account —
   * free-form text cannot be business-initiated outside a customer's 24h session window.
   * The labels in dashboard.messages.tsx's WA_TEMPLATES are UI copy only; get each one
   * approved in Meta Business Manager (via Exotel) and use the approved name here. */
  templateName: string;
  /** Values filled into the template's numbered placeholders ({{1}}, {{2}}, ...), in order. */
  templateParams: string[];
}

export interface SendWhatsAppResult {
  providerMessageId: string;
}

export async function sendWhatsApp(req: SendWhatsAppRequest): Promise<SendWhatsAppResult> {
  requireCredentials();

  // UNCONFIRMED against a real account — Exotel's WhatsApp API overview describes the
  // endpoint and template-based shape (see module docs link above) but not the full request
  // schema. This follows the documented "To" + template name + positional components shape;
  // confirm exact field names against the WhatsApp API reference once credentials exist.
  const payload = {
    custom_channel_id: env("EXOTEL_WHATSAPP_CHANNEL_ID"),
    to: req.to,
    whatsapp: {
      messages: [
        {
          from: EXOTEL_CALLER_ID,
          content: {
            type: "template",
            template: {
              name: req.templateName,
              language: { policy: "deterministic", code: "en" },
              components: [
                {
                  type: "body",
                  parameters: req.templateParams.map((text) => ({ type: "text", text })),
                },
              ],
            },
          },
        },
      ],
    },
  };

  try {
    const response = await fetch(`https://${EXOTEL_SUBDOMAIN}/v2/accounts/${EXOTEL_SID}/messages`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`WhatsApp message could not be sent (${response.status}): ${text}`);
    }

    const data = JSON.parse(text) as { sid?: string; id?: string };
    const messageId = data.sid ?? data.id;
    if (!messageId) {
      throw new Error(`Telephony provider returned no WhatsApp message id: ${text}`);
    }

    return { providerMessageId: messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not send the WhatsApp message: ${msg}`);
  }
}
