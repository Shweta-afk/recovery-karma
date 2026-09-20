// Browser SIP endpoint over WebRTC, built on SIP.js. This is what lets an agent place and
// receive calls from inside SamvadX with NO desktop softphone — the Phase-2 goal for the
// SkyCRM integration. It registers the agent's extension against the vendor's SIP-over-WSS
// server, sends/receives INVITEs, and wires the remote audio to an <audio> element.
//
// Framework-agnostic on purpose (no React) so it can be unit-reasoned and driven by the
// `use-webphone.ts` hook. Client-only: imports the browser WebRTC + SIP.js stack.
//
// STATUS: written against SIP.js 0.21.x from its docs; UNVERIFIED against the vendor's WebRTC
// server, which isn't enabled yet (no WSS endpoint supplied). Expect the usual live-account
// surprises — transport params, auth realm, whether the server sends early media, ICE/TURN
// needs. Keep the vendor's WebRTC quirks isolated to this file.

import {
  Inviter,
  Invitation,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  type Session,
  type UserAgentOptions,
} from "sip.js";
import type { WebphoneConfig } from "./config";

/** Coarse lifecycle the UI cares about — deliberately parallels the app's CallState vocabulary
 * (see ../types.ts) so the webphone and the REST/sim paths present the same phases. */
export type WebphoneRegState = "unregistered" | "registering" | "registered" | "failed";
export type WebphoneCallState =
  | "idle"
  | "connecting" // outbound INVITE sent, awaiting answer
  | "ringing" // inbound INVITE received, not yet answered
  | "connected"
  | "held"
  | "ended";

export interface WebphoneCall {
  /** SIP Call-ID — correlates to the vendor's `callid` in webhooks/CDR. */
  id: string;
  direction: "outbound" | "inbound";
  /** Far-end number/URI (debtor for outbound, caller for inbound). */
  remote: string;
  state: WebphoneCallState;
  muted: boolean;
  startedAt: number;
  connectedAt?: number;
}

export interface WebphoneEvents {
  onRegState?: (state: WebphoneRegState, detail?: string) => void;
  onCall?: (call: WebphoneCall | null) => void;
  /** Fired on transport connect/disconnect so the UI can show "reconnecting". */
  onTransport?: (connected: boolean) => void;
  onError?: (message: string) => void;
}

/** One browser SIP endpoint. Create → connect() → register(); then call()/answer()/hangup().
 * Single active call at a time (click-to-call model); extend to a Map for multi-line later. */
export class SipWebphone {
  private ua: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private session: Session | null = null;
  private call: WebphoneCall | null = null;
  private readonly remoteAudio: HTMLAudioElement;

  constructor(
    private readonly config: WebphoneConfig,
    private readonly events: WebphoneEvents = {},
    /** The <audio> element the far-end stream is attached to. The hook supplies a real element;
     * a detached one is created if omitted (audio still plays — it need not be in the DOM). */
    remoteAudioEl?: HTMLAudioElement,
  ) {
    this.remoteAudio =
      remoteAudioEl ??
      (typeof document !== "undefined"
        ? document.createElement("audio")
        : ({} as HTMLAudioElement));
    this.remoteAudio.autoplay = true;
  }

  // ─── Connection + registration ───────────────────────────────────────────────

  async connect(): Promise<void> {
    const uri = UserAgent.makeURI(`sip:${this.config.extension}@${this.config.domain}`);
    if (!uri) throw new Error(`Invalid SIP URI for extension ${this.config.extension}`);

    const options: UserAgentOptions = {
      uri,
      displayName: this.config.displayName,
      authorizationUsername: this.config.extension,
      authorizationPassword: this.config.password,
      transportOptions: { server: this.config.wssUrl },
      // Media: browser mic → far end, far-end audio → our <audio>. No video.
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: { iceServers: this.config.iceServers },
        constraints: { audio: true, video: false },
      },
    };

    this.ua = new UserAgent(options);

    // Surface transport up/down so the UI can show a reconnecting state rather than a dead call.
    this.ua.transport.stateChange.addListener((state) => {
      this.events.onTransport?.(String(state) === "Connected");
    });

    // Inbound calls arrive as delegate.onInvite.
    this.ua.delegate = {
      onInvite: (invitation: Invitation) => this.handleInboundInvite(invitation),
    };

