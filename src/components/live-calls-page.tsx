// Full-page version of the Live Calls board embedded on the manager/admin dashboards — same
// data, same component, just with room to breathe and a dial-mode breakdown up top. Two thin
// routes (manager.live-calls.tsx, admin.live-calls.tsx) render this; RLS on live_calls does the
// actual scoping (a manager's query only ever returns their team either way), so this component
// doesn't need to know which role is looking at it.
import { PhoneCall, PhoneIncoming, Info } from "lucide-react";
import { DIAL_MODE_META, type DialMode } from "@/lib/call-queue/types";
import { LiveCallsBoard, useLiveCalls } from "@/components/live-calls-board";

const DIAL_MODE_ORDER: DialMode[] = ["multi_line", "sequential", "single", "manual"];

export function LiveCallsPageBody({ scopeLabel }: { scopeLabel: string }) {
  const { calls } = useLiveCalls();
  const ringing = calls.filter((c) => c.phase === "ringing").length;
  const connected = calls.filter((c) => c.phase !== "ringing").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Live Calls</h1>
        <p className="text-sm text-muted-foreground">
          Every call in progress {scopeLabel} — updates on its own as agents dial, connect and hang
          up. No action needed to refresh.
        </p>
      </div>

      {/* Listen/Whisper/Merge buttons exist on each card below, disabled — see
          CALL_CONTROL_ACTIONS in live-calls-board.tsx. With the CURRENT telephony integration
          (Exotel click-to-call) each call's two legs are bridged inside the provider, not in
          this app, so nothing here can actually tap into, whisper into or merge a call yet.
          Decision 2026-09-07: the org is moving off Exotel and evaluating a new vendor
          specifically to make this possible, so the controls stay visible as a placeholder
          rather than being removed again — see docs/LIVE_CALLS_SCOPE.md. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          This is a <strong className="text-foreground">monitoring</strong> view today — Listen,
          Whisper and Merge are shown on each call below but not active yet. The current telephony
          setup can&apos;t support them; they&apos;ll switch on once the org moves to a new
          telephony vendor with call-control support.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <PhoneIncoming className="h-3 w-3" />
            Ringing
          </div>
          <div className="mt-1 text-xl font-bold text-amber-500 tabular-nums">{ringing}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <PhoneCall className="h-3 w-3" />
            Connected
          </div>
          <div className="mt-1 text-xl font-bold text-success tabular-nums">{connected}</div>
        </div>
        {DIAL_MODE_ORDER.map((mode) => {
          const count = calls.filter((c) => c.dialMode === mode).length;
          const meta = DIAL_MODE_META[mode];
          return (
            <div key={mode} className="rounded-lg border border-border bg-card p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">
                {meta.label}
              </div>
              <div className="mt-1 text-xl font-bold text-foreground tabular-nums">{count}</div>
            </div>
          );
        })}
      </div>

      <LiveCallsBoard />
    </div>
  );
}
