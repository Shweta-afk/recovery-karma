// Screen pop for an inbound call ringing (or answered) on the signed-in agent's extension.
// Polls getIncomingCall while the tab is visible; the server answers poll:false when SkyCRM isn't
// the provider or the user has no extension, and polling stops for the session.
import { useEffect, useRef, useState } from "react";
import { PhoneIncoming } from "lucide-react";
import { getIncomingCall, type IncomingCall } from "@/lib/telephony-actions.server";
import { getAccessToken } from "@/lib/access-token";
import { CopyButton } from "@/components/ui/copy-button";

const POLL_MS = 5000;

export function IncomingCallPopup() {
  const [call, setCall] = useState<IncomingCall | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped.current) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await getIncomingCall({ data: { accessToken: await getAccessToken() } });
          if (!res.poll) {
            stopped.current = true;
            setCall(null);
            return;
          }
          setCall(res.call);
        } catch {
          // Transient network/session errors: keep polling, don't flash the card.
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped.current = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!call) return null;
  const answered = call.status === "connected";
  return (
    <div
      role="status"
      className="fixed right-4 top-4 z-50 w-80 rounded-lg border bg-card p-4 shadow-lg"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <PhoneIncoming className="h-4 w-4 text-primary" />
        {answered ? "Inbound call in progress" : "Incoming call"}
      </div>
      <div className="mt-2 flex items-center gap-2 font-mono text-lg">
        {call.phone ?? "Unknown number"}
        {call.phone && <CopyButton value={call.phone} />}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {call.debtor ? (
          <>
            Matches account <span className="font-medium text-foreground">{call.debtor.name}</span>
          </>
        ) : (
          "No matching account in your portfolios."
        )}
      </p>
      {!answered && (
        <p className="mt-2 text-xs text-muted-foreground">Answer on your softphone.</p>
      )}
    </div>
  );
}
