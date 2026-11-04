// Floating, draggable "call in progress" bar — shown at the dashboard layout level (so it
// survives navigating between agent pages) whenever the active call has been minimized from
// the full Call Queue panel. See src/lib/call-session.tsx for the shared call state.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Mic, MicOff, PhoneOff, Maximize2 } from "lucide-react";
import { useCallSession } from "@/lib/call-session";
import { useSingleCall } from "@/lib/dialer/use-single-call";
import { cn } from "@/lib/utils";

function fmtElapsed(s: number) {
  const m = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

export function GlobalCallBar() {
  const { activeCall, setActiveCall } = useCallSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  // Only used to hang up — this bar never places a call, so it drops the leg by its id.
  const singleCall = useSingleCall(setActiveCall, { mode: "server" });

  // The disposition screen lives on the Call Queue of THIS route tree. Managers and admins have
  // their own call session under /manager; sending them to /dashboard/call-queue switched to a
  // different session and the call (and its disposition) vanished.
  const queuePath = pathname.startsWith("/manager") ? "/manager/queue" : "/dashboard/call-queue";

  const onQueue = pathname.startsWith(queuePath);

  // The full call screen is drawn only by Call Queue. Anywhere else — the call was minimised, or
  // the agent simply opened another page mid-call — this bar is the call's only sign of life;
  // before, leaving Call Queue without minimising made the call vanish from the screen.
  const showBar = !!activeCall && (activeCall.view === "minimized" || !onQueue);

  // A call that ends while only this bar is showing — the borrower didn't pick up, was busy, or
  // hung up — opens the full disposition screen by itself, so the agent never has to find the
  // bar and expand it.
  const endedOutOfView = showBar && activeCall?.phase === "ended";
  // Once per call: an agent who then walks away from the open disposition is not dragged back.
  const callKey = activeCall ? `${activeCall.debtor.id}|${activeCall.dialStartedAt ?? ""}` : "";
  const autoOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!endedOutOfView || autoOpenedFor.current === callKey) return;
    autoOpenedFor.current = callKey;
    setActiveCall((c) => (c && c.phase === "ended" ? { ...c, view: "panel" } : c));
    if (!onQueue) navigate({ to: queuePath });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endedOutOfView, callKey]);

  const [pos, setPos] = useState({ x: 24, y: 24 });
  const dragRef = useRef<{ dragging: boolean; offX: number; offY: number }>({
    dragging: false,
    offX: 0,
    offY: 0,
  });
  const barRef = useRef<HTMLDivElement>(null);

  if (!activeCall || !showBar) return null;

  const { debtor, phase, muted, elapsed } = activeCall;
  const initials = debtor.name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");

  const goToQueue = () => {
    if (!onQueue) navigate({ to: queuePath });
  };

  const expand = () => {
    setActiveCall((c) => (c ? { ...c, view: "panel" } : null));
    goToQueue();
  };

  // Used to only flip the screen to "ended" — the real call carried on, because nothing told
  // the provider. Now it hangs up the leg; the effect above then opens the disposition.
  const endCall = () => singleCall.hangup(activeCall.providerCallId);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { dragging: true, offX: e.clientX - r.left, offY: e.clientY - r.top };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.dragging || !barRef.current) return;
    const el = barRef.current;
    const w = el.offsetWidth,
      h = el.offsetHeight;
    const x = Math.max(0, Math.min(e.clientX - dragRef.current.offX, window.innerWidth - w));
    const y = Math.max(0, Math.min(e.clientY - dragRef.current.offY, window.innerHeight - h));
    setPos({ x, y });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current.dragging = false;
    barRef.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={barRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 flex items-center gap-2 rounded-full bg-foreground text-background pl-2 pr-2.5 py-2 shadow-2xl shadow-black/30 cursor-grab active:cursor-grabbing select-none animate-in fade-in slide-in-from-bottom-4 duration-300"
    >
      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
        {initials}
      </span>
      <span className="text-xs whitespace-nowrap pr-1">
        {debtor.name} · {phase === "ringing" ? "Ringing…" : fmtElapsed(elapsed)}
      </span>

      {/* Disabled, not removed — same reason as the call panel's controls: this never muted
          anything. The agent is talking on their own handset and the app has no access to that
          audio path, so the button only ever toggled a red icon. See PROVIDER_CALL_CONTROL in
          active-call.tsx for the full note and the flag that re-enables both. */}
      {phase !== "ringing" && (
        <button
          type="button"
          disabled
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setActiveCall((c) => (c ? { ...c, muted: !c.muted } : null))}
          title="Mute is not available — this call runs on the agent's phone, which the app cannot control"
          className={cn(
            "flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors",
            "cursor-not-allowed opacity-40",
            muted ? "bg-destructive text-destructive-foreground" : "bg-background/15",
          )}
        >
          {muted ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
        </button>
      )}

      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={expand}
        title="Expand"
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-background/15 hover:bg-background/25 transition-colors"
      >
        <Maximize2 className="h-3 w-3" />
      </button>

      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={endCall}
        title="End call"
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
      >
        <PhoneOff className="h-3 w-3" />
      </button>
    </div>
  );
}
