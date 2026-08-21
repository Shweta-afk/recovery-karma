import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { DispositionRecord } from "@/lib/disposition-store";

export const OUTCOME_LABELS: Record<string, string> = {
  paid: "Paid",
  promised: "PTP",
  refused: "Refused",
  no_answer: "No Answer",
  callback: "Callback",
  voicemail: "Voicemail",
  dispute: "Dispute",
  settlement: "Settlement",
};

export const OUTCOME_COLOR: Record<string, string> = {
  paid: "text-success",
  promised: "text-blue-500",
  refused: "text-destructive",
  no_answer: "text-muted-foreground",
  callback: "text-amber-500",
  voicemail: "text-muted-foreground",
  dispute: "text-orange-500",
  settlement: "text-purple-500",
};

/** Outcome distribution bars — shared by admin/manager/agent report pages so the same
 * call_logs.outcome union renders identically everywhere. */
export function OutcomeBreakdown({ disps }: { disps: DispositionRecord[] }) {
  const counts = disps.reduce<Record<string, number>>((acc, d) => {
    acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const total = disps.length;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-2.5">
      {sorted.map(([outcome, count]) => {
        const pct = Math.round((count / total) * 100);
        return (
          <div key={outcome} className="flex items-center gap-3 text-xs">
            <span className={cn("font-medium w-24 shrink-0", OUTCOME_COLOR[outcome])}>
              {OUTCOME_LABELS[outcome] ?? outcome}
            </span>
            <Progress value={pct} className="flex-1 h-2" />
            <span className="text-muted-foreground w-12 text-right">
              {count} ({pct}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}
