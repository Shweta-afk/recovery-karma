// TURN relay logins for the browser phone (2026-11-04, "option B": browsers talk WebRTC to
// SkyCRM's own WebRTC endpoint, wss://10.173.16.10:8089/ws, through our gateway).
//
// SkyCRM's call system sits on a private network, so its ICE candidates (10.173.16.x) are
// unreachable from an agent's browser. The coturn relay on our gateway (infra/sip-gateway,
// turnserver.conf.example) takes the browser's audio on its public address and relays it from
// our tunnel address (10.250.10.1) into the IPsec tunnel. Browsers are forced to use it
// (iceTransportPolicy "relay") — every other candidate would only waste ICE time.
//
// Credentials are coturn's "REST API" kind (use-auth-secret): username = "<expiry>:<extension>",
// password = base64(HMAC-SHA1(TURN_SECRET, username)). They expire on their own, so nothing has
// to be stored or revoked, and TURN_SECRET never leaves the server.
import { createHmac } from "node:crypto";

export interface TurnLogin {
  iceServers: { urls: string[]; username: string; credential: string }[];
  iceTransportPolicy: "relay";
}

/** How long a relay login stays valid. A login is fetched each time the phone connects. */
export const TURN_TTL_SECONDS = 12 * 3600;

/** A relay login for `extension`, or null when TURN isn't configured (TURN_SECRET + TURN_URLS). */
export function turnLogin(
  extension: string,
  env: { secret?: string; urls?: string },
  nowMs = Date.now(),
): TurnLogin | null {
  const secret = env.secret?.trim();
  const urls = (env.urls ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^turns?:/.test(u));
  if (!secret || urls.length === 0) return null;
  const username = `${Math.floor(nowMs / 1000) + TURN_TTL_SECONDS}:${extension}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { iceServers: [{ urls, username, credential }], iceTransportPolicy: "relay" };
}
