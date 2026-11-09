// Runs AI analysis over several calls. One at a time on purpose: the AI services rate-limit, and
// each call costs money, so the button asks once more before starting and can be stopped.
import { useRef, useState } from "react";
import { Loader2, Sparkles, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getAccessToken } from "@/lib/access-token";
import { MAX_AI_BATCH } from "@/lib/call-audit";
import { analyzeCallSentiment } from "@/lib/call-sentiment-actions.server";

export function BatchAiButton({ callIds, onDone }: { callIds: string[]; onDone: () => void }) {
  const [armed, setArmed] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const stop = useRef(false);
  const batch = callIds.slice(0, MAX_AI_BATCH);

  const run = async () => {
    setArmed(false);
    stop.current = false;
    let ok = 0;
    let failed = 0;
    setProgress({ done: 0, total: batch.length });
    for (const callId of batch) {
      if (stop.current) break;
      try {
        await analyzeCallSentiment({ data: { accessToken: await getAccessToken(), callId } });
        ok++;
      } catch {
        failed++;
      }
      setProgress({ done: ok + failed, total: batch.length });
    }
    setProgress(null);
    if (failed) toast.error(`${ok} calls analysed, ${failed} failed. Try the failed ones again.`);
    else toast.success(`${ok} calls analysed and waiting for your review`);
    onDone();
  };

  if (progress) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-9 gap-1.5 text-xs"
        onClick={() => (stop.current = true)}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {progress.done} of {progress.total}
        <Square className="h-3 w-3" /> Stop
      </Button>
    );
  }
  if (armed) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Each call uses paid AI.</span>
        <Button size="sm" className="h-9 text-xs" onClick={run}>
          Analyse {batch.length}
        </Button>
        <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={() => setArmed(false)}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-9 gap-1.5 text-xs"
      onClick={() => setArmed(true)}
    >
      <Sparkles className="h-3.5 w-3.5" />
      Analyse {batch.length} with AI
    </Button>
  );
}
