// SkyCRM-ACD implementation of TelephonyProvider (voice + inbound queue control).
// Vendor: Intellect Info Trade, "SKYCRM - ACD (Auto Call Dialer)", API spec v1.2 (PDF, not public).
// Server-side only — never import from client code (needs SKYCRM_SECRET).
//
// Click-to-call: dialing_phone rings the agent's extension (a SIP softphone — Zoiper/X-Lite — until
// the SIP.js webphone lands), then bridges the debtor. Proven end-to-end on the vendor test env
// 2026-09-11 (dial, two-way audio, hangup, CDR, queue register/pause, inbound via DID).
//
// Vendor quirks that differ from other providers:
// 1. AUTH is a per-request HS256 JWT minted from a shared secret + {username, password, extension,
//    exp}. The extension is inside the token, so a token is minted per request per extension.
//    The secret lives only in SKYCRM_SECRET — never paste it into code or comments.
// 2. BODIES MUST BE FORM-ENCODED (see post() below).
// 3. HTTP 200 does not mean success — the body's `status` field does.

import { createHmac } from "node:crypto";
import type {
  TelephonyProvider,
  StartCallRequest,
  StartCallResult,
  SendSmsRequest,
  SendSmsResult,
  CallStatusEvent,
  CallStatus,
  HangupContext,
} from "./types";
import { appError } from "../app-error";

// ─── Configuration ────────────────────────────────────────────────────────────

const env = (key: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[key] : undefined;

const SKYCRM_BASE_URL = env("SKYCRM_BASE_URL") ?? "https://vs.skycrm.app";
/** HS256 signing secret from the vendor. If copying it from the PDF, drop the leading space the
 * PDF renders inside the quotes — it is not part of the key. */
const SKYCRM_SECRET = env("SKYCRM_SECRET");
/** Optional. The API only checks the token's signature (the vendor confirmed 2026-11-02, and calls
 * with a blank username/password succeed), so these only matter for the CRM web login. */
const SKYCRM_USER = env("SKYCRM_USER") ?? "";
const SKYCRM_PASS = env("SKYCRM_PASS") ?? "";
/** Dialing prefix: SkyCRM dials prefix + number. On our account (and their test env) it is the
 * agent's own extension — 8601 dials "8601" + number — so unset or "extension" means that; any
 * other value is sent as-is for every agent. */
const SKYCRM_PREFIX = env("SKYCRM_PREFIX")?.trim() || "extension";
const dialPrefix = (extension: string) =>
  SKYCRM_PREFIX === "extension" ? extension : SKYCRM_PREFIX;

/** SkyCRM dials prefix + number straight onto the Tata trunk, which only connects the plain
 *  10-digit Indian number. "+91…"/"91…"/"0…" forms reached it as NO ANSWER (2026-11-03). */
export function skycrmNumber(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return d;
}
/** Form field dialing_phone takes a per-call caller ID in, if the vendor supports one. UNCONFIRMED
 *  (asked 2026-10-26): leave unset and the DID configured on the extension is used, as before. */
const SKYCRM_CALLER_ID_FIELD = env("SKYCRM_CALLER_ID_FIELD")?.trim() || undefined;
/** Seconds a minted token stays valid. Short-lived; a fresh token is minted per request. */
const TOKEN_TTL_SECONDS = 3600;

function requireCredentials() {
  if (!SKYCRM_SECRET) {
    // Surfaced to an agent's toast; the missing setting goes to the server log only — see
    // docs/ERROR_CODES.md.
    throw appError("SX-3001", "Calling is not set up yet. Contact SamvadX support.", {
      missing: ["SKYCRM_SECRET"],
    });
  }
}

// ─── Auth: HS256 JWT ────────────────────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
  const signature = b64url(
    createHmac("sha256", SKYCRM_SECRET as string)
      .update(`${header}.${payload}`)
      .digest(),
  );
  return `${header}.${payload}.${signature}`;
}

// ─── Shared POST helper ─────────────────────────────────────────────────────────
// All non-login endpoints are POST with a `Authorization: Bearer <jwt>` header, and the body is
// FORM-ENCODED (application/x-www-form-urlencoded), NOT JSON.
//
// ⚠️ HARD-WON: the vendor's Django views read fields off `request.POST`, so a JSON body arrives
// as empty and every field reads back as None — their code then indexes that None and returns
// {"status":300,"Error":"'NoneType' object is not subscriptable — Failed to Dialing Number"}.
// This crash cost days of debugging (2026-09) and looked like a channel/prefix/per_id problem;
// it was purely the content-type. Verified 2026-09-11 against the test env: switching dial /
// hangup / login_in_queue1 / check_for_incoming_api to form encoding made all four succeed.
// Do NOT send JSON to this vendor.
//
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

