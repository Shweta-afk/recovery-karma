// Tata Tele SmartFlo implementation of TelephonyProvider.
// Handles Click-to-Call, call hangup, and webhook parsing.
// Docs: https://docs.smartflo.tatatelebusiness.com
//
// Server-side only — never import from client code (needs TATA_ACCESS_TOKEN).

import type {
  TelephonyProvider,
  StartCallRequest,
  StartCallResult,
  SendSmsRequest,
  SendSmsResult,
  CallStatusEvent,
  CallStatus,
} from "./types";

// ─── Configuration ────────────────────────────────────────────────────────

const TATA_ACCESS_TOKEN =
  typeof process !== "undefined" ? process.env?.TATA_ACCESS_TOKEN : undefined;
const TATA_BASE_URL =
  typeof process !== "undefined"
    ? process.env?.TATA_BASE_URL ?? "https://api-smartflo.tatateleservices.com/v1"
    : "https://api-smartflo.tatateleservices.com/v1";

function requireApiKey() {
  if (!TATA_ACCESS_TOKEN) {
    throw new Error(
      "TATA_ACCESS_TOKEN is not set — get a Permanent Access Token from your Tata Tele account manager and add it to .env.local or your environment",
    );
  }
}

// ─── Headers ──────────────────────────────────────────────────────────────

function getAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TATA_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// ─── Status Mapping ───────────────────────────────────────────────────────
// Tata webhook sends coarse statuses; map them to our normalized CallStatus.

const TATA_STATUS_MAP: Record<string, CallStatus> = {
  "answered by customer": "connected",
  answered: "connected",
  missed: "no_answer",
  "no-answer": "no_answer",
  completed: "completed",
  failed: "failed",
};

// ─── Click-to-Call ────────────────────────────────────────────────────────

export const tataProvider: TelephonyProvider = {
  name: "tata",

  async startCall(req: StartCallRequest): Promise<StartCallResult> {
    requireApiKey();

    // TESTING MODE: Simulate debtor answering after 3 seconds
    // In production, use real Tata click_to_call or dialer endpoint
    const isTestMode = process.env.TATA_TEST_MODE === "true";

    if (isTestMode) {
      console.log("[tata-provider] TEST MODE: Simulating debtor call to", req.debtorNumber);
      const callId = `sim-${Date.now()}`;

      // Register with polling job for auto-answer simulation
      const { registerTestCall } = await import("./polling");
      registerTestCall(callId);

      return {
        providerCallId: callId,
      };
    }

    // Use Click-to-Call: call agent's phone → when answered, bridge to debtor
    // agent_number: the agent's actual phone (where to ring the agent)
    // destination_number: the debtor's phone (to connect after agent answers)
    const url = `${TATA_BASE_URL}/click_to_call`;
    const body = {
      agent_number: req.agentNumber, // Agent's actual phone to call
      destination_number: req.debtorNumber, // Debtor's phone to connect to
      caller_id: req.agentNumber, // Show agent's number as caller ID
      custom_identifier: req.callLogId, // Our internal call ID
      async: 1, // Non-blocking
      call_timeout: 300, // 5 minutes
    };

    try {
      console.log("[tata-provider] Calling Click-to-Call endpoint");
      console.log("[tata-provider] Calling agent at:", req.agentNumber);
      console.log("[tata-provider] Will connect to debtor:", req.debtorNumber);

      const response = await fetch(url, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      });

      console.log("[tata-provider] Click-to-Call response status:", response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[tata-provider] Click-to-Call error:", errorText);
        throw new Error(`Tata Click-to-Call failed: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as {
        success: boolean;
        ref_id?: string;
        call_id?: string;
        message?: string;
      };

      // Tata returns ref_id or call_id as the call identifier
      const callId = data.ref_id || data.call_id;
      if (!callId) {
        throw new Error(`Tata returned no call ID: ${data.message || "unknown error"}`);
      }

      return {
        providerCallId: callId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`tataProvider.startCall failed: ${msg}`);
    }
  },

  async hangup(providerCallId: string): Promise<void> {
    requireApiKey();

    const url = `${TATA_BASE_URL}/call/hangup`;
    const body = {
      call_id: providerCallId,
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`Tata hangup warning: ${response.status} ${errorText}`);
        // Don't throw — hangup is best-effort. Call may already be ended.
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`tataProvider.hangup warning: ${msg}`);
      // Best-effort — don't fail the whole operation
    }
  },

  async sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
    req; // Unused parameter
    // SMS support deferred to Phase 3 (after Click-to-Call is stable)
    throw new Error(
      "SMS not implemented yet — see Phase 3 in TATA_IMPLEMENTATION_ROADMAP.md",
    );
  },

  parseStatusWebhook(payload: unknown): CallStatusEvent {
    // Tata webhook format (from https://docs.smartflo.tatatelebusiness.com):
    //
    // Answered:
    // {
    //   "$uuid": "call-id-from-tata",
    //   "$call_status": "answered by customer",
    //   "$duration": 120,
    //   "$answer_agent_number": "050XXXXXXX0",
    //   ...other fields...
    // }
    //
    // Missed:
    // {
    //   "$uuid": "call-id-from-tata",
    //   "$call_status": "missed",
    //   "$duration": 30,
    //   "$hangup_cause": "no-answer",
    //   ...other fields...
    // }

    const p = payload as {
      $uuid?: string;
      $call_status?: string;
      $duration?: number;
      $recording_url?: string;
      $hangup_cause?: string;
      [key: string]: unknown;
    };

    if (!p.$uuid) {
      throw new Error("Invalid Tata webhook: missing $uuid");
    }

    if (!p.$call_status) {
      throw new Error("Invalid Tata webhook: missing $call_status");
    }

    const status = (TATA_STATUS_MAP[p.$call_status] ?? "failed") as CallStatus;

    return {
      providerCallId: p.$uuid,
      status,
      durationSeconds: p.$duration,
      recordingUrl: p.$recording_url, // May be undefined; recording is async in Tata
    };
  },
};

// ─── Notes ────────────────────────────────────────────────────────────────
//
// 1. Recording URLs: Tata may not include $recording_url in the webhook.
//    A follow-up query to GET /v1/call/records can backfill it (Phase 2).
//
// 2. Webhook Events: Tata only sends two events (answered / missed).
//    No "ringing" event. The dialer engine handles state transitions.
//
// 3. Custom Identifier: We use custom_identifier = callLogId so webhooks
//    can be correlated back to our internal call tracking.
//
// 4. Non-blocking Calls: async: 1 means Tata returns immediately, then
//    POSTs lifecycle events to our webhook (hybrid polling catches any misses).
//
// 5. Error Handling: hangup is best-effort (call may already be ended);
//    startCall fails hard (critical operation).
