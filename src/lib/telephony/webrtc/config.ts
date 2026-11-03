// Login for the browser phone (SIP over WebSocket). It always comes from the server —
// getMyWebphoneLogin in telephony-actions.server.ts hands each signed-in user their OWN extension,
// and only while calling is on for their company. Never read it from VITE_* env: Vite bakes
// those into the browser bundle for everyone (it happened once in a local build, 2026-11-03).
//
// The browser connects to our gateway (wss://voice.samvadx.com/ws, infra/sip-gateway), which
// carries SIP and audio to SkyCRM over the IPsec tunnel.

export interface WebphoneConfig {
  /** Our gateway's WebSocket, e.g. "wss://voice.samvadx.com/ws". */
  wssUrl: string;
  /** SIP domain/realm for the AOR — the registrar host, e.g. "10.173.16.10". Usually the same
   * host as the softphone domain (without the SIP port). */
  domain: string;
  /** The extension registering from the browser (the agent's SIP user), e.g. "8597". */
  extension: string;
  /** SIP auth password for the extension, from the server, held in memory only. */
  password: string;
  /** Optional display name shown to the far end. */
  displayName?: string;
  /** ICE servers (STUN/TURN). Empty: rtpengine on the gateway offers its public address. */
  iceServers: RTCIceServer[];
}