    await this.ua.start(); // opens the WebSocket
  }

  async register(): Promise<void> {
    if (!this.ua) throw new Error("connect() must be called before register()");
    this.registerer = new Registerer(this.ua);
    this.registerer.stateChange.addListener((state) => {
      switch (state) {
        case RegistererState.Registered:
          this.events.onRegState?.("registered");
          break;
        case RegistererState.Unregistered:
          this.events.onRegState?.("unregistered");
          break;
        case RegistererState.Terminated:
          this.events.onRegState?.("failed", "Registration terminated");
          break;
      }
    });
    this.events.onRegState?.("registering");
    try {
      await this.registerer.register();
    } catch (err) {
      this.events.onRegState?.("failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // ─── Outbound ─────────────────────────────────────────────────────────────────

  /** Place a call to `target` (a bare number/extension — the domain is appended). Rejects if a
   * call is already active (single-line). */
  async dial(target: string): Promise<void> {
    if (!this.ua) throw new Error("Webphone is not connected");
    if (this.session) throw new Error("A call is already in progress");

    const targetUri = UserAgent.makeURI(`sip:${target}@${this.config.domain}`);
    if (!targetUri) throw new Error(`Invalid dial target: ${target}`);

    const inviter = new Inviter(this.ua, targetUri, {
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    this.session = inviter;
    this.setCall({
      id: inviter.request.callId ?? `out-${Date.now()}`,
      direction: "outbound",
      remote: target,
      state: "connecting",
      muted: false,
      startedAt: Date.now(),
    });
    this.wireSession(inviter);

    try {
      await inviter.invite();
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : String(err));
      this.teardownCall("ended");
    }
  }

  // ─── Inbound ────────────────────────────────────────────────────────────────────

  private handleInboundInvite(invitation: Invitation): void {
    if (this.session) {
      // Already on a call — reject the second with "busy".
      void invitation.reject({ statusCode: 486 });
      return;
    }
    this.session = invitation;
    const remote =
      invitation.remoteIdentity.uri.user ?? invitation.remoteIdentity.displayName ?? "unknown";
    this.setCall({
      id: invitation.request.callId ?? `in-${Date.now()}`,
      direction: "inbound",
      remote,
      state: "ringing",
      muted: false,
      startedAt: Date.now(),
    });
    this.wireSession(invitation);
  }

  /** Answer the current inbound (ringing) call. */
  async answer(): Promise<void> {
    if (!this.session || !(this.session instanceof Invitation)) {
      throw new Error("No inbound call to answer");
    }
    await this.session.accept({
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
  }

  // ─── Controls ───────────────────────────────────────────────────────────────────

  /** End / cancel / decline the current call, whatever its state. */
  async hangup(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      switch (s.state) {
        case SessionState.Initial:
        case SessionState.Establishing:
          // Outbound not yet answered → cancel; inbound not yet answered → reject.
          if (s instanceof Inviter) await s.cancel();
          else if (s instanceof Invitation) await s.reject();
          break;
        case SessionState.Established:
          await s.bye();
          break;
        // Terminating/Terminated: nothing to do.
      }
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.teardownCall("ended");
    }
  }

  /** Mute/unmute the local mic by toggling the outbound audio track(s). */
  setMuted(muted: boolean): void {
    const pc = this.peerConnection();
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === "audio") sender.track.enabled = !muted;
    }
    if (this.call) this.setCall({ ...this.call, muted });
  }

  /** DTMF keypad during a live call (IVR navigation, extension transfer). */
  sendDtmf(tones: string): void {
    const pc = this.peerConnection();
    const sender = pc?.getSenders().find((s) => s.track?.kind === "audio");
    sender?.dtmf?.insertDTMF(tones);
  }

  async disconnect(): Promise<void> {
    try {
      await this.hangup();
      await this.registerer?.unregister();
      await this.ua?.stop();
    } catch {
      /* best-effort teardown */
    } finally {
      this.registerer = null;
      this.ua = null;
      this.session = null;
      this.setCall(null);
    }
  }

  getCall(): WebphoneCall | null {
    return this.call;
  }

  // ─── Internals ────────────────────────────────────────────────────────────────

  private wireSession(session: Session): void {
    session.stateChange.addListener((state) => {
      switch (state) {
        case SessionState.Establishing:
          if (this.call?.direction === "outbound") this.updateCallState("connecting");
          break;
        case SessionState.Established:
          this.attachRemoteMedia(session);
          this.updateCallState("connected", { connectedAt: Date.now() });
          break;
        case SessionState.Terminated:
          this.teardownCall("ended");
          break;
      }
    });
  }

  /** Pull the far-end audio track off the peer connection into the <audio> element. */
  private attachRemoteMedia(session: Session): void {
    const pc = this.peerConnectionOf(session);
    if (!pc) return;
    const remoteStream = new MediaStream();
    for (const receiver of pc.getReceivers()) {
      if (receiver.track) remoteStream.addTrack(receiver.track);
    }
    this.remoteAudio.srcObject = remoteStream;
    void this.remoteAudio.play().catch(() => {
      // Autoplay can be blocked until a user gesture — the hook plays on the answer/dial click.
    });
  }

  private peerConnection(): RTCPeerConnection | null {
    return this.session ? this.peerConnectionOf(this.session) : null;
  }

  private peerConnectionOf(session: Session): RTCPeerConnection | null {
    // SIP.js stashes the RTCPeerConnection on the SessionDescriptionHandler.
    const sdh = session.sessionDescriptionHandler as
      | { peerConnection?: RTCPeerConnection }
      | undefined;
    return sdh?.peerConnection ?? null;
  }

  private updateCallState(state: WebphoneCallState, patch?: Partial<WebphoneCall>): void {
    if (!this.call) return;
    this.setCall({ ...this.call, state, ...patch });
  }

  private teardownCall(finalState: WebphoneCallState): void {
    if (this.call) this.setCall({ ...this.call, state: finalState });
    this.session = null;
    if (this.remoteAudio && "srcObject" in this.remoteAudio) this.remoteAudio.srcObject = null;
    // Let the UI observe the terminal state, then clear.
    this.setCall(null);
  }

  private setCall(call: WebphoneCall | null): void {
    this.call = call;
    this.events.onCall?.(call);
  }
}
