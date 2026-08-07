import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useRoster, type AgentRef } from "@/lib/team-store";
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { getAgentTimeStats, formatDuration, formatClockTime } from "@/lib/agent-time-stats";

export const Route = createFileRoute("/dashboard/team")({
  head: () => ({
    meta: [
      { title: "Team Activity · SamvadX" },
      { name: "description", content: "Every agent's calling, idle and disposition time today." },
    ],
  }),
  component: TeamActivityPage,
});

function isSameDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

type SortKey = "name" | "calling" | "disposition" | "idle" | "loggedIn";
type SortDir = "asc" | "desc";

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
        case "disposition":
          return (a.stats.dispositionSeconds - b.stats.dispositionSeconds) * dir;
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
            Calling, idle, and disposition time for every agent today.
          </p>
        </div>
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground rounded-lg border border-border bg-card px-2.5 py-1.5"
          title="Calling time is real, from logged calls. Idle, disposition and login/logout times are estimated — real presence tracking is coming soon."
        >
          <Info className="h-3.5 w-3.5 flex-shrink-0" />
          Idle/disposition/login times are estimated
        </span>
      </div>

      {roster.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No teammates found yet.
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
                    <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Calling" sortKeyName="calling" />
                    </th>
                    <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Disposition" sortKeyName="disposition" />
                    </th>
                    <th className="py-2 pr-4 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Idle" sortKeyName="idle" />
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
                      <td className="py-2.5 text-right text-xs font-medium text-foreground tabular-nums">
                        {formatDuration(stats.callingSeconds)}
                      </td>
                      <td className="py-2.5 text-right text-xs text-muted-foreground tabular-nums">
                        {formatDuration(stats.dispositionSeconds)}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-xs text-muted-foreground tabular-nums">
                        {formatDuration(stats.idleSeconds)}
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
