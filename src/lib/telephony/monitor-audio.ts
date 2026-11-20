// Pure: reads the browser phone's audio statistics for a Listen/Whisper/Barge call (2026-11-17).
// Tested in scripts/monitor-audio.test.ts.

export interface MonitorAudioStats {
  packets: number;
  bytes: number;
  /** WebRTC totalAudioEnergy over the call so far (Σ level² × seconds); null if not reported. */
  energy: number | null;
}

export type MonitorAudioVerdict = "sound" | "silence" | "no-media";

/** Below this many packets in ~8 s nothing is really arriving (RTP runs at 50 packets/s). */
export const MIN_PACKETS = 20;
/** ~8 s of speech at level 0.05 gives ≈0.02; line noise / comfort noise stays far below this. */
export const SILENCE_ENERGY = 0.001;

export function monitorAudioVerdict(s: MonitorAudioStats | null): MonitorAudioVerdict {
  if (!s || s.packets < MIN_PACKETS) return "no-media";
  if (s.energy !== null && s.energy < SILENCE_ENERGY) return "silence";
  return "sound";
}
