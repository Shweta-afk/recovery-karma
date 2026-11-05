// Pure helpers for call recordings (2026-11-05). No I/O, no imports beyond node:zlib — safe to
// test in isolation (scripts/call-recordings.test.ts).
//
// SkyCRM's download_audio/ answers with a ZIP holding the recording (spec §12: "download in ZIP"),
// a JSON error body when it can't, and possibly the bare audio. `extractRecording` accepts all
// three so a vendor change in packaging doesn't silently stop imports.
//
// A stored recording is referred to in call_logs.recording_url by a MARKER, not a URL:
// "samvadx-recording:<telephony_calls.id>". The audio lives in a private Storage bucket and is
// played through a short-lived signed link that the server only hands to someone who can already
// see the call log (recording-actions.server.ts). A long-lived link in the column would let anyone
// who copied it listen to a borrower's call for as long as it lasted.
import { inflateRawSync } from "node:zlib";

export {
  CALL_RECORDINGS_BUCKET,
  recordingMarker,
  parseRecordingMarker,
  RECORDING_MARKER_PREFIX,
} from "./recording-marker";

export interface ExtractedRecording {
  bytes: Buffer;
  /** File name inside the zip (or "recording.<ext>" for bare audio). */
  name: string;
  contentType: string;
}

export type ExtractResult =
  | { ok: true; file: ExtractedRecording }
  /** `vendor`: the vendor said it could not produce the file (JSON/HTML error) — usually an
   *  outage on their side, so retrying later is right. `empty`: a zip with no audio in it. */
  | { ok: false; kind: "vendor" | "empty" | "unknown"; detail: string };

const AUDIO_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  gsm: "audio/gsm",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
};

export function audioContentType(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return AUDIO_TYPES[ext] ?? null;
}

function sniffAudio(buf: Buffer): { ext: string; type: string } | null {
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE")
    return { ext: "wav", type: "audio/wav" };
  if (buf.length >= 3 && (buf.toString("latin1", 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)))
    return { ext: "mp3", type: "audio/mpeg" };
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "OggS") return { ext: "ogg", type: "audio/ogg" };
  return null;
}

/** Entries of a ZIP via its central directory (handles data descriptors, which local headers
 *  alone don't). Supports stored (0) and deflate (8) — what every zip writer uses by default. */
export function readZipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("corrupt zip entry");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`unsupported zip compression ${method}`);
  }
  return out;
}

/** Pull the recording out of whatever download_audio/ returned. */
export function extractRecording(body: Buffer): ExtractResult {
  if (body.length === 0) return { ok: false, kind: "vendor", detail: "empty response" };
  const head = body.toString("latin1", 0, Math.min(body.length, 64)).trimStart();
  if (head.startsWith("{") || head.startsWith("<")) {
    // JSON error ({"status":500,"error":"HTTPSConnectionPool(host='disk'…"}) or a Django HTML page.
    return { ok: false, kind: "vendor", detail: body.toString("utf8", 0, Math.min(body.length, 300)) };
  }
  if (body.readUInt32LE(0) === 0x04034b50 || body.readUInt32LE(0) === 0x06054b50) {
    let entries: { name: string; data: Buffer }[];
    try {
      entries = readZipEntries(body);
    } catch (err) {
      return { ok: false, kind: "unknown", detail: err instanceof Error ? err.message : String(err) };
    }
    const audio =
      entries.find((e) => audioContentType(e.name) && e.data.length > 0) ??
      entries.find((e) => sniffAudio(e.data));
    if (!audio) return { ok: false, kind: "empty", detail: `zip held ${entries.length} file(s), no audio` };
    const type = audioContentType(audio.name) ?? sniffAudio(audio.data)?.type ?? "application/octet-stream";
    const name = audio.name.split("/").pop() || audio.name;
    return { ok: true, file: { bytes: audio.data, name, contentType: type } };
  }
  const bare = sniffAudio(body);
  if (bare) return { ok: true, file: { bytes: body, name: `recording.${bare.ext}`, contentType: bare.type } };
  return { ok: false, kind: "unknown", detail: `unrecognised ${body.length}-byte response` };
}

/** SkyCRM date format for cdr_report: dd-mm-yyyy, in IST. */
export function skycrmIstDate(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${ist.getUTCFullYear()}`;
}

/** Storage path: <company>/<IST yyyy-mm-dd>/<vendor callid>.<ext>. */
export function recordingObjectPath(clientId: string, startedAt: Date, vendorCallId: string, name: string): string {
  const ist = new Date(startedAt.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const ext = (name.toLowerCase().split(".").pop() || "wav").replace(/[^a-z0-9]/g, "") || "wav";
  const safeId = vendorCallId.replace(/[^0-9A-Za-z._-]/g, "_");
  return `${clientId}/${ist}/${safeId}.${ext}`;
}

/** Wait before retrying a call whose file couldn't be fetched: 10 min, 20 min, … capped at 6 h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(6 * 3600_000, Math.max(1, attempts) * 10 * 60_000);
}

/** Per-file attempts before giving up (vendor-wide outages don't count — see the importer). */
export const MAX_RECORDING_ATTEMPTS = 8;
