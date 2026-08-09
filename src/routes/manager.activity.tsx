import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useRoster, type AgentRef } from "@/lib/team-store";
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";
import {
  getAgentTimeStats,
  formatDuration,
  formatClockTime,
  pctOfShift,
  type AgentTimeStats,
} from "@/lib/agent-time-stats";

export const Route = createFileRoute("/manager/activity")({
  head: () => ({
    meta: [
      { title: "Team Activity · SamvadX" },
      {
        name: "description",
        content: "Every agent's ringing, calling, disposition and idle time, plus login/logout.",
      },
    ],
  }),
  component: TeamActivityPage,
});

// Manager/admin-only by design: login/logout times and a per-agent idle breakdown read like
// attendance monitoring, which shouldn't be visible peer-to-peer. This route lives under
// /manager (role-gated by manager.tsx's layout) rather than /dashboard — agents never see it.

function isSameDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

type SortKey = "name" | "calling" | "idle" | "loggedIn";
type SortDir = "asc" | "desc";

const SEGMENTS: { key: keyof AgentTimeStats; label: string; cls: string }[] = [
  { key: "ringingSeconds", label: "Ringing", cls: "bg-blue-500" },
  { key: "callingSeconds", label: "Calling", cls: "bg-primary" },
  { key: "dispositionSeconds", label: "Disposition", cls: "bg-amber-500" },
  { key: "idleSeconds", label: "Idle", cls: "bg-muted-foreground/30" },
];

/** One stacked horizontal bar per agent — Ringing/Calling/Disposition/Idle as proportional
 * segments of their logged-in day, in place of four separate numeric columns. */
function ActivityBar({ stats }: { stats: AgentTimeStats }) {
  const title = SEGMENTS.map(
    (s) => `${s.label}: ${formatDuration(stats[s.key] as number)} (${pctOfShift(stats[s.key] as number, stats)}%)`,
  ).join(" · ");
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="flex h-2.5 w-32 overflow-hidden rounded-full bg-muted">
        {SEGMENTS.map((s) => {
          const pct = pctOfShift(stats[s.key] as number, stats);
          return pct > 0 ? (
            <div key={s.key} className={s.cls} style={{ width: `${pct}%` }} />
          ) : null;
        })}
      </div>
      <span className="text-[11px] text-muted-foreground whitespace-nowrap">
        {formatDuration(stats.callingSeconds)} calling
      </span>
    </div>
  );
}

function useAllDispositions(): DispositionRecord[] {
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  useEffect(() => {
    const reload = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", reload);
    refreshDispositions().then(reload);
    return () => window.removeEventListener("dispositions-updated", reload);
  }, []);
  return disps;
}

function TeamActivityPage() {
  const roster = useRoster();
  const allDisps = useAllDispositions();
  const [sortKey, setSortKey] = useState<SortKey>("calling");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const rows = useMemo(() => {
    const now = new Date();
    return roster.map((agent: AgentRef) => {
      const todayDisps = allDisps.filter(
        (d) => d.agentId === agent.id && isSameDay(d.time, now),
      );
      return { agent, stats: getAgentTimeStats(agent.id, todayDisps) };
    });
  }, [roster, allDisps]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.agent.name.localeCompare(b.agent.name) * dir;
        case "calling":
          return (a.stats.callingSeconds - b.stats.callingSeconds) * dir;
        case "idle":
          return (a.stats.idleSeconds - b.stats.idleSeconds) * dir;
        case "loggedIn":
          return (a.stats.loggedInSeconds - b.stats.loggedInSeconds) * dir;
        default:
          return 0;
      }
    });
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const SortHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <button
      type="button"
      onClick={() => toggleSort(sortKeyName)}
      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
    >
      {label}
      {sortKey === sortKeyName ? (
        sortDir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Team Activity</h1>
          <p className="text-sm text-muted-foreground">
            Ringing, calling, disposition and idle time for every agent today.
          </p>
        </div>
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground rounded-lg border border-border bg-card px-2.5 py-1.5"
          title="Calling time is real, from logged calls. Ringing, idle, disposition and login/logout times are estimated — real presence tracking is coming soon."
        >
          <Info className="h-3.5 w-3.5 flex-shrink-0" />
          Ringing/idle/disposition/login times are estimated
        </span>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>Legend:</span>
        {SEGMENTS.map((s) => (
          <span key={s.key} className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${s.cls}`} />
            {s.label}
          </span>
        ))}
      </div>

      {roster.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No agents found yet.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/20">
                    <th className="py-2 pl-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Agent" sortKeyName="name" />
                    </th>
                    <th className="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Login
                    </th>
                    <th className="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Logout
                    </th>
                    <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Logged In" sortKeyName="loggedIn" />
                    </th>
                    <th className="py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Activity Breakdown" sortKeyName="calling" />
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.map(({ agent, stats }) => (
                    <tr key={agent.id} className="hover:bg-muted/20 transition-colors">
                      <td className="py-2.5 pl-4">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-primary/15 flex items-center justify-center text-[10px] font-semibold text-primary/80 flex-shrink-0">
                            {agent.name
                              .split(" ")
                              .map((n) => n[0])
                              .slice(0, 2)
                              .join("")
                              .toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-foreground truncate">
                              {agent.name}
                            </div>
                            {agent.role === "manager" && (
                              <Badge
                                variant="outline"
                                className="text-[9px] h-3.5 px-1 font-normal capitalize"
                              >
                                Manager
                              </Badge>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {formatClockTime(stats.loginTime)}
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {stats.logoutTime ? (
                          formatClockTime(stats.logoutTime)
                        ) : (
                          <span className="inline-flex items-center gap-1 text-success">
                            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                            Active
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right text-xs font-medium text-foreground tabular-nums">
                        {formatDuration(stats.loggedInSeconds)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <ActivityBar stats={stats} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
