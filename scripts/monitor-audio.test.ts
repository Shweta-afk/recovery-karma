import { describe, expect, test } from "bun:test";
import { monitorAudioVerdict } from "../src/lib/telephony/monitor-audio";

describe("monitorAudioVerdict", () => {
  test("no stats or almost no packets = nothing reaches the phone", () => {
    expect(monitorAudioVerdict(null)).toBe("no-media");
    expect(monitorAudioVerdict({ packets: 3, bytes: 500, energy: 0 })).toBe("no-media");
  });
  test("packets with no energy = SkyCRM sends silence", () => {
    expect(monitorAudioVerdict({ packets: 400, bytes: 64000, energy: 0 })).toBe("silence");
    expect(monitorAudioVerdict({ packets: 400, bytes: 64000, energy: 0.0002 })).toBe("silence");
  });
  test("packets with energy = sound", () => {
    expect(monitorAudioVerdict({ packets: 400, bytes: 64000, energy: 0.05 })).toBe("sound");
  });
  test("a browser that reports no energy is judged on packets alone", () => {
    expect(monitorAudioVerdict({ packets: 400, bytes: 64000, energy: null })).toBe("sound");
  });
});
