// WebRTC (SIP-over-WebSocket) connection config for the browser webphone.
//
// This is the Phase-2 path agreed with SkyCRM: agents call from inside SamvadX in the browser
// via SIP.js, with NO desktop softphone (X-Lite/Zoiper). The REST adapter (../skycrm-provider.ts)
// is the softphone-era POC; this is what replaces the softphone once the vendor enables WebRTC.
//
// ─── NOT YET LIVE ──────────────────────────────────────────────────────────────
// The vendor (Intellect Info Trade / SkyCRM) has offered to enable a WebRTC setting for the
// extension but has NOT yet supplied the WebSocket (WSS) endpoint. Until VITE_SKYCRM_WSS_URL is
// set, `isWebphoneConfigured()` is false and the UI shows a "not configured" state instead of
// trying to connect. Fill these in the moment the vendor sends the WSS URL + confirms creds.
//
// ─── SECURITY NOTE ───────────────────────────────────────────────────────────────
// A SIP password shipped in VITE_* env is baked into the CLIENT bundle — fine for a POC against
// a test extension, NOT for production. Before go-live, mint short-lived per-agent SIP
// credentials server-side (a `*.server.ts` action) and hand them to the browser at register
// time, exactly as we mint the REST JWT per call. Do not ship a real shared SIP password.

const viteEnv = (key: string): string | undefined => {
  // import.meta.env is the Vite client-side env; guard so this module is import-safe on the
  // server (Nitro) too, where import.meta.env may be undefined.
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[key];
  } catch {
    return undefined;
  }
};

export interface WebphoneConfig {
  /** SIP-over-WebSocket URL the browser connects to, e.g. "wss://10.173.16.10:7443" or a
   * public "wss://webrtc.skycrm.app". PROVIDED BY THE VENDOR — the one thing still missing. */
  wssUrl: string;
  /** SIP domain/realm for the AOR — the registrar host, e.g. "10.173.16.10". Usually the same
   * host as the softphone domain (without the SIP port). */
  domain: string;
  /** The extension registering from the browser (the agent's SIP user), e.g. "8597". */
  extension: string;
  /** SIP auth password for the extension. See SECURITY NOTE above — POC only in client env. */
  password: string;
  /** Optional display name shown to the far end. */
  displayName?: string;
  /** ICE servers for NAT traversal (STUN/TURN). Whether TURN is required depends on the
   * vendor's network — ask them. Parsed from VITE_SKYCRM_ICE_SERVERS as JSON, else empty. */
  iceServers: RTCIceServer[];
}

function parseIceServers(raw: string | undefined): RTCIceServer[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RTCIceServer[]) : [];
  } catch {
    // A STUN-only convenience form: a comma-separated list of urls.
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((urls) => ({ urls }));
  }
}

/** Reads the webphone config from Vite env. Returns null when the WSS URL is not set — i.e.
 * the vendor hasn't given us the endpoint yet — so callers can render a clear "not configured"
 * state rather than attempting a doomed connection. */
export function getWebphoneConfig(): WebphoneConfig | null {
  const wssUrl = viteEnv("VITE_SKYCRM_WSS_URL");
  const extension = viteEnv("VITE_SKYCRM_SIP_EXTENSION");
  const password = viteEnv("VITE_SKYCRM_SIP_PASSWORD");
  const domain = viteEnv("VITE_SKYCRM_SIP_DOMAIN") ?? viteEnv("VITE_SKYCRM_SIP_EXTENSION_DOMAIN");
  if (!wssUrl || !extension || !password || !domain) return null;
  return {
    wssUrl,
    domain,
    extension,
    password,
    displayName: viteEnv("VITE_SKYCRM_SIP_DISPLAY_NAME") ?? extension,
    iceServers: parseIceServers(viteEnv("VITE_SKYCRM_ICE_SERVERS")),
  };
}

export function isWebphoneConfigured(): boolean {
  return getWebphoneConfig() !== null;
}
