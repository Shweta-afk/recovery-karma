import React, { useMemo, useRef, useEffect, useState } from "react";
import { Phone, PhoneCall, BotMessageSquare, ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatISTDate } from "@/lib/agent-time-stats";
import type { CallMode } from "@/lib/portfolio-store";
import type { DialTarget } from "@/lib/dialer/engine";
import type { LiveCallEntry } from "@/lib/call-queue/types";
import type { QueueTeammate } from "@/lib/telephony/server";
import { Button } from "@/components/ui/button";

// ─── Dialer mode status bar ─────────────────────────────────────────────────
// Shared by the agent's own call queue and the manager's read-only Agent Live View
// so both surfaces show an identical portfolio-mode + dialer-status strip.
export function DialerModeBar({
  portfolioMode,
  portfolioName,
  dialerRunning,
}: {
  portfolioMode: CallMode;
  portfolioName: string;
  dialerRunning: boolean;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap rounded-xl border border-border bg-card px-4 py-2.5">
      {/* Portfolio mode — read-only, set by manager */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Portfolio Mode
        </span>
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold",
            portfolioMode === "hybrid"
              ? "border-violet-400/20 bg-violet-500/8 text-violet-500"
              : portfolioMode === "ai_only"
                ? "border-blue-400/20 bg-blue-500/8 text-blue-500"
                : portfolioMode === "ivr_agent"
                  ? "border-amber-400/20 bg-amber-500/8 text-amber-600"
                  : "border-primary/20 bg-primary/8 text-primary",
          )}
        >
          {portfolioMode === "hybrid" ? (
            <>
              <BotMessageSquare className="h-3 w-3" />
              Hybrid (AI + Agent)
            </>
          ) : portfolioMode === "ai_only" ? (
            <>
              <BotMessageSquare className="h-3 w-3" />
              AI Only
            </>
          ) : portfolioMode === "ivr_agent" ? (
            <>
              <PhoneCall className="h-3 w-3" />
              IVR + Agent
            </>
          ) : (
            <>
              <Phone className="h-3 w-3" />
              Agent Only
            </>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground">· {portfolioName}</span>
        <span className="text-[10px] text-muted-foreground/50 italic">set by manager</span>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Dialer status */}
      <span className="inline-flex items-center gap-1.5 text-xs font-medium">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            dialerRunning ? "bg-success animate-pulse" : "bg-muted-foreground",
          )}
        />
        <span className={dialerRunning ? "text-success" : "text-muted-foreground"}>
          Productive Dialer {dialerRunning ? "RUNNING" : "OFF"}
        </span>
      </span>

      {(portfolioMode === "hybrid" || portfolioMode === "ivr_agent") && dialerRunning && (
        <>
          <div className="h-4 w-px bg-border" />
          {portfolioMode === "hybrid" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" />
              AI active
            </span>
          )}
          {portfolioMode === "ivr_agent" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              IVR active
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            Agents active
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Today · {formatISTDate()}</span>
      </div>
    </div>
  );
}

