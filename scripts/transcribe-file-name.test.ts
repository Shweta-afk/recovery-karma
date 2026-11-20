import { describe, expect, test } from "bun:test";
import { audioFileName, transcribeErrorMessage } from "../src/lib/transcribe-upload";

describe("transcription upload", () => {
  test("SkyCRM's WAV recordings are sent as .wav, never .mp3", () => {
    expect(audioFileName("audio/wav")).toBe("recording.wav");
    expect(audioFileName("audio/x-wav")).toBe("recording.wav");
    expect(audioFileName("audio/mpeg")).toBe("recording.mp3");
  });
  test("falls back to the URL's extension, then WAV", () => {
    expect(audioFileName("", "https://x.example/rec/abc.mp3?sig=1")).toBe("recording.mp3");
    expect(audioFileName(undefined, null)).toBe("recording.wav");
  });
  test("error messages name no vendor", () => {
    for (const s of [400, 401, 403, 413, 429, 500]) {
      expect(transcribeErrorMessage(s)).not.toMatch(/groq|whisper|gemini/i);
    }
  });
});
