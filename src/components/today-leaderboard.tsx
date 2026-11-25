// Today's leaderboard beside the Live Calls KPI cards (2026-11-25): the agents with the most
// wrap-up, break and idle time today — the least productive — and the agent with the most time
// on calls. Same figures as Team Activity (getAgentTimeStats: talk from call logs, wrap-up from
// wrap_seconds, break and idle from agent_status_log), so the two screens agree. Scoped by RLS
// to the viewer's team (manager) or company (admin).
import { useEffect, useMemo, useState } from "react";
import { Coffee, Hourglass, PenLine, PhoneCall, Trophy } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { fetchStatusIntervals, todayPresenceKey } from "@/lib/agent-presence-store";
import type { StatusInterval } from "@/lib/agent-presence-store";
import { getAgentTimeStats } from "@/lib/agent-time-stats";
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { istDayKey } from "@/lib/monthly-trend";

interface Person {
  email: string;
  name: string;
}

type Metric = "dispositionSeconds" | "breakSeconds" | "idleSeconds" | "callingSeconds";

const BOARDS: {
  metric: Metric;
  title: string;
  icon: typeof PenLine;
  cls: string;
  bar: string;
}[] = [
  {
    metric: "dispositionSeconds",
    title: "Most wrap-up",
    icon: PenLine,
    cls: "text-violet-600 dark:text-violet-400",
    bar: "bg-violet-500",
  },
  {
    metric: "breakSeconds",
    title: "Most on break",
    icon: Coffee,
    cls: "text-blue-600 dark:text-blue-400",
    bar: "bg-blue-500",
  },
  {
    metric: "idleSeconds",
    title: "Most idle",
    icon: Hourglass,
    cls: "text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
  },
  {
    metric: "callingSeconds",
    title: "Most time on calls",
    icon: PhoneCall,
    cls: "text-success",
    bar: "bg-success",
  },
];

function hm(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${Math.round(s)}s`;
}

export function TodayLeaderboard({ search }: { search: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [intervals, setIntervals] = useState<StatusInterval[]>([]);
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  const day = todayPresenceKey();

  useEffect(() => {
    const reload = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", reload);
    void refreshDispositions().then(reload);
    return () => window.removeEventListener("dispositions-updated", reload);
  }, []);

  // Who, and their status intervals today — every minute.
  useEffect(() => {
    let live = true;
    const load = async () => {
      const { data } = await supabase
        .from("agents")
        .select("name, email, role, is_active, agent_extension")
        .eq("is_active", true)
        .in("role", ["agent", "manager"])
        .not("agent_extension", "is", null);
      const list = ((data ?? []) as { name: string; email: string }[])
        .filter((r) => !!r.email)
        .map((r) => ({ email: String(r.email), name: String(r.name ?? r.email) }));
      const iv = await fetchStatusIntervals(
        list.map((p) => p.email),
        day,
      );
      if (!live) return;
      setPeople(list);
      setIntervals(iv);
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [day]);

  const stats = useMemo(() => {
    const today = disps.filter((d) => istDayKey(d.time) === day);
    return people.map((p) => ({
      person: p,
      stats: getAgentTimeStats(
        p.email,
        today.filter((d) => d.agentId === p.email),
        day,
        intervals,
      ),
    }));
  }, [people, disps, intervals, day]);

  const needle = search.trim().toLowerCase();
  const shown = needle ? stats.filter((s) => s.person.name.toLowerCase().includes(needle)) : stats;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Trophy className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-semibold text-foreground">Today&apos;s leaderboard</span>
        <span className="ml-auto text-[11px] text-muted-foreground">Top 3 · since midnight</span>
      </div>
      <div className="grid gap-x-4 gap-y-3 p-3 sm:grid-cols-2">
        {BOARDS.map((b) => {
          const ranked = shown
            .map((s) => ({ name: s.person.name, secs: s.stats[b.metric] ?? 0 }))
            .filter((r) => r.secs > 0)
            .sort((x, y) => y.secs - x.secs)
            .slice(0, 3);
          const top = ranked[0]?.secs ?? 0;
          return (
            <div key={b.metric}>
              <div className={cn("mb-1.5 flex items-center gap-1.5 text-xs font-medium", b.cls)}>
                <b.icon className="h-3.5 w-3.5" />
                {b.title}
              </div>
              {ranked.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Nothing recorded yet today.</p>
              ) : (
                <ol className="space-y-1">
                  {ranked.map((r, i) => (
                    <li key={r.name} className="text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 text-muted-foreground tabular-nums">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-foreground">{r.name}</span>
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {hm(r.secs)}
                        </span>
                      </div>
                      <div className="ml-4 mt-0.5 h-1 rounded-full bg-muted">
                        <div
                          className={cn("h-1 rounded-full", b.bar)}
                          style={{ width: `${top ? Math.max(4, (r.secs / top) * 100) : 0}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
