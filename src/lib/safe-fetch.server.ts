// Fetch a URL that came from the DATABASE (and so, ultimately, from a user) without letting it
// point the server at our own network. call_logs.recording_url is writable by any agent, and
// Call Audit fetches it server-side — without this, an agent could aim that fetch at Railway's
// internal network or a cloud metadata address (169.254.169.254) and have the server read it.
//
// Rules: https only, no credentials in the URL, every resolved address must be public, redirects
// are refused (a public host can 302 to an internal one), and the body is size-capped.
// Residual risk: a DNS-rebinding host can answer differently between the check and the fetch.
// Closing that needs a pinned-IP agent; not worth the complexity at this threat level.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224 // multicast + reserved
  );
}

function isPrivateV6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) {
    // IPv4-mapped. The URL parser normalises ::ffff:127.0.0.1 to the hex form ::ffff:7f00:1, so
    // both spellings have to be understood or the mapped form is a way around the v4 check.
    const rest = v.slice(7);
    if (rest.includes(".")) return isPrivateV4(rest);
    const [hi, lo] = rest.split(":").map((h) => parseInt(h, 16));
    if (Number.isNaN(hi) || Number.isNaN(lo)) return true;
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return (
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("fe8") ||
    v.startsWith("fe9") ||
    v.startsWith("fea") ||
    v.startsWith("feb") ||
    v.startsWith("ff")
  );
}

function isPrivateAddress(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateV6(ip) : isPrivateV4(ip);
}

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The recording URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("The recording URL must use https");
  if (url.username || url.password) throw new Error("The recording URL must not embed credentials");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error("Could not resolve the recording host");
      });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error("The recording URL points at a non-public address");
  }
  return url;
}

export async function fetchPublicBlob(raw: string, maxBytes = 50 * 1024 * 1024): Promise<Blob> {
  const url = await assertPublicHttpsUrl(raw);
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (res.status >= 300 && res.status < 400)
    throw new Error("The recording URL redirected — refusing to follow it");
  if (!res.ok) throw new Error(`Could not fetch recording: ${res.statusText}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("The recording is too large to analyse");
  const blob = await res.blob();
  if (blob.size > maxBytes) throw new Error("The recording is too large to analyse");
  return blob;
}
