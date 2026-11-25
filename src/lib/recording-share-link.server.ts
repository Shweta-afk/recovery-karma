// Short recording links for the banker's Feedback File (user, 2026-11-25).
//
// A Supabase signed URL is ~300 characters and shows the whole Storage path
// (…/storage/v1/object/sign/call-recordings/<company>/<…>.wav?token=<JWT>). Instead the file
// carries https://<company>.samvadx.com/r/<token>: the token holds the ledger id
// (telephony_calls.id), an expiry and an HMAC, nothing else — no phone, no path. Opening it
// checks the signature and expiry, then redirects to a fresh 10-minute Storage link.
//
// Stateless: nothing is stored per link. The key comes from RECORDING_LINK_SECRET, or is derived
// from SUPABASE_SERVICE_ROLE_KEY (always set on the server) — rotating either ends old links.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSupabaseAdmin } from "./supabase-admin.server";
import { CALL_RECORDINGS_BUCKET } from "./telephony/recording-marker";

export const RECORDING_LINK_PATH_PREFIX = "/r/";

const ID_LEN = 22; // 16 bytes, base64url
const SIG_LEN = 16; // 12 bytes, base64url
const REDIRECT_SECONDS = 600;
const UUID_RE = /^[0-9a-f]{32}$/;

function linkKey(): string {
  const own = process.env.RECORDING_LINK_SECRET;
  if (own) return own;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createHmac("sha256", service).update("samvadx-recording-link").digest("hex");
}

function sign(body: string, key: string): string {
  return createHmac("sha256", key).update(body).digest().subarray(0, 12).toString("base64url");
}

/** Token for one recording, valid until `expiresAt` (unix seconds). */
export function recordingLinkToken(ledgerId: string, expiresAt: number, key = linkKey()): string {
  const hex = ledgerId.replace(/-/g, "").toLowerCase();
  if (!UUID_RE.test(hex)) throw new Error("Not a recording id");
  const id = Buffer.from(hex, "hex").toString("base64url");
  const exp = Math.floor(expiresAt).toString(36);
  return `${id}${sign(id + exp, key)}${exp}`;
}

/** The ledger id inside a valid, unexpired token; null for anything else. */
export function readRecordingLinkToken(
  token: string,
  nowSeconds = Date.now() / 1000,
  key = linkKey(),
): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length <= ID_LEN + SIG_LEN) return null;
  const id = token.slice(0, ID_LEN);
  const sig = token.slice(ID_LEN, ID_LEN + SIG_LEN);
  const exp = token.slice(ID_LEN + SIG_LEN);
  if (!/^[0-9a-z]{1,10}$/.test(exp)) return null;
  const want = Buffer.from(sign(id + exp, key));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (parseInt(exp, 36) < nowSeconds) return null;
  const hex = Buffer.from(id, "base64url").toString("hex");
  if (!UUID_RE.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const page = (status: number, text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Call recording · SamvadX</title><p style="font-family:sans-serif;margin:3rem">${text}</p>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );

/** GET /r/<token> → 302 to a short-lived Storage link for that recording. */
export async function handleRecordingLink(request: Request): Promise<Response> {
  const token = new URL(request.url).pathname.slice(RECORDING_LINK_PATH_PREFIX.length);
  const ledgerId = readRecordingLinkToken(token);
  if (!ledgerId) return page(410, "This recording link has expired or is not valid.");
  const admin = getSupabaseAdmin() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data: row } = await admin
    .from("telephony_calls")
    .select("recording_object, recording_status")
    .eq("id", ledgerId)
    .maybeSingle();
  if (!row?.recording_object || row.recording_status === "expired") {
    return page(404, "This recording is no longer available.");
  }
  const { data: signed } = await admin.storage
    .from(CALL_RECORDINGS_BUCKET)
    .createSignedUrl(row.recording_object, REDIRECT_SECONDS);
  if (!signed?.signedUrl) return page(404, "This recording is no longer available.");
  return new Response(null, {
    status: 302,
    headers: { location: signed.signedUrl, "cache-control": "no-store" },
  });
}
