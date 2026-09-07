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

      {/* Honest about what this screen is. Whisper/barge/merge were asked for and don't exist
          here on purpose — with the current telephony integration (Exotel click-to-call) the
          two legs are bridged inside the provider, not in this app, so there is nothing in the
          browser that could tap into, whisper into or merge a call in progress. A real version
          of that needs a different integration (WebRTC/SIP with provider-side conference
          control) that has not been started — see docs/LIVE_CALLS_SCOPE.md. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          This is a <strong className="text-foreground">monitoring</strong> view, not a call control
          panel — there's no listen-in, whisper or merge here. The current telephony setup bridges
          each call directly between the agent and the debtor, so nothing in this app can join a
          call already in progress.
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
