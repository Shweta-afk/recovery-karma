// The agent's phone, in the browser. Mounted once in the agent and manager layouts, next to
// GlobalCallBar, so it stays registered while moving between pages.
//
// How a call works with SkyCRM: the Call button asks SkyCRM (dialing_phone) to ring the
// agent's extension first, then the borrower. This component IS that extension: it registers
// through our gateway (wss://voice.samvadx.com/ws → IPsec → SkyCRM, infra/sip-gateway) and
// answers SkyCRM's ring by itself when the agent has just clicked Call, so the agent only
// talks. Inbound calls from the queue show an Answer button instead.
//
// Inert unless the server hands back a login (getMyWebphoneLogin): SkyCRM provider, calling on
// for the company, an extension on this user, and the SKYCRM_WSS_URL / _SIP_DOMAIN /
// _SIP_PASSWORD settings on Railway. Without one it renders nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, PhoneIncoming, PhoneOff, Mic, MicOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { getAccessToken } from "@/lib/access-token";
import { useWebphone } from "@/lib/dialer/use-webphone";
import type { WebphoneConfig } from "@/lib/telephony/webrtc/config";
import { getMyWebphoneLogin } from "@/lib/telephony-actions.server";

/** Fired by use-single-call.ts when the agent places a call; SkyCRM rings us right after. */
export const DIAL_STARTED_EVENT = "samvadx:dial-started";
/** How long after clicking Call a ring from SkyCRM counts as that call's agent leg. */
const AUTO_ANSWER_WINDOW_MS = 60_000;

export function BrowserPhone() {
  const { user } = useAuth();
  const [config, setConfig] = useState<WebphoneConfig | null>(null);

  useEffect(() => {
    if (!user || user.role === "superadmin") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getMyWebphoneLogin({ data: { accessToken: await getAccessToken() } });
        if (!cancelled && res.login) setConfig(res.login);
      } catch (err) {
        console.warn("[browser-phone] no login:", err instanceof Error ? err.message : err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!config) return null;
  return <RegisteredPhone config={config} />;
}

function RegisteredPhone({ config }: { config: WebphoneConfig }) {
  const wp = useWebphone(config);
  const lastDialAt = useRef(0);
  const [now, setNow] = useState(Date.now());

  const start = useCallback(async () => {
    // Ask for the microphone up front, so the first call doesn't stall on a permission prompt.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* the answer will ask again and report it */
    }
    await wp.connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wp.connect]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    const onDial = () => {
      lastDialAt.current = Date.now();
    };
    window.addEventListener(DIAL_STARTED_EVENT, onDial);
    return () => window.removeEventListener(DIAL_STARTED_EVENT, onDial);
  }, []);

  // SkyCRM's ring for a call this agent just placed: pick up without asking.
  const call = wp.call;
  useEffect(() => {
    if (
      call?.direction === "inbound" &&
      call.state === "ringing" &&
      Date.now() - lastDialAt.current < AUTO_ANSWER_WINDOW_MS
    ) {
      lastDialAt.current = 0;
      void wp.answer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.id, call?.state]);

  // Call timer.
  useEffect(() => {
    if (call?.state !== "connected") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call?.state]);

  const reconnect = useCallback(async () => {
    await wp.disconnect();
    await start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wp.disconnect, start]);

  const ready = wp.regState === "registered" && wp.transportUp;

  // Heal by itself after a gateway restart or a network drop: SIP.js does not reconnect a closed
  // WebSocket on its own. Never in the middle of a call.
  useEffect(() => {
    if (ready || wp.regState === "registering" || call) return;
    const t = setTimeout(() => void reconnect(), 10_000);
    return () => clearTimeout(t);
  }, [ready, wp.regState, call, reconnect]);
  const ringing = call?.direction === "inbound" && call.state === "ringing";
  const live = call?.state === "connected";
  const elapsed =
    live && call?.connectedAt ? Math.max(0, Math.floor((now - call.connectedAt) / 1000)) : 0;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      <audio ref={wp.audioRef} autoPlay className="hidden" />

      {ringing && (
        <div className="w-72 rounded-lg border bg-card p-3 shadow-lg animate-in slide-in-from-bottom-4">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <PhoneIncoming className="h-4 w-4 text-primary" /> Incoming call
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{call?.remote}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => void wp.answer()}>
              <Phone className="mr-1 h-4 w-4" /> Answer
            </Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => void wp.hangup()}>
              Decline
            </Button>
          </div>
        </div>
      )}

      {live && (
        <div className="flex items-center gap-2 rounded-full border bg-card py-1.5 pl-3 pr-1.5 text-sm shadow-lg">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
          <span className="font-medium tabular-nums">
            On call · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            title={call?.muted ? "Unmute" : "Mute"}
            onClick={() => wp.setMuted(!call?.muted)}
          >
            {call?.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          <Button
            size="icon"
            variant="destructive"
            className="h-7 w-7"
            title="End call"
            onClick={() => void wp.hangup()}
          >
            <PhoneOff className="h-4 w-4" />
          </Button>
        </div>
      )}

      {!ringing && !live && (
        <div
          className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs shadow"
          title={wp.error ?? wp.regDetail ?? undefined}
        >
          <span
            className={`h-2 w-2 rounded-full ${ready ? "bg-emerald-500" : wp.regState === "registering" ? "bg-amber-500" : "bg-destructive"}`}
          />
          <span>
            Phone {config.extension}:{" "}
            {ready ? "ready" : wp.regState === "registering" ? "connecting…" : "not connected"}
          </span>
          {!ready && wp.regState !== "registering" && (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              onClick={() => void reconnect()}
            >
              <RefreshCw className="h-3 w-3" /> Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
