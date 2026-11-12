// The bar a Progressive Dial session shows while it runs: who is being called, who is next and
// when, progress through the list, and Pause / Resume / Skip / Call now / Stop.
import { ListOrdered, Pause, Phone, Play, SkipForward, Square, X } from "lucide-react";
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

  return (
    <div className="fixed bottom-4 left-1/2 z-40 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-border bg-card px-4 py-3 shadow-xl">
      <div className="flex flex-wrap items-center gap-3">
        <ListOrdered className="h-4 w-4 flex-shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium text-foreground">
            Progressive Dial
            {total > 0 && (
              <span className="ml-2 font-normal text-muted-foreground">
                {state.status === "done" ? `${total} of ${total}` : `${position} of ${total}`}
                {state.skipped > 0 && ` · ${state.skipped} skipped`}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {state.status === "calling" &&
              `On call with ${current?.name ?? "borrower"} — save the disposition to move on`}
            {state.status === "countdown" &&
              (dial.secondsLeft && dial.secondsLeft > 0
                ? `Next: ${upcoming?.name ?? "borrower"} in ${dial.secondsLeft}s`
                : `Calling ${upcoming?.name ?? "borrower"}…`)}
            {state.status === "paused" &&
              `Paused${state.pauseReason ? ` — ${state.pauseReason}` : ""}. Next: ${upcoming?.name ?? "borrower"}`}
            {state.status === "done" &&
              (total
                ? `Done — ${state.called} called, ${state.skipped} skipped`
                : "No one left to call in this list")}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {state.status === "countdown" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs"
                onClick={dial.pause}
              >
                <Pause className="h-3.5 w-3.5" /> Pause
              </Button>
              <Button size="sm" className="h-8 gap-1 text-xs" onClick={dial.callNow}>
                <Phone className="h-3.5 w-3.5" /> Call now
              </Button>
            </>
          )}
          {state.status === "paused" && (
            <Button size="sm" className="h-8 gap-1 text-xs" onClick={dial.resume}>
              <Play className="h-3.5 w-3.5" /> Resume
            </Button>
          )}
          {(state.status === "countdown" || state.status === "paused") && (
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={dial.skip}>
              <SkipForward className="h-3.5 w-3.5" /> Skip
            </Button>
          )}
          {state.status === "done" ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={onClose}
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs text-destructive"
              onClick={dial.stop}
              title={
                state.status === "calling"
                  ? "Stops after this call; the call itself carries on"
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
