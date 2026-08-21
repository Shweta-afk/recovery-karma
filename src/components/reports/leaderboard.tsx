import { Trophy, Medal, Award } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatINR } from "@/lib/mock-debtors";
import { Progress } from "@/components/ui/progress";

export interface LeaderboardEntry {
  agentId: string;
  name: string;
  teamName?: string;
  collected: number;
  ptps: number;
  ptpAmount: number;
  calls: number;
  contactRate: number;
}

/** Ranking metric — collections is the default since it's the outcome the business is
 * actually measured on; the others are available for coaching-oriented views. */
export type LeaderboardMetric = "collected" | "ptpAmount" | "calls" | "contactRate";

/** Lower-case phrasing for "Ranked by ..." captions, so a page can state honestly which
 * metric the ordering actually reflects. */
export const LEADER_METRIC_CAPTION: Record<LeaderboardMetric, string> = {
  collected: "amount collected",
  ptpAmount: "PTP value",
  calls: "calls made",
  contactRate: "contact rate",
};

const METRIC_LABEL: Record<LeaderboardMetric, string> = {
  collected: "Collected",
  ptpAmount: "PTP Value",
  calls: "Calls",
  contactRate: "Contact Rate",
};

function rankStyle(rank: number) {
  if (rank === 0)
    return { icon: Trophy, cls: "text-amber-400", ring: "border-amber-400/40 bg-amber-400/10" };
  if (rank === 1)
    return { icon: Medal, cls: "text-slate-300", ring: "border-slate-300/40 bg-slate-300/10" };
  if (rank === 2)
    return { icon: Award, cls: "text-orange-400", ring: "border-orange-400/40 bg-orange-400/10" };
  return null;
}

function metricValue(e: LeaderboardEntry, m: LeaderboardMetric): number {
  return m === "collected"
    ? e.collected
    : m === "ptpAmount"
      ? e.ptpAmount
      : m === "calls"
        ? e.calls
        : e.contactRate;
}

function formatMetric(v: number, m: LeaderboardMetric): string {
  if (m === "collected" || m === "ptpAmount") return formatINR(v);
  if (m === "contactRate") return `${v}%`;
  return v.toLocaleString();
}

/**
 * Agent leaderboard ranked by a chosen metric, with the top three highlighted. Bars are
 * scaled against the leader (not a target), so the visual gap reads as relative standing.
 */
export function Leaderboard({
  entries,
  metric = "collected",
  limit = 10,
  showTeam = false,
}: {
  entries: LeaderboardEntry[];
  metric?: LeaderboardMetric;
  limit?: number;
  showTeam?: boolean;
}) {
  const ranked = [...entries]
    .filter((e) => e.calls > 0 || e.collected > 0 || e.ptps > 0)
    .sort((a, b) => metricValue(b, metric) - metricValue(a, metric))
    .slice(0, limit);

  if (ranked.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/40 py-10 text-center">
        <Trophy className="mx-auto h-7 w-7 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          No agent activity yet — the leaderboard fills in as calls get logged.
        </p>
      </div>
    );
  }

  const top = metricValue(ranked[0], metric) || 1;

  return (
    <div className="space-y-1.5">
      {ranked.map((e, i) => {
        const style = rankStyle(i);
        const value = metricValue(e, metric);
        const pct = Math.round((value / top) * 100);
        return (
          <div
            key={e.agentId}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
              style ? style.ring : "border-border bg-card/40 hover:bg-muted/30",
            )}
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center">
              {style ? (
                <style.icon className={cn("h-4 w-4", style.cls)} />
              ) : (
                <span className="text-xs font-semibold text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium text-foreground">{e.name}</span>
                {showTeam && e.teamName && (
                  <span className="truncate text-[10px] text-muted-foreground">{e.teamName}</span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Progress value={pct} className="h-1.5 flex-1" />
                <span className="w-11 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                  {e.calls} calls
                </span>
              </div>
            </div>

            <div className="shrink-0 text-right">
              <div
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  i === 0 ? "text-amber-400" : "text-foreground",
                )}
              >
                {formatMetric(value, metric)}
              </div>
              <div className="text-[10px] text-muted-foreground">{METRIC_LABEL[metric]}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
