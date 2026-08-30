// SkyCRM-ACD implementation of TelephonyProvider (voice + inbound queue control).
// Vendor: Intellect Info Trade, "SKYCRM - ACD (Auto Call Dialer)", API spec v1.2.
// Docs: SKYCRM_API_Ver1.2 PDF (not public). Base host: https://vs.skycrm.app
//
// Server-side only — never import from client code (needs SKYCRM_SECRET / SKYCRM_USER / PASS).
//
// ─── SCAFFOLD, NOT WIRED ──────────────────────────────────────────────────────
// This is the POC adapter agreed with the vendor: we drive their existing REST APIs (the
// "build your own telephony layer" phase) while agents run a SIP softphone (X-Lite / Zoiper)
// for AUDIO only. WebRTC / browser-only calling is a LATER phase the vendor unlocks after this
// POC — when it lands, only the audio endpoint changes (softphone → browser webphone); this
// call-control surface stays. Do NOT assume this is verified against the live account yet: it
// is written from the v1.2 spec + a read-only probe of vs.skycrm.app on 2026-08-26. Every
// vendor integrated here has had at least one live-account gotcha its docs didn't mention.
//
// ─── Two things about this vendor that differ from Exotel ──────────────────────
// 1. AUTH is a per-request HS256 JWT (not Basic auth). The token is minted from a shared
//    SECRET_KEY + a payload of {username, password, extension, exp}. Because `extension` is
//    baked into the token and each agent has a different extension (8006, 8009, ...), a token
//    is minted PER CALL for the target extension — there is no single long-lived token.
//    Confirmed against the live host: the correct secret is `!@82Sa)-P2b33#2,saL` (the leading
//    space shown in the PDF is formatting, not part of the key).
// 2. CORRELATION is awkward. `dialing_phone` returns only a success message — NO vendor call
//    id. The vendor `callid` (e.g. "1725258585.139609") only appears asynchronously, via the
//    `dial_response` poll or the webhook's Outbound-Call event, and it is NOT correlated to the
//    `per_id` we sent. Meanwhile `hangup_phone` keys off phone_number+extension+per_id, NOT the
//    callid. So our own `per_id` (== our call_logs row id) is the only handle we control at
//    dial time. See `pendingCalls` below and the caveats on startCall/hangup/parseStatusWebhook.

import { createHmac } from "node:crypto";
import type {
  TelephonyProvider,
  StartCallRequest,
  StartCallResult,
  SendSmsRequest,
  SendSmsResult,
  CallStatusEvent,
  CallStatus,
} from "./types";

// ─── Configuration ────────────────────────────────────────────────────────────

