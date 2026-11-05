// Call recordings imported from SkyCRM (src/lib/telephony/recording-file.ts, recording-marker.ts).
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  extractRecording,
  readZipEntries,
  recordingObjectPath,
  retryDelayMs,
  skycrmIstDate,
} from "../src/lib/telephony/recording-file";
import {
  isStoredRecording,
  parseRecordingMarker,
  recordingMarker,
} from "../src/lib/telephony/recording-marker";

function wav(bytes = 64): Buffer {
  const b = Buffer.alloc(12 + bytes);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(4 + bytes, 4);
  b.write("WAVE", 8, "latin1");
  return b;
}

/** Minimal zip writer (with a data descriptor flag on deflated entries, like Python's zipfile
 *  when streaming) so the reader is tested against the central directory, not local headers. */
function zip(files: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const body = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(f.deflate ? 8 : 0, 6); // flags: bit 3 = sizes in descriptor
    lh.writeUInt16LE(f.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(f.deflate ? 0 : body.length, 18); // 0 when using a descriptor
    lh.writeUInt32LE(f.deflate ? 0 : f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const desc = f.deflate ? Buffer.alloc(16) : Buffer.alloc(0);
    if (f.deflate) {
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(body.length, 8);
      desc.writeUInt32LE(f.data.length, 12);
    }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(f.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    locals.push(lh, name, body, desc);
    offset += lh.length + name.length + body.length + desc.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("extractRecording", () => {
  test("SkyCRM's current outage answer is a vendor error, not a bad file", () => {
    const body = Buffer.from(
      `{"status": 500, "error": "HTTPSConnectionPool(host='disk', port=443): Max retries exceeded"}`,
    );
    const r = extractRecording(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("vendor");
    expect(extractRecording(Buffer.from("<html>Server Error</html>")).ok).toBe(false);
    expect(extractRecording(Buffer.alloc(0)).ok).toBe(false);
  });

  test("a zip with the wav, stored or deflated (with data descriptor)", () => {
    const audio = wav(500);
    for (const deflate of [false, true]) {
      const r = extractRecording(
        zip([{ name: "monitor/20261105/out-8607-1793869694.9024.wav", data: audio, deflate }]),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.file.bytes.equals(audio)).toBe(true);
        expect(r.file.name).toBe("out-8607-1793869694.9024.wav");
        expect(r.file.contentType).toBe("audio/wav");
      }
    }
  });

  test("picks the audio among other files; a zip with no audio is 'empty'", () => {
    const z = zip([
      { name: "readme.txt", data: Buffer.from("hi") },
      { name: "rec.mp3", data: Buffer.from("ID3....") },
    ]);
    const r = extractRecording(z);
    expect(r.ok && r.file.contentType).toBe("audio/mpeg");
    const e = extractRecording(zip([{ name: "readme.txt", data: Buffer.from("hi") }]));
    expect(!e.ok && e.kind).toBe("empty");
    expect(readZipEntries(zip([])).length).toBe(0);
  });

  test("bare audio is accepted too", () => {
    const r = extractRecording(wav());
    expect(r.ok && r.file.name).toBe("recording.wav");
  });
});

describe("markers", () => {
  const id = "a5c04827-8bb1-4bf1-8d29-4d7fef892dc9";
  test("round trip, and nothing else parses as one", () => {
    expect(parseRecordingMarker(recordingMarker(id))).toBe(id);
    expect(isStoredRecording(recordingMarker(id))).toBe(true);
    expect(isStoredRecording("https://example.com/rec.wav")).toBe(false);
    expect(parseRecordingMarker("samvadx-recording:../../etc")).toBeNull();
    expect(parseRecordingMarker(null)).toBeNull();
  });
});

describe("helpers", () => {
  test("IST dates for cdr_report and storage paths", () => {
    // 2026-11-04 20:00 UTC = 2026-11-05 01:30 IST
    const late = new Date(Date.UTC(2026, 10, 4, 20, 0));
    expect(skycrmIstDate(late)).toBe("05-11-2026");
    expect(recordingObjectPath("c1", late, "1793869694.9024", "x.WAV")).toBe(
      "c1/2026-11-05/1793869694.9024.wav",
    );
    expect(recordingObjectPath("c1", late, "../evil", "x.wav")).toBe("c1/2026-11-05/.._evil.wav");
  });
  test("retry backoff grows and caps at 6 h", () => {
    expect(retryDelayMs(0)).toBe(10 * 60_000);
    expect(retryDelayMs(3)).toBe(30 * 60_000);
    expect(retryDelayMs(100)).toBe(6 * 3600_000);
  });
});
