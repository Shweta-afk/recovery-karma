// How call_logs.recording_url refers to a recording SamvadX stored itself (2026-11-05):
// "samvadx-recording:<telephony_calls.id>", never a URL. Browser-safe (no node imports) — the
// players use isStoredRecording() to know they must ask the server for a short-lived link.
// See recording-file.ts and recording-actions.server.ts.

export const RECORDING_MARKER_PREFIX = "samvadx-recording:";

/** Private Storage bucket holding the audio (created by the importer on first use). */
export const CALL_RECORDINGS_BUCKET = "call-recordings";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function recordingMarker(ledgerId: string): string {
  return `${RECORDING_MARKER_PREFIX}${ledgerId}`;
}

/** The telephony_calls id inside a marker, or null for anything else (a real URL, junk). */
export function parseRecordingMarker(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(RECORDING_MARKER_PREFIX)) return null;
  const id = value.slice(RECORDING_MARKER_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

export function isStoredRecording(value: string | null | undefined): boolean {
  return parseRecordingMarker(value) !== null;
}

/** File name for a downloaded recording: "call-<IST yyyy-mm-dd_HHMM>-<last 4 digits>.<ext>".
 *  Only the last 4 digits of the number, so a folder of downloads doesn't list borrowers' phones
 *  in full; the date/time is IST (2026-11-18). */
export function recordingDownloadName(
  startedAt: string | null | undefined,
  remotePhone: string | null | undefined,
  contentType: string | null | undefined,
): string {
  const ext = /mpeg|mp3/i.test(contentType ?? "")
    ? "mp3"
    : /ogg/i.test(contentType ?? "")
      ? "ogg"
      : "wav";
  const t = startedAt ? new Date(startedAt) : null;
  let when = "unknown-time";
  if (t && !Number.isNaN(t.getTime())) {
    const ist = new Date(t.getTime() + 330 * 60_000).toISOString(); // UTC+05:30
    when = `${ist.slice(0, 10)}_${ist.slice(11, 13)}${ist.slice(14, 16)}`;
  }
  const digits = (remotePhone ?? "").replace(/\D/g, "");
  const tail = digits.length >= 4 ? `-${digits.slice(-4)}` : "";
  return `call-${when}${tail}.${ext}`;
}
