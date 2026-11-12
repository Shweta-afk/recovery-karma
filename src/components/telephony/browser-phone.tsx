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
import { Phone, PhoneIncoming, PhoneOff, Mic, MicOff, RefreshCw, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { getAccessToken } from "@/lib/access-token";
import { useWebphone } from "@/lib/dialer/use-webphone";
import type { WebphoneConfig } from "@/lib/telephony/webrtc/config";
import { getMyWebphoneLogin, logMissedInbound } from "@/lib/telephony-actions.server";
import { useNavigate } from "@tanstack/react-router";
import { setPhoneState } from "@/lib/telephony/phone-status";
import { startAnswerDetector } from "@/lib/telephony/answer-detector";
import { useCallSession } from "@/lib/call-session";
import {
  askNotificationPermission,
  inboundDebtor,
  useCallerInfo,
  useRingtone,
} from "./incoming-call";

/** Fired by use-single-call.ts when the agent places a call; SkyCRM rings us right after. */
export const DIAL_STARTED_EVENT = "samvadx:dial-started";
/** Fired by use-single-call.ts when the agent ends a call anywhere in the app (End Call, Cancel,
 *  the floating bar). The browser phone drops its own leg too. */
export const HANG_UP_EVENT = "samvadx:hang-up";
/** Fired by this phone when a call it had answered ends (either side hung up, or its own End
 *  button). call-session.tsx then ends the app's call and asks SkyCRM to drop the borrower. */
export const PHONE_CALL_ENDED_EVENT = "samvadx:phone-call-ended";
/** How long after clicking Call a ring from SkyCRM counts as that call's agent leg. */
const AUTO_ANSWER_WINDOW_MS = 60_000;

/** How often the phone re-reads its login from the server while idle. */
const LOGIN_RECHECK_MS = 2 * 60_000;
/** Renew the login (and its TURN relay credentials, valid 12 h) after this long anyway. */
const LOGIN_RENEW_MS = 6 * 3600_000;

/** What decides where and how the phone registers. A change means reconnecting; TURN usernames
 *  and passwords change on every fetch, so only the relay URLs count. */
function loginKey(c: WebphoneConfig): string {
  return JSON.stringify([
    c.wssUrl,
    c.domain,
    c.extension,
    c.password,
    c.iceTransportPolicy ?? "",
    c.iceServers.map((s) => s.urls),
  ]);
}

/** "gateway" (our Kamailio, wss://…/ws) or "SkyCRM WebRTC" (wss://…/skycrm-ws), for the badge. */
function routeLabel(c: WebphoneConfig): string {
  return /\/skycrm-ws\b/.test(c.wssUrl) ? "SkyCRM WebRTC" : "gateway";
}

export function BrowserPhone() {
  const { user } = useAuth();
  const [config, setConfig] = useState<WebphoneConfig | null>(null);
  const current = useRef<{ key: string; at: number } | null>(null);
  const busy = useRef(false);

  // The phone follows the server's settings by itself. Until 2026-11-04 it read its login only
  // when the page loaded, so switching routes on Railway left every open page on the old route
  // until someone reloaded it — and those pages kept taking SkyCRM's rings and never answered.
  // Now it re-reads every couple of minutes (and when the tab comes back) and reconnects when
  // anything that matters changed. Never in the middle of a call.
  useEffect(() => {
    if (!user || user.role === "superadmin") return;
    let cancelled = false;
    const load = async () => {
      if (busy.current) return;
      try {
        const res = await getMyWebphoneLogin({ data: { accessToken: await getAccessToken() } });
        if (cancelled || busy.current) return;
        if (!res.login) {
          if (current.current) {
            current.current = null;
            setConfig(null);
          }
          return;
        }
        const key = loginKey(res.login);
        const stale = current.current && Date.now() - current.current.at > LOGIN_RENEW_MS;
        if (!current.current || current.current.key !== key || stale) {
          current.current = { key, at: Date.now() };
          setConfig(res.login);
        }
      } catch (err) {
        console.warn("[browser-phone] no login:", err instanceof Error ? err.message : err);
      }
    };
    void load();
    const t = setInterval(() => void load(), LOGIN_RECHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [user]);

  if (!config) return null;
  // A new key mounts a fresh phone; the old one unregisters as it unmounts, so SkyCRM forgets
  // the old route at once instead of ringing it for up to ten minutes.
  return (
    <RegisteredPhone
      key={current.current ? `${current.current.key}@${current.current.at}` : ""}
      config={config}
      onBusy={(b) => {
        busy.current = b;
      }}
    />
  );
}

function RegisteredPhone({
  config,
  onBusy,
}: {
  config: WebphoneConfig;
  onBusy: (busy: boolean) => void;
}) {
  const wp = useWebphone(config);
  const lastDialAt = useRef(0);
  const [now, setNow] = useState(Date.now());
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const setAudioEl = useCallback(
    (el: HTMLAudioElement | null) => {
      audioEl.current = el;
      wp.audioRef(el);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wp.audioRef],
  );

  // Browsers only let a page play sound after a click on it. The call is answered by itself a few
  // seconds after the agent clicks Call (no click at that moment), so without this most agents'
  // browsers silently blocked the far end: no ringback, no voice, while the call was connected and
  // the audio was arriving (2026-11-04). Playing an empty stream inside a click unlocks the
  // <audio> element; the call's stream later plays through it.
  const unlockAudio = useCallback(() => {
    const el = audioEl.current;
    if (!el || !el.paused) return;
    if (!el.srcObject) el.srcObject = new MediaStream();
    void el.play().catch(() => {});
  }, []);

  useEffect(() => {
    const onGesture = () => unlockAudio();
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
    return () => {
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }, [unlockAudio]);

  const playCallAudio = () => {
    const el = audioEl.current;
    if (!el) return;
    void el
      .play()
      .then(() => setAudioBlocked(false))
      .catch(() => setAudioBlocked(true));
  };

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
      unlockAudio(); // still inside the agent's click on Call
    };
    window.addEventListener(DIAL_STARTED_EVENT, onDial);
    return () => window.removeEventListener(DIAL_STARTED_EVENT, onDial);
  }, [unlockAudio]);

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

  // End Call in the app used to ask only SkyCRM's API to hang up. This phone — the agent's half
  // of the call — stayed connected, and when SkyCRM's hang-up didn't land the borrower stayed on
  // the line while the agent's screen said "ended" (2026-11-05). Now the app's End drops this
  // leg as well.
  useEffect(() => {
    const onHangUp = () => void wp.hangup();
    window.addEventListener(HANG_UP_EVENT, onHangUp);
    return () => window.removeEventListener(HANG_UP_EVENT, onHangUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wp.hangup]);

  // And the other way: once a call this phone answered is over, tell the app.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (call?.state === "connected") {
      wasConnected.current = true;
      return;
    }
    if (!call && wasConnected.current) {
      wasConnected.current = false;
      window.dispatchEvent(new CustomEvent(PHONE_CALL_ENDED_EVENT));
    }
  }, [call, call?.state]);

  // If the browser still refused to play the call's audio, say so and offer a button: one click
  // is all it needs.
  useEffect(() => {
    if (call?.state !== "connected") {
      setAudioBlocked(false);
      return;
    }
    const t = setTimeout(() => {
      if (audioEl.current?.paused) playCallAudio();
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.state, call?.id]);

  // Tell the parent not to swap the phone out while a call exists.
  useEffect(() => {
    onBusy(call !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call !== null]);

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
  // Shared with the dialer, which waits for this before asking SkyCRM to ring the phone.
  useEffect(() => {
    setPhoneState(ready ? "ready" : "connecting");
  }, [ready]);
  useEffect(() => () => setPhoneState("none"), []);

  // Heal by itself after a gateway restart or a network drop: SIP.js does not reconnect a closed
  // WebSocket on its own. Never in the middle of a call.
  useEffect(() => {
    if (ready || wp.regState === "registering" || call) return;
    const t = setTimeout(() => void reconnect(), 10_000);
    return () => clearTimeout(t);
  }, [ready, wp.regState, call, reconnect]);
  const ringing = call?.direction === "inbound" && call.state === "ringing";
  // A ring right after the agent clicked Call is SkyCRM ringing the agent's own leg (answered by
  // itself above); any other ring is a borrower calling in.
  const customerRinging = ringing && Date.now() - lastDialAt.current >= AUTO_ANSWER_WINDOW_MS;
  useRingtone(customerRinging);
  const caller = useCallerInfo(customerRinging ? call?.remote : null);
  const { user: me } = useAuth();
  const session = useCallSession();
  const navigate = useNavigate();

  // A borrower's ring that stopped without being answered: record it as a missed call, so the
  // Missed calls card shows who called and offers Call back.
  const ringSeen = useRef<{ id: string; phone: string; answered: boolean } | null>(null);
  useEffect(() => {
    if (customerRinging && call) {
      if (ringSeen.current?.id !== call.id) {
        ringSeen.current = { id: call.id, phone: call.remote, answered: false };
      }
      return;
    }
    const seen = ringSeen.current;
    if (!seen) return;
    if (call?.id === seen.id && call.state === "connected") {
      seen.answered = true;
      return;
    }
    if (call?.id === seen.id && call.state === "ringing") return;
    ringSeen.current = null;
    if (!seen.answered) {
      void (async () => {
        try {
          await logMissedInbound({
            data: { accessToken: await getAccessToken(), phone: seen.phone },
          });
        } catch (err) {
          console.warn("[browser-phone] missed call not recorded:", err);
        }
      })();
    }
  }, [customerRinging, call?.id, call?.state, call]);

  // The borrower picked up — heard, not reported: SkyCRM sends no "answered" event, so the call
  // screen said Ringing for the whole conversation. While the app's call rings and the agent's
  // leg is up, listen to the far end; speech → show the call as connected (answer-detector.ts).
  const appRinging = session.activeCall?.phase === "ringing";
  const legUp = call?.state === "connected";
  useEffect(() => {
    if (!appRinging || !legUp) return;
    const stream = audioEl.current?.srcObject;
    if (!(stream instanceof MediaStream)) return;
    return startAnswerDetector(stream, () => {
      session.setActiveCall((c) => (c && c.phase === "ringing" ? { ...c, phase: "connected" } : c));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appRinging, legUp, call?.id]);

  const answerIncoming = () => {
    unlockAudio();
    askNotificationPermission();
    void wp.answer();
    if (!call) return;
    // Open the call screen for this borrower so the agent sees the account and saves a
    // disposition when it ends — unless a call is already on screen (never overwrite one).
    if (session.activeCall) return;
    const isAgent = me?.role === "agent";
    session.setActiveCall({
      debtor: inboundDebtor(caller, call.remote),
      dialStartedAt: new Date().toISOString(),
      answeredAt: new Date().toISOString(),
      phase: "connected",
      view: isAgent ? "panel" : "minimized",
      muted: false,
      held: false,
      elapsed: 0,
    });
    if (isAgent && !window.location.pathname.startsWith("/dashboard/call-queue")) {
      void navigate({ to: "/dashboard/call-queue" });
    }
  };
  const live = call?.state === "connected";
  const elapsed =
    live && call?.connectedAt ? Math.max(0, Math.floor((now - call.connectedAt) / 1000)) : 0;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      <audio ref={setAudioEl} autoPlay className="hidden" />

      {live && audioBlocked && (
        <Button size="lg" className="shadow-lg animate-pulse" onClick={playCallAudio}>
          <Volume2 className="mr-2 h-5 w-5" /> Tap to hear the call
        </Button>
      )}

      {ringing && (
        <div className="w-80 rounded-lg border-2 border-primary bg-card p-3 shadow-xl animate-in slide-in-from-bottom-4">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <PhoneIncoming className="h-4 w-4 animate-pulse text-primary" /> Incoming call
          </p>
          {caller.match ? (
            <div className="mt-1">
              <p className="text-base font-semibold text-foreground">{caller.match.debtor.name}</p>
              <p className="text-xs text-muted-foreground">
                Loan {caller.match.row.loanReference ?? "—"} · {caller.match.portfolio.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {caller.phone}
                {caller.count > 1 && ` · ${caller.count} accounts with this number`}
              </p>
            </div>
          ) : (
            <p className="mt-1 text-sm text-foreground">
              {caller.phone ?? call?.remote}
              <span className="block text-xs text-muted-foreground">
                {caller.loading ? "Looking up the borrower…" : "Not a borrower in your accounts"}
              </span>
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="flex-1" onClick={answerIncoming}>
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
            onClick={() => void wp.endByAgent()}
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
            <span className="text-muted-foreground"> · {routeLabel(config)}</span>
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
