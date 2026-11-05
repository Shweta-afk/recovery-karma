// Plays a call recording, wherever call_logs.recording_url points. A provider URL plays directly;
// a recording SamvadX stored itself ("samvadx-recording:<id>", see lib/telephony/recording-marker)
// is fetched on click as a one-hour signed link the server only gives to someone who can see the
// call (recording-actions.server.ts). Fetching on click, not on render, keeps a long Activity
// History page from asking the server for a link per row.
import { useState } from "react";
import { Download, Loader2, PlayCircle } from "lucide-react";
import { isStoredRecording } from "@/lib/telephony/recording-marker";

async function signedLink(recording: string): Promise<string> {
  const [{ getRecordingPlayUrl }, { getAccessToken }] = await Promise.all([
    import("@/lib/recording-actions.server"),
    import("@/lib/access-token"),
  ]);
  const { url } = await getRecordingPlayUrl({
    data: { accessToken: await getAccessToken(), recording },
  });
  return url;
}

export function RecordingAudio({
  url,
  compact = false,
  showOpenLink = false,
}: {
  url: string;
  /** Small "Play recording" link that turns into a player (Activity History rows). */
  compact?: boolean;
  /** Also offer "Open recording" (new tab / download) once a playable link exists. */
  showOpenLink?: boolean;
}) {
  const stored = isStoredRecording(url);
  const [src, setSrc] = useState<string | null>(stored ? null : url);
  const [open, setOpen] = useState(!compact);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setOpen(true);
    if (src || loading) return;
    setLoading(true);
    setError(null);
    try {
      setSrc(await signedLink(url));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording not available right now");
    } finally {
      setLoading(false);
    }
  };

  if (compact && !open) {
    return (
      <button
        type="button"
        onClick={() => void load()}
        className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
      >
        <PlayCircle className="h-3.5 w-3.5" />
        Play recording
      </button>
    );
  }

  if (!src) {
    return (
      <div className="mt-1 text-[11px] text-muted-foreground">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : loading ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading recording…
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Load recording
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <audio controls autoPlay={compact} src={src} className={compact ? "mt-1 h-8 w-64 max-w-full" : "h-9 w-full"} />
      {showOpenLink && (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Download className="h-3 w-3" />
          Open recording
        </a>
      )}
    </div>
  );
}
