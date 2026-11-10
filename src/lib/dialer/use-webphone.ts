// React binding for the browser SIP webphone (../telephony/webrtc/sip-webphone.ts).
//
// Owns one SipWebphone instance for the component tree, mirrors its registration/call state
// into React state, and exposes connect/dial/answer/hangup/mute controls. Client-only.
//
// The login comes from the server (getMyWebphoneLogin); with null, `configured` is false and the
// controls no-op.

import { useCallback, useEffect, useRef, useState } from "react";
import type { WebphoneConfig } from "@/lib/telephony/webrtc/config";
import { getAccessToken } from "@/lib/access-token";
import { markAgentEndedCall } from "@/lib/telephony-actions.server";
import {
  SipWebphone,
  type WebphoneCall,
  type WebphoneRegState,
} from "@/lib/telephony/webrtc/sip-webphone";

export interface UseWebphone {
  configured: boolean;
  regState: WebphoneRegState;
  regDetail?: string;
  transportUp: boolean;
  call: WebphoneCall | null;
  error?: string;
  /** Attach the <audio> element that plays the far-end audio. Pass a ref callback to an <audio>. */
  audioRef: (el: HTMLAudioElement | null) => void;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  dial: (target: string) => Promise<void>;
  answer: () => Promise<void>;
  hangup: () => Promise<void>;
  endByAgent: () => Promise<void>;
  setMuted: (muted: boolean) => void;
}

/** `config` comes from the server: the signed-in user's own extension (getMyWebphoneLogin). */
export function useWebphone(config: WebphoneConfig | null): UseWebphone {
  const configured = config !== null;

  const [regState, setRegState] = useState<WebphoneRegState>("unregistered");
  const [regDetail, setRegDetail] = useState<string | undefined>();
  const [transportUp, setTransportUp] = useState(false);
  const [call, setCall] = useState<WebphoneCall | null>(null);
  const [error, setError] = useState<string | undefined>();

  const phoneRef = useRef<SipWebphone | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const audioRef = useCallback((el: HTMLAudioElement | null) => {
    audioElRef.current = el;
  }, []);

  const connect = useCallback(async () => {
    if (!config) {
      setError("Webphone is not configured.");
      return;
    }
    if (phoneRef.current) return; // already connected
    setError(undefined);
    const phone = new SipWebphone(
      config,
      {
        onRegState: (s, detail) => {
          setRegState(s);
          setRegDetail(detail);
        },
        onCall: (c) => setCall(c),
        onTransport: (up) => setTransportUp(up),
        onError: (msg) => setError(msg),
      },
      audioElRef.current ?? undefined,
    );
    phoneRef.current = phone;
    try {
      await phone.connect();
      await phone.register();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [config]);

  const disconnect = useCallback(async () => {
    await phoneRef.current?.disconnect();
    phoneRef.current = null;
    setRegState("unregistered");
    setTransportUp(false);
    setCall(null);
  }, []);

  const dial = useCallback(async (target: string) => {
    setError(undefined);
    try {
      await phoneRef.current?.dial(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const answer = useCallback(async () => {
    try {
      await phoneRef.current?.answer();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const hangup = useCallback(async () => {
    await phoneRef.current?.hangup();
  }, []);

  /** The agent's own End press, as against the phone dropping the leg for any other reason. */
  const endByAgent = useCallback(async () => {
    void getAccessToken()
      .then((accessToken) => markAgentEndedCall({ data: { accessToken } }))
      .catch(() => undefined);
    await phoneRef.current?.hangup();
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    phoneRef.current?.setMuted(muted);
  }, []);

  // Tear down on unmount so the WebSocket/registration don't leak across navigations.
  useEffect(() => {
    return () => {
      void phoneRef.current?.disconnect();
      phoneRef.current = null;
    };
  }, []);

  return {
    configured,
    regState,
    regDetail,
    transportUp,
    call,
    error,
    audioRef,
    connect,
    disconnect,
    dial,
    answer,
    hangup,
    endByAgent,
    setMuted,
  };
}
