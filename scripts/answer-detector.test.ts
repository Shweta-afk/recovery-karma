import { expect, test } from "bun:test";
import { looksAnswered, type AudioFrame } from "../src/lib/telephony/answer-detector";

const tone: AudioFrame = { rms: 0.05, toneRatio: 0.9 };
const silent: AudioFrame = { rms: 0.001, toneRatio: 0 };
const voice: AudioFrame = { rms: 0.06, toneRatio: 0.15 };
const music: AudioFrame = { rms: 0.05, toneRatio: 0.2 };
const rep = <T>(f: T, n: number) => Array.from({ length: n }, () => f);

test("Indian ringback (0.4 s on, 0.2 off, 0.4 on, 2 s off) is not an answer", () => {
  const cadence = [...rep(tone, 4), ...rep(silent, 2), ...rep(tone, 4), ...rep(silent, 20)];
  expect(looksAnswered([...cadence, ...cadence])).toBe(false);
});

test("a caller tune (continuous music, no gaps) is not an answer", () => {
  expect(looksAnswered(rep(music, 40))).toBe(false);
});

test("silence (no early media) is not an answer", () => {
  expect(looksAnswered(rep(silent, 40))).toBe(false);
});

test("speech — words broken by pauses — is an answer", () => {
  const hello = [
    ...rep(voice, 4),
    ...rep(silent, 3),
    ...rep(voice, 5),
    ...rep(silent, 4),
    ...rep(voice, 4),
  ];
  expect(looksAnswered([...rep(tone, 10), ...hello])).toBe(true);
});

test("needs a full 2 s of audio before deciding", () => {
  expect(looksAnswered([...rep(voice, 3), ...rep(silent, 3)])).toBe(false);
});
