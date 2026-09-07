/**
 * Live Calls — every call happening right now, for whoever is allowed to see it.
 *
 * An agent's call used to exist only in that agent's browser (useCallSession is React state),
 * so no supervisor could see one and nothing on the server knew it was happening. This board
 * is the reader half of live-calls-store.ts; CallSessionProvider is the writer.
 *
 * Scoping is RLS's job, not this component's: an agent sees only their own row, a manager their
 * team's, an admin the whole client. Nothing here filters by role.
 */
import { useCallback, useEffect, useState } from "react";
import { PhoneCall, RadioTower, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DIAL_MODE_META, type DialMode } from "@/lib/call-queue/types";
import {
  fetchLiveCalls,
  liveCallStartLabel,
  subscribeLiveCalls,
  type LiveCall,
} from "@/lib/live-calls-store";

/** Live rows, kept current by Realtime plus a slow tick for durations and staleness. */
export function useLiveCalls(): { calls: LiveCall[]; loading: boolean } {
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetchLiveCalls()
      .then(setCalls)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const unsubscribe = subscribeLiveCalls(load);
    // Realtime covers changes to the ROWS. It cannot tell us that time has passed, and both the
    // duration and the stale flag are functions of now — so a slow tick keeps them truthful
    // even when nothing in the table changes.
    const tick = setInterval(load, 10_000);
    return () => {
      unsubscribe();
      clearInterval(tick);
    };
  }, [load]);

  return { calls, loading };
}

function elapsedLabel(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return "—";
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function LiveCallsBoard({ className }: { className?: string }) {
  const { calls, loading } = useLiveCalls();

  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Loading live calls…</p>;
  }

  if (calls.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border py-10 text-center">
        <RadioTower className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No calls in progress right now.</p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          This updates by itself as agents start and end calls.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {calls.map((c) => (
        <LiveCallCard key={c.id} call={c} />
      ))}
    </div>
  );
}

function LiveCallCard({ call }: { call: LiveCall }) {
  const mode = call.dialMode ? DIAL_MODE_META[call.dialMode as DialMode] : null;
  // While it's still ringing, nobody has actually spoken to the debtor yet — showing their name
  // and number for a call that might go unanswered is more identity exposure than the moment
  // needs. Revealed the instant the leg reports connected, same signal the "Connected" badge
  // below already switches on.
  const connected = call.phase !== "ringing";
  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3",
        call.stale ? "border-border opacity-60" : "border-success/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground truncate">
          {/* Pulsing only while the heartbeat is fresh — a still dot on a stale card is the
              honest signal that we are no longer sure this call is happening. */}
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              call.stale ? "bg-muted-foreground" : "animate-pulse bg-success",
            )}
          />
          {call.agentName}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {elapsedLabel(call.startedAt)}
        </span>
      </div>

      {connected ? (
        <>
          <div className="mt-2 flex items-center gap-1.5 text-sm text-foreground">
            <PhoneCall className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{call.debtorName}</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {call.loanReference ? `${call.loanReference} · ` : ""}
            {call.phone || "—"}
          </div>
        </>
      ) : (
        <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground italic">
          <PhoneCall className="h-3.5 w-3.5 shrink-0 animate-pulse" />
          Dialing — who answers shows up here once connected
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn(
            "text-[10px]",
            call.phase === "ringing"
              ? "border-amber-400/40 text-amber-500"
              : "border-success/40 text-success",
          )}
        >
          {call.phase === "ringing" ? "Ringing" : "Connected"}
        </Badge>
        {mode && (
          <Badge variant="outline" className={cn("text-[10px]", mode.cls)}>
            {mode.short}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          from {liveCallStartLabel(call.startedAt)}
        </span>
      </div>

      {call.stale && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
          <span className="text-[10px] text-muted-foreground">
            {/* Said plainly rather than hidden: the agent's browser stopped reporting, so this
                call may already be over. Showing it as live would be a guess. */}
            No update from this agent&apos;s app recently — the call may already have ended.
          </span>
        </div>
      )}
    </div>
  );
}