async function post(
  path: string,
  body: Record<string, unknown>,
  extension: string,
): Promise<SkyCrmResponse> {
  const token = mintToken(extension);
  let response: Response;
  try {
    // Form-encode the body — see the ⚠️ note above; JSON makes every field read as None
    // server-side. URLSearchParams sets Content-Type: application/x-www-form-urlencoded, which
    // the vendor's Django `request.POST` reads (as does multipart form-data in Postman).
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    response = await fetch(`${SKYCRM_BASE_URL}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    throw appError("SX-3102", "Could not reach the calling service. Please try again.", {
      path,
      error: err,
    });
  }

  const text = await response.text();
  let data: SkyCrmResponse;
  try {
    data = JSON.parse(text) as SkyCrmResponse;
  } catch {
    // A non-JSON body is almost always the vendor's Django 500 HTML page — log it, never toast it.
    throw appError("SX-3103", "The calling service had a problem. Please try again.", {
      path,
      status: response.status,
      body: text.slice(0, 300),
    });
  }

  const logicalStatus = Number(data.status);
  if (logicalStatus === 401) {
    throw appError("SX-3101", "Calling is not available right now. Contact SamvadX support.", {
      path,
      response: data,
    });
  }
  if (logicalStatus >= 300) {
    throw appError("SX-3104", "The call could not be placed. Please try again.", {
      path,
      response: data.Error ?? data.error ?? data.message ?? text.slice(0, 300),
    });
  }
  return data;
}

// ─── Correlation ────────────────────────────────────────────────────────────────
// dialing_phone returns no call id, so server.ts reserves a telephony_calls ledger row first and
// passes its id as `requestId`; we send it as per_id and hand it back as providerCallId.
// hangup_phone keys off phone + extension (not a call id), which server.ts reads back from that
// ledger row and passes as HangupContext — so a hangup still works after a restart or on another
// instance. Webhook events carry SkyCRM's own `callid` plus the extension and phone, and
// server.ts matches them to the ledger (callid once known, else the open call on that extension).

// ─── Status mapping ─────────────────────────────────────────────────────────────
// Live events (spec §21): "Incomming Call" / "Outbound Call" → ringing, "Answered" → connected.
// The CDR event (§21.5) is the only terminal signal; its `disposition` is Asterisk's
// (ANSWERED / NO ANSWER / BUSY / FAILED / CONGESTION) or SkyCRM's "Missed Call".

const LIVE_STATUS: Record<string, CallStatus> = {
  "incomming call": "ringing",
  "incoming call": "ringing",
  "outbound call": "ringing",
  answered: "connected",
  answer: "connected",
};

const CDR_DISPOSITION: Record<string, CallStatus> = {
  answered: "completed",
  "no answer": "no_answer",
  "missed call": "no_answer",
  busy: "busy",
  failed: "failed",
  congestion: "failed",
};

/** SkyCRM extensions are short (8006, 8597); phone numbers are 10+ digits. */
const looksLikeExtension = (v: string | undefined) => !!v && /^\d{3,6}$/.test(v.trim());

// ─── Provider ─────────────────────────────────────────────────────────────────

export const skycrmProvider: TelephonyProvider = {
  name: "skycrm",

  async startCall(req: StartCallRequest): Promise<StartCallResult> {
    // agentNumber is the agent's SkyCRM extension (server.ts resolves it from agents.agent_extension).
    // callerId is the DID the guard picked (telephony_dids). It is sent only once the vendor names
    // the field (SKYCRM_CALLER_ID_FIELD); until then the DID set on the extension applies.
    const extension = req.agentNumber;
    const perId = req.requestId || req.callLogId;
    // SkyCRM rings the agent's softphone first. If it isn't registered, dialing_phone still says
    // "Dialling … successfully" and then nothing happens (seen 2026-11-02 right after a VPN
    // reconnect), so check first and tell the agent instead.
    const state = await post("dial_response", { extension }, extension);
    const rows = Array.isArray(state.response) ? (state.response as { status?: string }[]) : [];
    if (rows.some((r) => String(r.status ?? "").toLowerCase() === "unavailable")) {
      throw appError(
        "SX-3106",
        `Your phone (extension ${extension}) isn't connected. Open your softphone, check it is registered, then try again.`,
        { extension },
      );
    }
    await post(
      "dialing_phone",
      {
        phone_number: skycrmNumber(req.debtorNumber),
        extension,
        prefix: dialPrefix(extension),
        per_id: perId,
        ...(SKYCRM_CALLER_ID_FIELD && req.callerId
          ? { [SKYCRM_CALLER_ID_FIELD]: req.callerId }
          : {}),
      },
      extension,
    );
    return { providerCallId: perId };
  },

  async hangup(providerCallId: string, ctx?: HangupContext): Promise<void> {
    const extension = ctx?.agentHandle?.trim();
    const phone = ctx?.remotePhone?.trim();
    if (!extension || !phone) {
      console.warn(
        "[skycrm-provider] hangup: no extension/phone for this call (no ledger row?) — skipping.",
      );
      return;
    }
    try {
      if (ctx?.direction === "inbound") {
        await post("incoming_hangup1", { phone_number: skycrmNumber(phone), extension }, extension);
      } else {
        await post(
          "hangup_phone",
          {
            phone_number: skycrmNumber(phone),
            extension,
            prefix: dialPrefix(extension),
            per_id: providerCallId,
          },
          extension,
        );
      }
    } catch (err) {
      // Best-effort: the call may already be down, and the CDR webhook will still close it.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[skycrm-provider] hangup warning: ${msg}`);
    }
  },

  async sendSms(_req: SendSmsRequest): Promise<SendSmsResult> {
    // SkyCRM v1.2 exposes no SMS endpoint (voice + inbound-queue control only). SMS stays on the
    // existing provider — don't silently pretend it sent.
    throw appError("SX-3105", "SMS is not available yet.");
  },

  parseStatusWebhook(payload: unknown): CallStatusEvent {
    const p = payload as Record<string, unknown>;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = p[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
      }
      return undefined;
    };

    if (pick("event") === "ivrdtmf") {
      throw new Error("IVR keypress events are not used yet");
    }
    const callid = pick("callid");
    if (!callid) throw new Error("Invalid telephony webhook: no callid to correlate on");

    const direction = (pick("direction") ?? "").toLowerCase().startsWith("in")
      ? ("inbound" as const)
      : ("outbound" as const);
    const disposition = (pick("disposition") ?? "").toLowerCase();
    const isCdr = pick("billsec") !== undefined || disposition !== "";

    let status: CallStatus;
    let agentHandle = pick("extension");
    let remotePhone = pick("phone");
    if (isCdr) {
      status = CDR_DISPOSITION[disposition] ?? "no_answer";
      // CDR has no extension/phone fields: the extension is whichever of src/dst is short.
      const src = pick("src");
      const dst = pick("dst");
      if (!agentHandle)
        agentHandle = looksLikeExtension(dst) ? dst : looksLikeExtension(src) ? src : undefined;
      if (!remotePhone) remotePhone = agentHandle === dst ? src : dst;
      // An outbound CDR's dst is prefix + number ("8601" + "9876543210"); keep just the number.
      const prefix = agentHandle ? dialPrefix(agentHandle) : "";
      if (prefix && remotePhone?.startsWith(prefix) && remotePhone.length - prefix.length >= 10) {
        remotePhone = remotePhone.slice(prefix.length);
      }
    } else {
      status = LIVE_STATUS[(pick("status") ?? "").toLowerCase()] ?? "failed";
    }

    const billsec = pick("billsec");
    // The dialled number on an inbound call. The spec doesn't name the field; these are the names
    // Asterisk-based switches use. Confirm against a real inbound event and trim the list.
    let didNumber =
      direction === "inbound"
        ? pick("did", "did_number", "didnumber", "dnid", "called_number", "callednumber")
        : undefined;
    if (!didNumber && direction === "inbound" && isCdr) {
      const dst = pick("dst");
      if (dst && !looksLikeExtension(dst) && dst !== remotePhone) didNumber = dst;
    }
    return {
      didNumber,
      // Placeholder: server.ts swaps in our providerCallId after matching the ledger.
      providerCallId: callid,
      vendorCallId: callid,
      status,
      direction,
      agentHandle: looksLikeExtension(agentHandle) ? agentHandle : undefined,
      remotePhone,
      durationSeconds: billsec === undefined ? undefined : Number(billsec) || 0,
      recordingPath: pick("recordfile"),
    };
  },
};

/** Our call outcome → SkyCRM's two top-level dispositions (it accepts only these two). A wrong
 *  number reached someone, but not the borrower, so it counts as not contacted. */
export function skycrmDispositionFor(outcome: string): "Contacted" | "Non-Contacted" {
  return ["no_answer", "voicemail", "wrong_number"].includes(outcome)
    ? "Non-Contacted"
    : "Contacted";
}

// ─── Auxiliary SkyCRM calls (not part of TelephonyProvider) ─────────────────────
// Called directly by skycrm-actions.server.ts (queue presence, disposition sync). Queue register/
// pause/unpause were proven on the test env 2026-09-11; disposition_api was not.

/** Verify credentials / that a token is accepted. GET /login_user_ajax2?token=<jwt>.
 * Returns the parsed body; a signature-valid token with bad creds yields status 301
 * ("User does not exist"), a good login redirects (302) to the CRM home. */
export async function skycrmLogin(
  extension: string,
): Promise<{ httpStatus: number; body: string }> {
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

// Not wired yet (spec §13–20): call monitor (listen/whisper/barge), mute/hold, transfer/swap/
// conference, missed-call list and recording download (download-audio returns a zip by CDR id).
