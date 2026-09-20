import { test, expect } from "bun:test";
import { assertPublicHttpsUrl } from "../src/lib/safe-fetch.server";

// call_logs.recording_url is user-writable and fetched server-side by Call Audit — every one of
// these must be refused before any request is made.
const REFUSED = [
  "http://8.8.8.8/a.mp3", // not https
  "https://127.0.0.1/a",
  "https://169.254.169.254/latest/meta-data", // cloud metadata
  "https://localhost/a",
  "https://[::1]/a",
  "https://10.0.0.5/a",
  "https://192.168.1.1/a",
  "https://172.16.0.1/a",
  "https://[::ffff:127.0.0.1]/a", // IPv4-mapped IPv6 — normalised to hex by the URL parser
  "https://user:pw@8.8.8.8/a", // embedded credentials
  "https://100.64.0.1/a", // CGNAT
  "https://0.0.0.0/a",
  "not a url",
];

test("safe-fetch: refuses non-public / non-https recording URLs", async () => {
  for (const u of REFUSED) {
    let refused = false;
    try {
      await assertPublicHttpsUrl(u);
    } catch {
      refused = true;
    }
    expect([u, refused]).toEqual([u, true]);
  }
});

test("safe-fetch: accepts a public https address", async () => {
  const url = await assertPublicHttpsUrl("https://8.8.8.8/a.mp3");
  expect(url.hostname).toBe("8.8.8.8");
});
