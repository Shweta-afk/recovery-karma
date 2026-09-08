import { useState } from "react";
import { Trophy, Medal, Award, Crown, ChevronDown } from "lucide-react";
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

/** Same initials scheme "Assigned Agents" (portfolio-dashboard.tsx) already uses — every
 * first letter, uncapped, so this reads identically wherever an agent shows up as an avatar. */
function initials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("");
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
  // A podium only reads as a podium with all three steps present — for a small team (1-2
  // agents with any activity) it just falls through to the plain ranked list below, unchanged.
  const podium = ranked.length >= 3 ? ranked.slice(0, 3) : [];
  const rest = podium.length ? ranked.slice(3) : ranked;

  return (
    <div className="space-y-4">
      {podium.length === 3 && (
        <div className="grid grid-cols-3 items-end gap-2.5">
          {[podium[1], podium[0], podium[2]].map((e, col) => {
            const isFirst = col === 1;
            const value = metricValue(e, metric);
            return (
              <div
                key={e.agentId}
                className={cn(
                  "relative flex flex-col items-center gap-0.5 rounded-xl border px-2.5 pb-4 text-center",
                  isFirst
                    ? "order-2 border-amber-400/40 bg-gradient-to-b from-amber-400/12 to-card pt-7 shadow-md"
                    : "order-1 self-end border-border bg-card/60 pt-4 last:order-3",
                )}
              >
                {isFirst && (
                  <Crown className="absolute -top-3.5 left-1/2 h-4 w-4 -translate-x-1/2 fill-amber-400 text-amber-400" />
                )}
                <div
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-full font-bold",
                    isFirst
                      ? "h-12 w-12 bg-gradient-to-br from-amber-300 to-amber-500 text-sm text-amber-950 ring-2 ring-amber-400/50"
                      : "h-9 w-9 bg-muted text-xs text-muted-foreground",
                  )}
                >
                  {initials(e.name)}
                </div>
                <div className="mt-1 line-clamp-1 max-w-full text-xs font-semibold text-foreground">
                  {e.name}
                </div>
                {showTeam && e.teamName && (
                  <div className="line-clamp-1 max-w-full text-[10px] text-muted-foreground">
                    {e.teamName}
                  </div>
                )}
                <div
                  className={cn(
                    "mt-0.5 font-bold tabular-nums",
                    isFirst ? "text-lg text-amber-500" : "text-sm text-foreground",
                  )}
                >
                  {formatMetric(value, metric)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {e.calls} calls · {e.ptps} PTPs
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="space-y-1.5">
        {rest.map((e, i) => {
          // Below the podium, ranks pick up at 4 — the trophy/medal/award treatment already
          // rendered for 1-3 up there. Without a podium (fewer than 3 total), this is the
          // original flat ranked list, icons and all.
          const rank = podium.length ? i + 4 : i + 1;
          const style = podium.length ? null : rankStyle(i);
          const value = metricValue(e, metric);
          const pct = Math.round((value / top) * 100);
          return (
            <div
              key={e.agentId}
              className={cn(
                "flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors",
                style ? style.ring : "border-border bg-card/40 hover:bg-muted/30",
              )}
            >
              <div className="flex h-6 w-6 shrink-0 items-center justify-center">
                {style ? (
                  <style.icon className={cn("h-4 w-4", style.cls)} />
                ) : (
                  <span className="text-xs font-semibold text-muted-foreground tabular-nums">
                    {rank}
                  </span>
                )}
              </div>
              {podium.length > 0 && (
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                  {initials(e.name)}
                </div>
              )}

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
                    !podium.length && i === 0 ? "text-amber-400" : "text-foreground",
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
    </div>
  );
}

export interface TeamLeaderboardEntry {
  teamId: string;
  teamName: string;
  managerName: string;
  collected: number;
  calls: number;
  ptps: number;
  contactRate: number;
  // This team's own agents, already ranked — the drill-down under each team card. Reuses
  // LeaderboardEntry rather than a new shape since it's exactly agentStats/leaderboardEntries
  // filtered to this team (see admin.reports.tsx).
  members: LeaderboardEntry[];
}

/** Admin-only: which TEAM is leading, not just which agent — promoted from the plain "Team
 * Standings" DataTable to the same podium treatment as the agent Leaderboard above, plus a
 * per-team drill-down into which members are actually carrying that team's number. */
export function TeamLeaderboard({
  teams,
  limit = 10,
}: {
  teams: TeamLeaderboardEntry[];
  limit?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const ranked = [...teams]
    .filter((t) => t.calls > 0 || t.collected > 0)
    .sort((a, b) => b.collected - a.collected)
    .slice(0, limit);

  if (ranked.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/40 py-10 text-center">
        <Trophy className="mx-auto h-7 w-7 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">
          No team activity yet — standings fill in as calls get logged.
        </p>
      </div>
    );
  }

  const podium = ranked.length >= 3 ? ranked.slice(0, 3) : [];

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const teamCard = (t: TeamLeaderboardEntry, isFirst: boolean, size: "lg" | "sm") => (
    <div
      className={cn(
        "relative flex flex-col items-center gap-0.5 rounded-xl border px-2.5 pb-4 text-center",
        isFirst
          ? "order-2 border-amber-400/40 bg-gradient-to-b from-amber-400/12 to-card pt-7 shadow-md"
          : "order-1 self-end border-border bg-card/60 pt-4 last:order-3",
      )}
    >
      {isFirst && (
        <Crown className="absolute -top-3.5 left-1/2 h-4 w-4 -translate-x-1/2 fill-amber-400 text-amber-400" />
      )}
      <div className="flex -space-x-2">
        {t.members.slice(0, 4).map((m) => (
          <div
            key={m.agentId}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full border-2 border-card font-bold",
              size === "lg" ? "h-8 w-8 text-[10px]" : "h-6 w-6 text-[8px]",
              isFirst
                ? "bg-gradient-to-br from-amber-300 to-amber-500 text-amber-950"
                : "bg-muted text-muted-foreground",
            )}
          >
            {initials(m.name)}
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-xs font-bold text-foreground">{t.teamName}</div>
      <div className="line-clamp-1 max-w-full text-[10px] text-muted-foreground">
        {t.members.length} agent{t.members.length === 1 ? "" : "s"} · {t.managerName}
      </div>
      <div
        className={cn(
          "mt-0.5 font-bold tabular-nums",
          isFirst ? "text-lg text-amber-500" : "text-sm text-foreground",
        )}
      >
        {formatINR(t.collected)}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {t.calls} calls · {t.ptps} PTPs · {t.contactRate}% contact
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {podium.length === 3 && (
        <div className="grid grid-cols-3 items-end gap-2.5">
          {teamCard(podium[1], false, "lg")}
          {teamCard(podium[0], true, "lg")}
          {teamCard(podium[2], false, "lg")}
        </div>
      )}

      <div className="space-y-1.5">
        {ranked.map((t, i) => {
          const rank = i + 1;
          const isOpen = expanded.has(t.teamId) || (i === 0 && podium.length > 0);
          // The #1 team is pinned open by default (see isOpen above) so admins see who's
          // carrying the top team without an extra click — its own row toggle is disabled so
          // that default can't be accidentally collapsed away.
          const canToggle = !(i === 0 && podium.length > 0);
          return (
            <div key={t.teamId} className="rounded-lg border border-border bg-card/40">
              <button
                type="button"
                onClick={() => canToggle && toggle(t.teamId)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                  canToggle && "hover:bg-muted/30",
                  !canToggle && "cursor-default",
                )}
              >
                <span className="w-4 shrink-0 text-center text-xs font-semibold text-muted-foreground tabular-nums">
                  {rank}
                </span>
                <div className="flex -space-x-1.5">
                  {t.members.slice(0, 3).map((m) => (
                    <div
                      key={m.agentId}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-card bg-muted text-[7px] font-semibold text-muted-foreground"
                    >
                      {initials(m.name)}
                    </div>
                  ))}
                </div>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {t.teamName}
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                  {formatINR(t.collected)}
                </span>
                {canToggle && (
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                      isOpen && "rotate-180",
                    )}
                  />
                )}
              </button>
              {isOpen && (
                <div className="space-y-1 border-t border-border px-3 py-2">
                  {t.members.length === 0 ? (
                    <p className="py-1 text-[11px] text-muted-foreground">
                      No agents on this team.
                    </p>
                  ) : (
                    [...t.members]
                      .sort((a, b) => b.collected - a.collected)
                      .map((m) => {
                        const share =
                          t.collected > 0 ? Math.round((m.collected / t.collected) * 100) : 0;
                        return (
                          <div key={m.agentId} className="flex items-center gap-2.5 py-1">
                            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground">
                              {initials(m.name)}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="truncate text-[11.5px] font-medium text-foreground">
                                  {m.name}
                                </span>
                                <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-foreground">
                                  {formatINR(m.collected)}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5">
                                <Progress value={share} className="h-1 flex-1" />
                                <span className="w-16 shrink-0 text-right text-[9.5px] text-muted-foreground">
                                  {share}% of team
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
