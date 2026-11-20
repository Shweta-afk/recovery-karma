// Pure helpers for sending a call recording to transcription (call-sentiment-actions.server.ts).
// Tested in scripts/transcribe-file-name.test.ts.

/** File name Groq should see for this audio. Groq picks the decoder from the file name, so a
 *  SkyCRM WAV sent as "recording.mp3" was refused — every transcription failed with SX-3201
 *  until 2026-11-20. Exported for tests. */
export function audioFileName(type: string | undefined, url?: string | null): string {
  const t = (type ?? "").toLowerCase();
  const fromType: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/vnd.wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/flac": "flac",
  };
  const ext =
    fromType[t.split(";")[0].trim()] ??
    url?.match(/\.(wav|mp3|m4a|ogg|webm|flac|mp4|mpeg|mpga|opus)(?:$|[?#])/i)?.[1]?.toLowerCase() ??
    "wav";
  return `recording.${ext}`;
}

/** What to tell the auditor/manager when Groq refuses, by status. */
export function transcribeErrorMessage(status: number): string {
  if (status === 401 || status === 403)
    return "AI transcription isn't set up correctly (its access key was refused). Contact SamvadX support.";
  if (status === 413) return "This recording is too long to transcribe (over 25 MB).";
  if (status === 429) return "AI transcription is busy right now. Please try again in a minute.";
  if (status === 400) return "This recording's audio couldn't be read for transcription.";
  return "Could not transcribe this recording. Please try again.";
}
