// TURN relay logins for the browser phone (src/lib/telephony/webrtc/turn-credentials.server.ts).
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { TURN_TTL_SECONDS, turnLogin } from "../src/lib/telephony/webrtc/turn-credentials.server";

describe("turnLogin", () => {
  test("off until both the secret and a turn: URL are set", () => {
    expect(turnLogin("8608", {})).toBeNull();
    expect(turnLogin("8608", { secret: "s" })).toBeNull();
    expect(turnLogin("8608", { urls: "turn:voice.samvadx.com:3478" })).toBeNull();
    expect(turnLogin("8608", { secret: "s", urls: "https://voice.samvadx.com" })).toBeNull();
  });

  test("coturn REST credentials: expiry:extension, HMAC-SHA1 of the secret, relay only", () => {
    const now = Date.UTC(2026, 10, 4, 8, 0, 0);
    const t = turnLogin(
      "8608",
      {
        secret: "top-secret",
        urls: " turn:voice.samvadx.com:3478?transport=udp , turns:voice.samvadx.com:5349 ",
      },
      now,
    )!;
    const username = `${now / 1000 + TURN_TTL_SECONDS}:8608`;
    expect(t.iceTransportPolicy).toBe("relay");
    expect(t.iceServers).toEqual([
      {
        urls: ["turn:voice.samvadx.com:3478?transport=udp", "turns:voice.samvadx.com:5349"],
        username,
        credential: createHmac("sha1", "top-secret").update(username).digest("base64"),
      },
    ]);
  });
});