// ─── Dialing Board ────────────────────────────────────────────────────────────
// Productive Dial (dialerMode "predictive" internally) opens several lines at once — the
// point of it is that multiple numbers
// are being rung in parallel, not one at a time. LiveCallsPanel (bottom-right) is about
// managing calls once they connect; this is the parallel-dial visual the mode is actually
// named for — every number currently ringing, live, bottom-left so the two panels never
// overlap.

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return `${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** What the agent can do about borrowers waiting in the calling service's queue. */
export interface WaitingActions {
  /** Ends the agent's current call so the next waiting borrower is put through (absent when the
   *  agent isn't on a call — then the borrower is already on their way). */
  onTakeNow?: () => void;
  loadTeammates: () => Promise<QueueTeammate[]>;
  sendToTeammate: (agentId: string) => Promise<void>;
}

export function DialingBoard({
  liveCalls,
  waiting,
  paused,
  skippedCalledToday,
}: {
  liveCalls: LiveCallEntry[];
  waiting?: WaitingActions;
  paused?: boolean;
  skippedCalledToday?: number;
}) {
  const ringing = liveCalls.filter((c) => c.status === "ringing" && !c.incoming);
  // Productive Dial through the calling service's queue: borrowers are rung first and the agent
  // hears nothing until one picks up. Agents read the silence as a broken phone (2026-11-21), so
  // this box says what is happening at every moment, not just who is ringing.
  if (liveCalls.some((c) => c.vendorRouted))
    return (
      <ProductiveDialStatus
        liveCalls={liveCalls}
        actions={waiting}
        paused={paused}
        skippedCalledToday={skippedCalledToday}
      />
    );
  if (!ringing.length) return null;

  return (
    <div className="fixed bottom-4 left-4 z-40 w-64 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 animate-in slide-in-from-bottom-4 duration-300 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-blue-500/10 border-b border-border">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1">
          Dialing {ringing.length} number{ringing.length === 1 ? "" : "s"}
        </span>
        <PhoneCall className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
      </div>
      <RingingList calls={ringing} />
    </div>
  );
}

function RingingList({ calls }: { calls: LiveCallEntry[] }) {
  return (
    <div className="divide-y divide-border/60 max-h-48 overflow-y-auto">
      {calls.map((lc) => (
        <div key={lc.id} className="flex items-center gap-2 px-3 py-1.5">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium text-foreground truncate">{lc.debtor}</div>
            <div className="font-mono text-[10px] text-muted-foreground">{maskPhone(lc.phone)}</div>
          </div>
          {lc.type === "ai" && (
            <span className="text-[8px] font-bold text-violet-500 flex-shrink-0">AI</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Productive Dial's box: what the agent should expect right now, how far the run has got, and
 *  who is ringing (any one of them may be the next voice the agent hears). */
function ProductiveDialStatus({
  liveCalls,
  actions,
  paused,
  skippedCalledToday,
}: {
  liveCalls: LiveCallEntry[];
  actions?: WaitingActions;
  paused?: boolean;
  skippedCalledToday?: number;
}) {
  // Borrowers who picked up and wait for a free agent — kept on screen until someone takes them
  // or they hang up (they used to flash past in a second, 2026-11-21).
  const waitingNow = liveCalls
    .filter((c) => c.status === "ringing" && c.waitingSince && !c.agentHandle)
    .sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0));
  const ringing = liveCalls.filter((c) => c.status === "ringing" && !c.incoming && !c.waitingSince);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!waitingNow.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waitingNow.length]);
  const onCall = liveCalls.find((c) => c.status === "connected" || c.status === "on_hold");
  const pickedUp = liveCalls.filter(
    (c) => c.status === "connected" || c.status === "on_hold" || c.status === "done",
  ).length;
  const noAnswer = liveCalls.filter((c) => c.status === "no_answer").length;

  const headline = paused
    ? "Paused"
    : onCall
      ? `On a call with ${onCall.debtor}${waitingNow.length ? ` · ${waitingNow.length} waiting` : ""}`
      : ringing.length
        ? `Ringing ${ringing.length} borrower${ringing.length === 1 ? "" : "s"}`
        : "Picking the next borrowers…";
  const explain = paused
    ? "No new borrowers will ring. Calls already ringing can still reach you. Press Resume to carry on from where you stopped."
    : onCall
      ? "New borrowers are rung as soon as this call ends."
      : ringing.length
        ? "Your phone stays quiet while they ring. When one picks up you are connected straight away and their account opens. Phones nobody answers in 45 seconds are skipped."
        : "The next borrowers in your queue will start ringing in a moment.";

  return (
    <div className="fixed bottom-4 left-4 z-40 w-72 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 animate-in slide-in-from-bottom-4 duration-300 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-success/10 border-b border-border">
        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1">
          {paused ? "Productive Dial is paused" : "Productive Dial is on"}
        </span>
        <PhoneCall className="h-3.5 w-3.5 text-success flex-shrink-0" />
      </div>
      <div className="px-3 py-2 border-b border-border">
        <div className="text-sm font-semibold text-foreground">{headline}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{explain}</p>
        {skippedCalledToday ? (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {skippedCalledToday} already called today left out.
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border text-center">
        {[
          ["Dialled", liveCalls.length],
          ["Picked up", pickedUp],
          ["No answer", noAnswer],
        ].map(([label, n]) => (
          <div key={label as string} className="py-1.5">
            <div className="text-sm font-semibold tabular-nums text-foreground">{n}</div>
            <div className="text-[10px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      {waitingNow.length > 0 && <WaitingSection calls={waitingNow} actions={actions} />}
      {ringing.length > 0 && (
        <>
          <div className="px-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Ringing now
          </div>
          <RingingList calls={ringing} />
        </>
      )}
    </div>
  );
}

function waitedFor(since: number | undefined): string {
  const s = Math.max(0, Math.floor((Date.now() - (since ?? Date.now())) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Borrowers on the line waiting for an agent, and what the agent can do about them. The calling
 *  service hands out the longest-waiting borrower first; neither action can pick a particular one. */
function WaitingSection({ calls, actions }: { calls: LiveCallEntry[]; actions?: WaitingActions }) {
  const [picking, setPicking] = useState(false);
  const [mates, setMates] = useState<QueueTeammate[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  const openPicker = async () => {
    if (!actions) return;
    setPicking((p) => !p);
    if (mates) return;
    try {
      setMates(await actions.loadTeammates());
    } catch {
      setMates([]);
    }
  };

  return (
    <div className="border-b border-border bg-amber-500/10">
      <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
        Waiting for you ({calls.length})
      </div>
      <p className="px-3 text-[11px] leading-snug text-muted-foreground">
        Picked up while you were busy. They hang up if nobody takes them soon; the one waiting
        longest is put through first.
      </p>
      <div className="divide-y divide-border/60 max-h-32 overflow-y-auto">
        {calls.map((c) => (
          <div key={c.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-amber-500 animate-pulse" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
              {c.debtor}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-amber-700 dark:text-amber-400">
              {waitedFor(c.waitingSince)}
            </span>
          </div>
        ))}
      </div>
      {actions && (
        <div className="flex gap-1.5 px-3 py-2">
          {actions.onTakeNow && (
            <Button
              size="sm"
              className="h-7 flex-1 text-[11px]"
              title="Ends your current call; the borrower waiting longest is put through to you"
              onClick={actions.onTakeNow}
            >
              Take now
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 text-[11px]"
            title="A teammate's phone rings with the borrower waiting longest"
            onClick={() => void openPicker()}
          >
            Send to a teammate
          </Button>
        </div>
      )}
      {picking && actions && (
        <div className="max-h-40 overflow-y-auto border-t border-border bg-card">
          {mates === null ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">Loading your team…</p>
          ) : mates.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              No teammates with a calling extension on your team.
            </p>
          ) : (
            mates.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={m.onCall || sending !== null}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                onClick={async () => {
                  setSending(m.id);
                  try {
                    await actions.sendToTeammate(m.id);
                    setPicking(false);
                  } finally {
                    setSending(null);
                  }
                }}
              >
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{m.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {sending === m.id
                    ? "Sending…"
                    : m.onCall
                      ? "On a call"
                      : (m.status ?? "status unknown")}{" "}
                  · {m.extension}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Progressive Dial Board ────────────────────────────────────────────────────
// Component/type names below still say "Productive" (dialerMode "productive" internally) —
// only the display label changed, to "Progressive Dial". Works the queue one debtor at a time,
// in list order: dial, wait for the outcome (ringing → no-answer/busy/connected), then move
// on — the opposite tradeoff from Productive Dial's several-lines-at-once DialingBoard above.
// This is the sequential-progress animation: a fixed list-position walk through the run's
// targets, current entry highlighted, pulsing, and auto-scrolled into view so the agent always
// sees who's being called right now.

type ProductiveRowStatus = "pending" | "ringing" | "connected" | "no_answer" | "done";

function productiveRowStatus(leg: LiveCallEntry | undefined): ProductiveRowStatus {
  if (!leg) return "pending";
  if (leg.status === "ringing") return "ringing";
  if (leg.status === "connected" || leg.status === "on_hold") return "connected";
  if (leg.status === "no_answer") return "no_answer";
  return "done";
}

const PRODUCTIVE_ROW_META: Record<
  ProductiveRowStatus,
  { label: string; dot: string; text: string }
> = {
  pending: { label: "Waiting", dot: "bg-muted-foreground/40", text: "text-muted-foreground/60" },
  ringing: { label: "Ringing…", dot: "bg-blue-500", text: "text-blue-500" },
  connected: { label: "Connected", dot: "bg-success", text: "text-success" },
  no_answer: { label: "No answer", dot: "bg-destructive", text: "text-destructive" },
  done: { label: "Done", dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

export function ProductiveDialBoard({
  targets,
  liveCalls,
  onStop,
}: {
  targets: DialTarget[];
  liveCalls: LiveCallEntry[];
  onStop: () => void;
}) {
  // Multiple legs can now share a debtorId — one per phone number tried (primary, then each
  // altPhones entry) — so this keeps the full run per debtor, not just the latest leg.
  const legsByDebtor = useMemo(() => {
    const m = new Map<string, LiveCallEntry[]>();
    for (const lc of liveCalls) {
      if (lc.incoming) continue;
      const arr = m.get(lc.loanId);
      if (arr) arr.push(lc);
      else m.set(lc.loanId, [lc]);
    }
    return m;
  }, [liveCalls]);

  const rows = targets.map((t) => {
    const attempts = legsByDebtor.get(t.id) ?? [];
    const leg = attempts[attempts.length - 1];
    const totalNumbers = 1 + (t.altPhones?.length ?? 0);
    return {
      target: t,
      leg,
      status: productiveRowStatus(leg),
      attemptNumber: attempts.length,
      totalNumbers,
    };
  });

  const currentIndex = rows.findIndex((r) => r.status === "ringing" || r.status === "connected");
  const doneCount = rows.filter((r) => r.status === "no_answer" || r.status === "done").length;
  const total = rows.length;
  const current = currentIndex >= 0 ? rows[currentIndex] : undefined;

  const currentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIndex]);

  if (!total) return null;

  return (
    <div className="fixed bottom-4 left-4 z-40 w-72 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 animate-in slide-in-from-bottom-4 duration-300 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-violet-500/10 border-b border-border">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
        </span>
        <span className="text-xs font-semibold text-foreground flex-1">
          Progressive Calling — {Math.min(doneCount + 1, total)} of {total}
        </span>
        <button
          type="button"
          onClick={onStop}
          className="text-muted-foreground hover:text-foreground flex-shrink-0"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-muted">
        <div
          className="h-full bg-violet-500 transition-all duration-500 ease-out"
          style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }}
        />
      </div>

      {/* Currently dialing — the "who is it calling right now" callout */}
      {current && (
        <div className="flex items-center gap-2 px-3 py-2 bg-violet-500/5 border-b border-border">
          <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400/40" />
            <PhoneCall className="relative h-3.5 w-3.5 text-blue-500" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium text-foreground truncate">
              {current.target.name}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {maskPhone(current.leg?.phone ?? current.target.phone)}
              {current.totalNumbers > 1 && (
                <span className="ml-1 text-muted-foreground/70">
                  · number {Math.max(1, current.attemptNumber)} of {current.totalNumbers}
                </span>
              )}
            </div>
          </div>
          <span
            className={cn(
              "text-[10px] font-semibold flex-shrink-0",
              PRODUCTIVE_ROW_META[current.status].text,
            )}
          >
            {PRODUCTIVE_ROW_META[current.status].label}
          </span>
        </div>
      )}

      {/* Ordered list — done, current (pulsing), upcoming (dimmed) */}
      <div className="divide-y divide-border/60 max-h-48 overflow-y-auto">
        {rows.map((r, i) => {
          const meta = PRODUCTIVE_ROW_META[r.status];
          const isCurrent = i === currentIndex;
          return (
            <div
              key={r.target.id}
              ref={isCurrent ? currentRef : undefined}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5",
                isCurrent && "bg-violet-500/10",
                r.status === "pending" && "opacity-50",
              )}
            >
              <span className="w-4 flex-shrink-0 text-right text-[9px] font-mono text-muted-foreground">
                {i + 1}
              </span>
              <span className="relative flex h-2 w-2 flex-shrink-0">
                {isCurrent && (
                  <span
                    className={cn(
                      "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                      meta.dot,
                    )}
                  />
                )}
                <span className={cn("relative inline-flex h-2 w-2 rounded-full", meta.dot)} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                {r.target.name}
                {r.totalNumbers > 1 && r.attemptNumber > 1 && (
                  <span className="ml-1 text-[9px] text-muted-foreground/70">
                    ({Math.min(r.attemptNumber, r.totalNumbers)}/{r.totalNumbers})
                  </span>
                )}
              </span>
              <span className={cn("flex-shrink-0 text-[9px] font-semibold", meta.text)}>
                {meta.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Live Calls Panel ─────────────────────────────────────────────────────────

export function LiveCallsPanel({
  liveCalls,
  onDismiss,
  onTake,
  onTransfer,
  onEndLeg,
}: {
  liveCalls: LiveCallEntry[];
  onDismiss: () => void;
  onTake: (lc: LiveCallEntry) => void;
  onTransfer: (lc: LiveCallEntry) => void;
  onEndLeg: (lc: LiveCallEntry) => void;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const connected = liveCalls.filter((c) => c.status === "connected").length;
  const ringing = liveCalls.filter((c) => c.status === "ringing").length;
  const transfers = liveCalls.filter((c) => c.incoming).length;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-72 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 animate-in slide-in-from-bottom-4 duration-300 overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setCollapsed((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors border-b border-border"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1 text-left">Live Calls</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {connected}✓ {ringing}↻ {liveCalls.length} total
        </span>
        {transfers > 0 && (
          <span className="rounded bg-amber-500/15 px-1.5 py-px text-[9px] font-bold text-amber-600">
            {transfers} transfer{transfers > 1 ? "s" : ""}
          </span>
        )}
        {collapsed ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="text-muted-foreground hover:text-foreground flex-shrink-0 ml-0.5"
        >
          <X className="h-3 w-3" />
        </button>
      </button>

      {/* Call rows — hidden when collapsed */}
      {!collapsed && (
        <div className="divide-y divide-border/60 max-h-64 overflow-y-auto">
          {liveCalls.map((lc) => {
            const dotCls =
              lc.status === "connected"
                ? "bg-success animate-pulse"
                : lc.status === "ringing"
                  ? "bg-blue-400 animate-pulse"
                  : lc.status === "on_hold"
                    ? "bg-amber-400"
                    : lc.status === "no_answer"
                      ? "bg-destructive"
                      : "bg-muted-foreground";
            const statusShort =
              lc.status === "connected"
                ? "Live"
                : lc.status === "ringing"
                  ? "Ring"
                  : lc.status === "on_hold"
                    ? "Hold"
                    : lc.status === "no_answer"
                      ? "N/A"
                      : "Done";

            return (
              <div
                key={lc.id}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5",
                  lc.incoming
                    ? "bg-amber-500/5 border-l-2 border-l-amber-500"
                    : "hover:bg-muted/20",
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", dotCls)} />

                {/* Debtor + loan */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 leading-none">
                    <span className="text-[11px] font-medium text-foreground truncate">
                      {lc.debtor}
                    </span>
                    {lc.type === "ai" && (
                      <span className="text-[8px] font-bold text-violet-500 flex-shrink-0">AI</span>
                    )}
                    {lc.incoming && (
                      <span className="text-[8px] font-bold text-amber-600 flex-shrink-0">↩</span>
                    )}
                  </div>
                  <span className="text-[9px] text-muted-foreground">{lc.loanId}</span>
                </div>

                {/* Status + duration */}
                <div className="flex-shrink-0 text-right mr-1">
                  <div
                    className={cn(
                      "text-[9px] font-semibold leading-none",
                      lc.status === "connected"
                        ? "text-success"
                        : lc.status === "ringing"
                          ? "text-blue-400"
                          : lc.status === "no_answer"
                            ? "text-destructive"
                            : "text-muted-foreground",
                    )}
                  >
                    {statusShort}
                  </div>
                  <div className="font-mono text-[9px] text-muted-foreground">{lc.duration}</div>
                </div>

                {/* Transfer actions — inline pill buttons */}
                {lc.incoming && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => onTake(lc)}
                      className="rounded bg-success/15 px-1.5 py-0.5 text-[9px] font-bold text-success hover:bg-success/25 transition-colors"
                    >
                      Take
                    </button>
                    <button
                      type="button"
                      onClick={() => onTransfer(lc)}
                      className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground hover:bg-muted/70 transition-colors"
                    >
                      Fwd
                    </button>
                  </div>
                )}

                {/* End Call — every live (non-incoming) leg the predictive dialer opened.
                    There was previously no way to hang up one of these individually; Take/Fwd
                    above only ever apply to a transferred-in call. */}
                {!lc.incoming && (lc.status === "connected" || lc.status === "ringing") && (
                  <button
                    type="button"
                    onClick={() => onEndLeg(lc)}
                    className="rounded bg-destructive/15 px-1.5 py-0.5 text-[9px] font-bold text-destructive hover:bg-destructive/25 transition-colors flex-shrink-0"
                  >
                    End
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
