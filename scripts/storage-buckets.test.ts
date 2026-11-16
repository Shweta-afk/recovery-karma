// Supabase refuses to create a bucket whose size limit is above the project's upload limit
// (50 MB here). Recordings and saved archives both asked for more and silently stored nothing.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractRecording } from "../src/lib/telephony/recording-file";

const MAX_MB = 50;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("storage buckets", () => {
  test(`every bucket the app creates asks for at most ${MAX_MB} MB`, () => {
    const root = new URL("../src", import.meta.url).pathname;
    const limits: string[] = [];
    for (const file of sourceFiles(root)) {
      const code = readFileSync(file, "utf8");
      for (const call of code.split("createBucket(").slice(1)) {
        const limit = /fileSizeLimit:\s*"(\d+)\s*MB"/i.exec(call.slice(0, 400));
        expect(limit, `${file}: createBucket without a fileSizeLimit in MB`).not.toBeNull();
        limits.push(`${file}: ${limit![1]}MB`);
        expect(Number(limit![1]), file).toBeLessThanOrEqual(MAX_MB);
      }
    }
    expect(limits.length).toBeGreaterThanOrEqual(4);
  });

  test("a download shorter than 4 bytes is reported, not thrown", () => {
    expect(extractRecording(Buffer.from("OK"))).toEqual({
      ok: false,
      kind: "unknown",
      detail: "unrecognised 2-byte response",
    });
  });
});