const env = (key: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[key] : undefined;

const SKYCRM_BASE_URL = env("SKYCRM_BASE_URL") ?? "https://vs.skycrm.app";
/** HS256 signing secret from the vendor. The v1.2 PDF renders it with a leading space inside
 * the quotes — that space is NOT part of the key (verified against the live host). */
const SKYCRM_SECRET = env("SKYCRM_SECRET");
/** Service-account username/password the vendor issues. Same credentials work in both CRMs
 * per the spec's Login-api note. */
const SKYCRM_USER = env("SKYCRM_USER");
const SKYCRM_PASS = env("SKYCRM_PASS");
/** Dialing prefix the vendor assigns (spec example: 24). Prepended by their switch, passed
 * through on dialing_phone / hangup_phone. */
const SKYCRM_PREFIX = env("SKYCRM_PREFIX") ?? "";
/** Seconds a minted token stays valid. Short-lived; a fresh token is minted per request. */
const TOKEN_TTL_SECONDS = 3600;

function requireCredentials() {
  if (!SKYCRM_SECRET || !SKYCRM_USER || !SKYCRM_PASS) {
    // Surfaced to an agent's toast on a failed call — names the env vars an operator needs
    // without naming the vendor to the agent (see CLAUDE.md: keep the vendor name out of the UI).
    throw new Error(
      "Telephony is not configured — SKYCRM_SECRET / SKYCRM_USER / SKYCRM_PASS are unset. " +
        "Ask your platform team to add them to the environment.",
    );
  }
}

// ─── Auth: HS256 JWT ────────────────────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint an HS256 JWT for `extension`, signed with SKYCRM_SECRET. Payload matches the vendor's
 * Login-api schema: {username, password, extension, exp}. Called per request because the target
 * extension varies by agent. */
function mintToken(extension: string): string {
  requireCredentials();
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      username: SKYCRM_USER,
      password: SKYCRM_PASS,
      extension,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    }),
  );
  const signature = b64url(createHmac("sha256", SKYCRM_SECRET as string).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

// ─── Shared POST helper ─────────────────────────────────────────────────────────
// All non-login endpoints are POST + JSON, authenticated via `Authorization: Bearer <jwt>`.
// The vendor returns HTTP 200 even for logical failures, encoding the outcome in a `status`
// field ({"status": 200, ...} ok, {"status": 300, "Error": ...} fail, {"status": 401, ...}
// bad token). So a 2xx HTTP response is NOT success — the body's `status` is authoritative.

interface SkyCrmResponse {
  status?: number;
  message?: string;
  Message?: string;
  Error?: string;
  error?: string;
  [k: string]: unknown;
}

async function post(path: string, body: Record<string, unknown>, extension: string): Promise<SkyCrmResponse> {
  const token = mintToken(extension);
  let response: Response;
  try {
    response = await fetch(`${SKYCRM_BASE_URL}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Telephony request to ${path} failed: ${msg}`);
  }

  const text = await response.text();
  let data: SkyCrmResponse;
  try {
    data = JSON.parse(text) as SkyCrmResponse;
  } catch {
    // A non-JSON body is almost always the vendor's Django 500 HTML page — don't echo the whole
    // thing back into a toast; surface the HTTP code and a short prefix.
    throw new Error(`Telephony ${path} returned a non-JSON response (${response.status}): ${text.slice(0, 120)}`);
  }

  const logicalStatus = Number(data.status);
  if (logicalStatus === 401) {
    throw new Error(`Telephony auth rejected on ${path}: ${data.message ?? "Invalid token"}`);
  }
  if (logicalStatus >= 300) {
    throw new Error(`Telephony ${path} failed: ${data.Error ?? data.error ?? data.message ?? text.slice(0, 120)}`);
  }
  return data;
}

// ─── Correlation state (process-local, POC only) ────────────────────────────────
// dialing_phone gives us no call id, and hangup_phone needs phone_number+extension+per_id
// (which hangup(providerCallId) doesn't carry). Keep just enough to reconstruct a hangup.
// ⚠️ In-memory: does NOT survive a restart and is NOT shared across instances. A production
// version should persist {phone, extension} on the call_logs row keyed by per_id and read it
// back in hangup — not rely on this map. Fine for a single-instance POC.
const pendingCalls = new Map<string, { phone: string; extension: string }>();

// ─── Status mapping ─────────────────────────────────────────────────────────────
// Webhook `status` values (spec §21): "Incomming Call", "Answered", "Outbound Call". The CDR
// event (§21.5) carries the terminal disposition + billsec + recordfile.

const SKYCRM_STATUS_MAP: Record<string, CallStatus> = {
  "incomming call": "ringing",
  "outbound call": "ringing",
  answered: "connected",
  // CDR dispositions (§10/§11): ANSWERED / "Missed Call" etc.
  answered_cdr: "completed",
  "missed call": "no_answer",
};

// ─── Provider ─────────────────────────────────────────────────────────────────

export const skycrmProvider: TelephonyProvider = {
  name: "skycrm",

  async startCall(req: StartCallRequest): Promise<StartCallResult> {
    // agentNumber == the agent's SkyCRM extension; debtorNumber == phone_number; callLogId
    // is reused as per_id (the vendor's "lead id for tracking"). callerId is not a SkyCRM
    // concept (the caller ID is the extension's DID, set on their switch) — ignored here.
    const extension = req.agentNumber;
    await post(
      "dialing_phone",
      {
        phone_number: req.debtorNumber,
        extension,
        prefix: SKYCRM_PREFIX,
        per_id: req.callLogId,
      },
      extension,
    );

    // dialing_phone returns no vendor call id. We hand back our own callLogId (== per_id) as the
    // correlation handle — it is what hangup and our call_logs row both key on. The vendor's real
    // `callid` is learned later (dial_response poll / webhook Outbound event) and, if we ever need
    // it, must be reconciled onto the row then. See parseStatusWebhook's correlation note.
    pendingCalls.set(req.callLogId, { phone: req.debtorNumber, extension });
    return { providerCallId: req.callLogId };
  },

  async hangup(providerCallId: string): Promise<void> {
    // providerCallId is our callLogId (== per_id). hangup_phone needs the phone + extension too,
    // recovered from the pendingCalls map populated at dial time. If it's missing (restart /
    // other instance / inbound leg), we can't reconstruct the vendor's required params — log and
    // no-op rather than throw, since the call may already have ended.
    const pending = pendingCalls.get(providerCallId);
    if (!pending) {
      console.warn(
        `[skycrm-provider] hangup: no pending-call record for per_id=${providerCallId} ` +
          "(restart / cross-instance / inbound leg?) — cannot reconstruct hangup params, skipping.",
      );
      return;
    }
    try {
      await post(
        "hangup_phone",
        {
          phone_number: pending.phone,
          extension: pending.extension,
          prefix: SKYCRM_PREFIX,
          per_id: providerCallId,
        },
        pending.extension,
      );
    } catch (err) {
      // Best-effort — mirror exotelProvider.hangup; the call may already be down.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[skycrm-provider] hangup warning: ${msg}`);
    } finally {
      pendingCalls.delete(providerCallId);
    }
  },

  async sendSms(_req: SendSmsRequest): Promise<SendSmsResult> {
    // SkyCRM v1.2 exposes no SMS endpoint (voice + inbound-queue control only). SMS stays on the
    // existing provider — don't silently pretend it sent.
    throw new Error("SMS is not supported by this telephony provider.");
  },

  parseStatusWebhook(payload: unknown): CallStatusEvent {
    // Webhook events (spec §21): {status, phone, direction, source, destination, queue, callid,
    // extension, income_date, message}; the CDR event adds {billsec, disposition, recordfile}.
    const p = payload as Record<string, unknown>;
    const pick = <T>(...keys: string[]): T | undefined => {
      for (const k of keys) {
        const v = p[k];
        if (v !== undefined && v !== null && v !== "") return v as T;
      }
      return undefined;
    };

    // ⚠️ Correlation gap: the webhook carries the vendor `callid` but NOT our per_id, while at
    // dial time we only knew our per_id (dialing_phone returned no callid). So for OUTBOUND calls
    // there is no shared key here yet — reconciling callid↔per_id needs either the dial_response
    // poll (which returns both request_id and callid) or a vendor change to echo per_id in the
    // webhook. For the POC this is a known limitation to resolve against the live account.
    const callid = pick<string>("callid");
    if (!callid) {
      throw new Error("Invalid telephony webhook: no callid to correlate on");
    }

    const rawStatus = (pick<string>("status") ?? "").toLowerCase();
    const disposition = (pick<string>("disposition") ?? "").toLowerCase();
    // A CDR event (has billsec/disposition/recordfile) is our terminal signal.
    const isCdr = pick("billsec") !== undefined || disposition !== "";
    let status: CallStatus;
    if (isCdr) {
      status = disposition === "answered" ? "completed" : SKYCRM_STATUS_MAP[disposition] ?? "no_answer";
    } else {
      status = SKYCRM_STATUS_MAP[rawStatus] ?? "failed";
    }

    const billsec = pick<string | number>("billsec");
    return {
      providerCallId: callid,
      // No per_id echoed — leave customIdentifier undefined until correlation is solved.
      customIdentifier: undefined,
      status,
      durationSeconds: billsec === undefined ? undefined : Number(billsec) || 0,
      recordingUrl: pick<string>("recordfile", "recordingUrl"),
    };
  },
};

// ─── Auxiliary SkyCRM calls (not part of TelephonyProvider) ─────────────────────
// Needed to "build our own telephony layer" for the POC, but outside the voice interface —
// the dialer engine / server routes call these directly, the way messages-store.ts calls
// sendWhatsApp on the Exotel provider. All are POC scaffolds: shapes come from the v1.2 spec,
// unverified against the live account.

/** Verify credentials / that a token is accepted. GET /login_user_ajax2?token=<jwt>.
 * Returns the parsed body; a signature-valid token with bad creds yields status 301
 * ("User does not exist"), a good login redirects (302) to the CRM home. */
export async function skycrmLogin(extension: string): Promise<{ httpStatus: number; body: string }> {
  const token = mintToken(extension);
  const response = await fetch(
    `${SKYCRM_BASE_URL}/login_user_ajax2?token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  return { httpStatus: response.status, body: (await response.text()).slice(0, 500) };
}

/** Inbound: register an extension into one or more ACD queues (login_in_queue1). */
export function registerQueue(extension: string, queue: string): Promise<SkyCrmResponse> {
  return post("login_in_queue1", { extension, queue }, extension);
}

/** Inbound: remove an extension from its queues (logout_queue1). */
export function deregisterQueue(extension: string, queue: string): Promise<SkyCrmResponse> {
  return post("logout_queue1", { extension, queue }, extension);
}

/** Inbound: pause the queue for an extension (break / on-call) to stop new inbound (queue_paused1). */
export function pauseQueue(extension: string): Promise<SkyCrmResponse> {
  return post("queue_paused1", { extension }, extension);
}

/** Inbound: un-pause the queue for an extension (queue_unpaused1). */
export function unpauseQueue(extension: string): Promise<SkyCrmResponse> {
  return post("queue_unpaused1", { extension }, extension);
}

/** After-call: record the disposition against the account (disposition_api). `disposition` must
 * be one of the vendor's two top-level values ("Contacted" / "Non-Contacted"); sub_disposition is
 * the finer outcome. Map our CallOutcome → these before calling. */
export function sendDisposition(args: {
  extension: string;
  phone_number: string;
  caller_name: string;
  disposition: "Contacted" | "Non-Contacted";
  sub_disposition: string;
  remark: string;
  callback_datetime?: string;
  direction: "Inbound" | "Outbound";
}): Promise<SkyCrmResponse> {
  const { extension, ...rest } = args;
  return post("disposition_api", { extension, ...rest }, extension);
}

// TODO (POC, once the live test env + credentials land): wire the remaining differentiators the
// v1.2 spec exposes but this scaffold doesn't yet — call monitor (listen/whisper/barge via
// call_monitor_api + call_monitor_hangup_api), mute/hold (mute_calls / hold_calls),
// transfer/swap/conference (call_transfer / call_swaping / conf_hangup), the dial_response poll
// (to recover the vendor callid ↔ per_id correlation), CDR + recording pull (cdr_report /
// download-audio), and break events (break_events2). None are needed for a basic outbound +
// inbound POC loop; add them as the workflow requires.
