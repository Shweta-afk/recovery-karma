import { describe, expect, test } from "bun:test";
import { readRecordingLinkToken, recordingLinkToken } from "../src/lib/recording-share-link.server";

const ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const KEY = "test-key";
const NOW = 1_800_000_000;

describe("short recording links (Feedback File)", () => {
  test("round-trips the ledger id and stays short", () => {
    const t = recordingLinkToken(ID, NOW + 7 * 86_400, KEY);
    expect(t.length).toBeLessThan(50);
    expect(t).not.toContain(ID);
    expect(readRecordingLinkToken(t, NOW, KEY)).toBe(ID);
  });

  test("refuses an expired, tampered or foreign-key token", () => {
    const t = recordingLinkToken(ID, NOW + 60, KEY);
    expect(readRecordingLinkToken(t, NOW + 61, KEY)).toBeNull();
    expect(readRecordingLinkToken(t, NOW, "other-key")).toBeNull();
    const flipped = (t[0] === "A" ? "B" : "A") + t.slice(1);
    expect(readRecordingLinkToken(flipped, NOW, KEY)).toBeNull();
    // Pushing the expiry out invalidates the signature.
    const later = recordingLinkToken(ID, NOW + 999_999, KEY);
    expect(readRecordingLinkToken(t.slice(0, 38) + later.slice(38), NOW, KEY)).toBeNull();
    expect(readRecordingLinkToken("", NOW, KEY)).toBeNull();
    expect(readRecordingLinkToken("../etc", NOW, KEY)).toBeNull();
  });
});
