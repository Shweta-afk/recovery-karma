// Tells when the borrower picks up, from the far-end audio the agent's browser phone receives
// (2026-11-12). SkyCRM sends no "answered" event — one "Success" per call, answered or not — so
// the call screen said Ringing for the whole conversation. While it rings the agent hears the
// ringback tone (a steady ~400 Hz tone) or a caller tune (continuous music); when the borrower
// answers they hear speech, which comes in bursts with short pauses between words.
//
// The rule is deliberately cautious: answered = in the last 2 s there were several non-tonal
// sound frames AND several near-silent gaps. A tone is excluded by its narrow band, music by its
// lack of gaps. A network announcement ("the number you are calling is switched off") is speech
// and can trigger it — the agent then saves No answer as usual. The Answered button stays as a
// manual fallback. Pure classification below; the Web Audio wiring is startAnswerDetector.

export interface AudioFrame {
  /** Root-mean-square level of the frame, 0..1. */
  rms: number;
  /** Share of the frame's 300–3400 Hz energy that sits in 350–500 Hz (ringback tone band). */
  toneRatio: number;
}

export const FRAME_MS = 100;
const WINDOW = 20; // 2 s
const SILENCE_RMS = 0.004;
const SOUND_RMS = 0.012;
const TONAL = 0.55;

export type FrameKind = "silence" | "tone" | "sound" | "quiet";

export function classifyFrame(f: AudioFrame): FrameKind {
  if (f.rms < SILENCE_RMS) return "silence";
  if (f.rms < SOUND_RMS) return "quiet";
  return f.toneRatio >= TONAL ? "tone" : "sound";
}

/** Speech in the last 2 s: enough non-tonal sound, broken by enough pauses. */
export function looksAnswered(frames: AudioFrame[]): boolean {
  const recent = frames.slice(-WINDOW);
  if (recent.length < WINDOW) return false;
  const kinds = recent.map(classifyFrame);
  const sound = kinds.filter((k) => k === "sound").length;
  const silence = kinds.filter((k) => k === "silence" || k === "quiet").length;
  const tone = kinds.filter((k) => k === "tone").length;
  return sound >= 5 && silence >= 4 && tone <= 4;
}

/** Listen to `stream`; calls `onAnswered` once when speech is heard. Returns a stop function. */
export function startAnswerDetector(stream: MediaStream, onAnswered: () => void): () => void {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || !stream.getAudioTracks().length) return () => {};
  const ctx = new Ctx();
  void ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser); // not to the speakers: the <audio> element already plays it
  const time = new Float32Array(analyser.fftSize);
  const freq = new Float32Array(analyser.frequencyBinCount);
  const hzPerBin = ctx.sampleRate / analyser.fftSize;
  const bin = (hz: number) => Math.round(hz / hzPerBin);
  const frames: AudioFrame[] = [];
  let fired = false;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(time);
    let sum = 0;
    for (const v of time) sum += v * v;
    const rms = Math.sqrt(sum / time.length);
    analyser.getFloatFrequencyData(freq);
    let band = 0;
    let voice = 0;
    for (let i = bin(300); i <= bin(3400) && i < freq.length; i++) {
      const p = Math.pow(10, freq[i] / 10);
      voice += p;
      if (i >= bin(350) && i <= bin(500)) band += p;
    }
    frames.push({ rms, toneRatio: voice > 0 ? band / voice : 0 });
    if (frames.length > 40) frames.shift();
    if (!fired && looksAnswered(frames)) {
      fired = true;
      onAnswered();
    }
  }, FRAME_MS);

  return () => {
    clearInterval(timer);
    try {
      source.disconnect();
    } catch {
      /* already gone */
    }
    void ctx.close().catch(() => {});
  };
}
