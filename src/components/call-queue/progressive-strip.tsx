// The bar a Progressive Dial session shows while it runs, pinned to the TOP of the screen and
// above the call screen (user, 2026-11-12): calls run back to back, and Pause / Resume / Skip /
// Stop are always within reach without anything popping up between calls.
import { ListOrdered, Pause, Play, SkipForward, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProgressiveDial } from "@/lib/dialer/use-progressive-dial";

export function ProgressiveStrip({
  dial,
  onClose,
}: {
  dial: ProgressiveDial;
  onClose: () => void;
}) {
  const { state } = dial;
  if (state.status === "idle") return null;
  const total = state.ids.length;
  const position = Math.min(state.index + 1, total);
  const upcoming = dial.target(state.ids[state.index]);
  const current = dial.target(state.current);

  const line =
    state.status === "calling"
      ? state.holdAfter
        ? `On call with ${current?.name ?? "borrower"} — will pause after this disposition`
        : `On call with ${current?.name ?? "borrower"} — save the disposition and the next call starts`
      : state.status === "countdown"
        ? `Calling ${upcoming?.name ?? "the next borrower"}…`
        : state.status === "paused"
          ? `Paused${state.pauseReason ? ` — ${state.pauseReason}` : ""}. Next: ${upcoming?.name ?? "borrower"}`
          : total
            ? `Done — ${state.called} called, ${state.skipped} skipped`
            : "No one left to call in this list";

  const btn = "h-7 gap-1 text-xs";
  return (
    <div className="fixed left-1/2 top-2 z-[60] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-primary/30 bg-card px-3 py-2 shadow-xl">
      <div className="flex flex-wrap items-center gap-2">
        <ListOrdered className="h-4 w-4 flex-shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-foreground">Progressive Dial</span>
          {total > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              {state.status === "done" ? `${total} of ${total}` : `${position} of ${total}`}
              {state.skipped > 0 && ` · ${state.skipped} skipped`}
            </span>
          )}
          <div className="truncate text-xs text-muted-foreground">{line}</div>
        </div>
        <div className="flex items-center gap-1.5">
          {(state.status === "countdown" || (state.status === "calling" && !state.holdAfter)) && (
            <Button size="sm" variant="outline" className={btn} onClick={dial.pause}>
              <Pause className="h-3.5 w-3.5" /> Pause
            </Button>
          )}
          {(state.status === "paused" || (state.status === "calling" && state.holdAfter)) && (
            <Button size="sm" className={btn} onClick={dial.resume}>
              <Play className="h-3.5 w-3.5" /> Resume
            </Button>
          )}
          {(state.status === "countdown" || state.status === "paused") && (
            <Button size="sm" variant="outline" className={btn} onClick={dial.skip}>
              <SkipForward className="h-3.5 w-3.5" /> Skip
            </Button>
          )}
          {state.status === "done" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={onClose}
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className={`${btn} text-destructive`}
              onClick={dial.stop}
              title={
                state.status === "calling"
                  ? "Ends the run; this call carries on until you end it"
                  : undefined
              }
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
