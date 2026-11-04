// Standalone WebRTC webphone test panel — mounts the browser SIP endpoint, shows registration
// + call status, and lets you dial/answer/hangup/mute. This is the isolated harness for
// validating SkyCRM's WebRTC (SIP-over-WebSocket) once the vendor enables it and sends the WSS
// endpoint; it is not the production dialer UI (that integration comes after this proves out).
//
// Until the env is configured it renders a clear "not configured" card listing exactly what's
// missing, so it is safe to ship and to open before the vendor replies.

import { useEffect, useState } from "react";
import { Phone, PhoneOff, PhoneIncoming, Mic, MicOff, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useWebphone } from "@/lib/dialer/use-webphone";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { getMyWebphoneLogin, type WebphoneLogin } from "@/lib/telephony-actions.server";
import type { WebphoneConfig } from "@/lib/telephony/webrtc/config";

const REG_LABEL: Record<string, { text: string; className: string }> = {
  unregistered: { text: "Unregistered", className: "bg-muted text-muted-foreground" },
  registering: { text: "Registering…", className: "bg-amber-100 text-amber-800" },
  registered: { text: "Registered", className: "bg-emerald-100 text-emerald-800" },
  failed: { text: "Failed", className: "bg-red-100 text-red-800" },
};

const NO_LOGIN: Record<string, string> = {
  provider: "Calling on the server is not SkyCRM (TELEPHONY_PROVIDER).",
  not_enabled: "Calling is not enabled for your company (Superadmin → Calling tab).",
  no_extension: "You have no extension (Superadmin → company → Calling tab → Extensions).",
  not_configured:
    "SKYCRM_WSS_URL / SKYCRM_SIP_DOMAIN / SKYCRM_SIP_PASSWORD are not set on the server.",
};

/** Test harness: signs in with the CURRENT user's own extension, from the server, exactly like
 *  the browser phone in the app (browser-phone.tsx). No password lives in the browser bundle. */
export function WebphonePanel() {
  const [login, setLogin] = useState<WebphoneLogin | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        setLogin(await getMyWebphoneLogin({ data: { accessToken: await getAccessToken() } }));
      } catch {
        setLogin({ login: null, reason: "not_configured" });
      }
    })();
  }, []);
  if (!login) return null;
  if (!login.login) {
    return (
      <div className="mx-auto max-w-lg rounded-lg border bg-card p-6 text-card-foreground">
        <h2 className="text-lg font-semibold">Webphone not available</h2>
        <p className="mt-2 text-sm text-muted-foreground">{NO_LOGIN[login.reason]}</p>
      </div>
    );
  }
  return <Phone2 config={login.login} />;
}

function Phone2({ config }: { config: WebphoneConfig }) {
  const wp = useWebphone(config);
  const [target, setTarget] = useState("");
  const [muted, setMuted] = useState(false);

  const reg = REG_LABEL[wp.regState] ?? REG_LABEL.unregistered;
  const call = wp.call;
  const inCall = call !== null && call.state !== "ended";

  return (
    <div className="mx-auto max-w-lg space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
      {/* Hidden element that carries the far-end audio. */}
      <audio ref={wp.audioRef} autoPlay hidden />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">WebRTC Webphone</h2>
        <div className="flex items-center gap-2">
          <Badge className={reg.className}>{reg.text}</Badge>
          <span title={wp.transportUp ? "Transport connected" : "Transport down"}>
            {wp.transportUp ? (
              <Wifi className="h-4 w-4 text-emerald-600" />
            ) : (
              <WifiOff className="h-4 w-4 text-muted-foreground" />
            )}
          </span>
        </div>
      </div>

      {wp.regDetail && <p className="text-xs text-muted-foreground">{wp.regDetail}</p>}
      {wp.error && (
        <p className="rounded bg-red-50 p-2 text-xs text-red-700" role="alert">
          {errorText(wp.error, "The phone could not connect")}
        </p>
      )}

      {/* Connection controls */}
      <div className="flex gap-2">
        <Button
          onClick={() => void wp.connect()}
          disabled={wp.regState === "registered" || wp.regState === "registering"}
          variant="secondary"
        >
          Connect &amp; Register
        </Button>
        <Button onClick={() => void wp.disconnect()} variant="outline">
          Disconnect
        </Button>
      </div>

      {/* Dialer */}
      {!inCall && (
        <div className="flex gap-2">
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="number or extension to dial"
            disabled={wp.regState !== "registered"}
          />
          <Button
            onClick={() => void wp.dial(target.trim())}
            disabled={wp.regState !== "registered" || !target.trim()}
          >
            <Phone className="mr-1 h-4 w-4" /> Call
          </Button>
        </div>
      )}

      {/* Active call */}
      {call && (
        <div className="rounded-md border bg-muted/40 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">
                {call.direction === "inbound" ? "Incoming" : "Calling"}: {call.remote}
              </p>
              <p className="text-xs capitalize text-muted-foreground">{call.state}</p>
            </div>
            <div className="flex gap-2">
              {call.direction === "inbound" && call.state === "ringing" && (
                <Button
                  onClick={() => void wp.answer()}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  <PhoneIncoming className="mr-1 h-4 w-4" /> Answer
                </Button>
              )}
              {call.state === "connected" && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const next = !muted;
                    setMuted(next);
                    wp.setMuted(next);
                  }}
                >
                  {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
              )}
              <Button variant="destructive" onClick={() => void wp.hangup()}>
                <PhoneOff className="mr-1 h-4 w-4" /> Hang up
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
