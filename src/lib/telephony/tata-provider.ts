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

/** Default caller ID (a DID assigned to the account). Tata rejects any caller_id that
 * isn't one of your DIDs with "DID Selected is either disabled or Outbound calling is
 * disabled" — so this must never be an agent's personal number. */
const TATA_CALLER_ID =
  typeof process !== "undefined" ? process.env?.TATA_CALLER_ID : undefined;

/** How long the legs ring before Tata abandons the attempt. */
const CALL_TIMEOUT_SECONDS = Number(
  (typeof process !== "undefined" ? process.env?.TATA_CALL_TIMEOUT : undefined) ?? 45,
);

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

/**
 * Find the provider's own call id for an in-flight call we know only by ref_id.
 *
 * The exact field names on /live_calls are not documented and we have not yet observed a
 * live payload, so this checks every plausible carrier of our ref_id and logs the raw entry
 * the first time it runs — one real cancellation will confirm the shape.
 */
async function resolveLiveCallId(refId: string): Promise<string | null> {
  try {
    const res = await fetch(`${TATA_BASE_URL}/live_calls`, { headers: getAuthHeaders() });
    if (!res.ok) {
      console.warn(`[tata-provider] live_calls lookup failed: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as unknown;
    const calls: Array<Record<string, unknown>> = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : (((body as { results?: unknown[]; data?: unknown[] }).results ??
          (body as { data?: unknown[] }).data ??
          []) as Array<Record<string, unknown>>);

    if (calls.length) {
      console.log("[tata-provider] live_calls sample:", JSON.stringify(calls[0]));
    }

    const match = calls.find((c) =>
      ["ref_id", "custom_identifier", "customIdentifier"].some((k) => c[k] === refId),
    );
    if (!match) return null;

    for (const k of ["call_id", "uuid", "id"]) {
      const v = match[k];
      if (typeof v === "string" && v) return v;
    }
    return null;
  } catch (err) {
    console.warn(
      "[tata-provider] live_calls lookup error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ─── Click-to-Call ────────────────────────────────────────────────────────

export const tataProvider: TelephonyProvider = {
  name: "tata",

  async startCall(req: StartCallRequest): Promise<StartCallResult> {
    requireApiKey();

    // Click-to-Call rings the agent first, then bridges the debtor in on answer.
    //   agent_number       — the Smartflo agent who receives the call
    //   destination_number — the debtor we're collecting from
    //   caller_id          — what the debtor sees. MUST be a DID on the account; passing an
    //                        agent's personal number here is what returns the 422
    //                        "DID Selected is either disabled or Outbound calling is disabled".
    // Omitting caller_id makes Tata fall back to the account's pilot number.
    const callerId = req.callerId ?? TATA_CALLER_ID;
    const url = `${TATA_BASE_URL}/click_to_call`;
    const body: Record<string, unknown> = {
      agent_number: req.agentNumber,
      destination_number: req.debtorNumber,
      custom_identifier: req.callLogId, // Our internal call ID
      async: 1, // Non-blocking
      // Ring timeout, not call duration: how long the legs ring before the attempt is
      // abandoned. 300s left a debtor's phone ringing for five minutes and kept the agent
      // pinned to a dead line; collections practice is well under a minute.
      call_timeout: CALL_TIMEOUT_SECONDS,
    };
    if (callerId) body.caller_id = callerId;

    try {
      console.log("[tata-provider] Calling Click-to-Call endpoint");
      console.log("[tata-provider] Ringing agent at:", req.agentNumber);
      console.log("[tata-provider] Will connect to debtor:", req.debtorNumber);
      console.log("[tata-provider] caller_id (DID):", callerId ?? "(pilot number)");

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

    // `providerCallId` is the ref_id click_to_call handed back, but /call/hangup rejects it:
    //   POST /call/hangup {call_id: "<ref_id>"} -> 422 {"message":"Invalid Call ID"}
    // Tata wants its OWN call id, which only comes into existence once the call is live.
    // Resolve it from /live_calls by matching on whichever field carries our ref_id.
    const liveId = await resolveLiveCallId(providerCallId);
    if (!liveId) {
      console.warn(
        `[tata-provider] hangup: no live call matching ref_id ${providerCallId} — it may have already ended`,
      );
      return;
    }

    const url = `${TATA_BASE_URL}/call/hangup`;
    const body = {
      call_id: liveId,
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
    // The dashboard's webhook body is a JSON template the user edits, e.g.
    //   { "uuid": "$uuid", "call_status": "$call_status", "duration": "$duration", ... }
    // The `$name` tokens are the VALUES Tata substitutes — the delivered keys are plain
    // (`uuid`, `call_status`). Read those; accept `$`-prefixed keys too in case a template
    // is written the other way round.
    const p = payload as Record<string, unknown>;
    const pick = <T>(...keys: string[]): T | undefined => {
      for (const k of keys) {
        const v = p[k] ?? p[`$${k}`];
        // An unsubstituted template token ("$uuid") is not a real value.
        if (v !== undefined && v !== null && v !== "" && v !== `$${k}`) return v as T;
      }
      return undefined;
    };

    // Correlation id. `custom_identifier` echoes back the callLogId we sent, which is the
    // only id we can match without knowing whether Tata's uuid equals click_to_call's ref_id.
    const customIdentifier = pick<string>("custom_identifier");
    // ref_id FIRST: click_to_call returns a ref_id at dial time and that is what we stored as
    // providerCallId. The webhook body carries uuid AND ref_id, and they are different values
    // — reading uuid first correlates against an id we never recorded, silently dropping the
    // event. Same ordering as convertTataRecordToEvent in polling.ts.
    const providerCallId = pick<string>("ref_id", "uuid", "call_id");
    if (!providerCallId && !customIdentifier) {
      throw new Error("Invalid Tata webhook: no uuid/call_id/custom_identifier to correlate on");
    }

    const rawStatus = pick<string>("call_status");
    if (!rawStatus) throw new Error("Invalid Tata webhook: missing call_status");

    const duration = pick<string | number>("duration", "billsec");

    return {
      providerCallId: providerCallId ?? customIdentifier!,
      customIdentifier,
      status: TATA_STATUS_MAP[rawStatus.toLowerCase()] ?? ("failed" as CallStatus),
      durationSeconds: duration === undefined ? undefined : Number(duration) || 0,
      recordingUrl: pick<string>("recording_url"),
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
