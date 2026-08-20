import React, { useMemo, useRef, useEffect } from "react";
import { Phone, PhoneCall, BotMessageSquare, ChevronDown, ChevronUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CallMode } from "@/lib/portfolio-store";
import type { DialTarget } from "@/lib/dialer/engine";
import type { LiveCallEntry } from "@/lib/call-queue/types";

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
        <span className="text-[11px] text-muted-foreground">Today · 30 Jun 2026</span>
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

export function DialingBoard({ liveCalls }: { liveCalls: LiveCallEntry[] }) {
  const ringing = liveCalls.filter((c) => c.status === "ringing" && !c.incoming);
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
      <div className="divide-y divide-border/60 max-h-48 overflow-y-auto">
        {ringing.map((lc) => (
          <div key={lc.id} className="flex items-center gap-2 px-3 py-1.5">
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-foreground truncate">{lc.debtor}</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                {maskPhone(lc.phone)}
              </div>
            </div>
            {lc.type === "ai" && (
              <span className="text-[8px] font-bold text-violet-500 flex-shrink-0">AI</span>
            )}
          </div>
        ))}
      </div>
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
