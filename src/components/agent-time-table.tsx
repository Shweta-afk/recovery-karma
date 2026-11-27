// Everyone's time today, on Live Calls (user, 2026-11-27) — replaces the top-3 leaderboard, which
// showed only a few people. One row per agent: status now, ringing, talking, wrap-up, idle,
// break and logged-in time since midnight IST. Same figures as Team Activity and Reports
// (getAgentTimeStats: talk from call logs, ring/wrap from the dialler, break and idle from
// agent_status_log), scoped by RLS to the viewer's team (manager) or company (admin). A blank
// "—" means not recorded, never zero.
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Users } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { fetchStatusIntervals, todayPresenceKey } from "@/lib/agent-presence-store";
import type { StatusInterval } from "@/lib/agent-presence-store";
import { getAgentTimeStats, formatDuration, formatDurationOrDash } from "@/lib/agent-time-stats";
import { currentStatusOf, isOnBreak, statusLabel } from "@/lib/agent-current-status";
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

type SortKey = "name" | "ringing" | "calling" | "wrap" | "idle" | "break" | "loggedIn";

const COLUMNS: { key: SortKey; label: string; hint: string }[] = [
  { key: "ringing", label: "Ringing", hint: "Time calls spent ringing before they were answered" },
  { key: "calling", label: "Talking", hint: "Time on calls" },
  { key: "wrap", label: "Wrap-up", hint: "From the call ending to the disposition being saved" },
  { key: "idle", label: "Idle", hint: "Signed in, with no call, wrap-up or break" },
  { key: "break", label: "Break", hint: "Break, lunch and training time" },
  { key: "loggedIn", label: "Logged in", hint: "Total time signed in today" },
];

export function AgentTimeTable({ search }: { search: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [intervals, setIntervals] = useState<StatusInterval[]>([]);
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });
  const [now, setNow] = useState(() => Date.now());
  const day = todayPresenceKey();

  useEffect(() => {
    const reload = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", reload);
    void refreshDispositions().then(reload);
    return () => window.removeEventListener("dispositions-updated", reload);
  }, []);

  // Who, and their status intervals today — every 30 s (break changes should show quickly).
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
      setNow(Date.now());
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [day]);

  const rows = useMemo(() => {
    const today = disps.filter((d) => istDayKey(d.time) === day);
    return people.map((p) => {
      const stats = getAgentTimeStats(
        p.email,
        today.filter((d) => d.agentId === p.email),
        day,
        intervals,
      );
      return { person: p, stats, now: currentStatusOf(intervals, p.email, now) };
    });
  }, [people, disps, intervals, day, now]);

  const needle = search.trim().toLowerCase();
  const shown = useMemo(() => {
    const value = (r: (typeof rows)[number]): number | string => {
      switch (sort.key) {
        case "name":
          return r.person.name.toLowerCase();
        case "ringing":
          return r.stats.ringingSeconds ?? -1;
        case "calling":
          return r.stats.callingSeconds;
        case "wrap":
          return r.stats.dispositionSeconds ?? -1;
        case "idle":
          return r.stats.idleSeconds ?? -1;
        case "break":
          return r.stats.breakSeconds ?? -1;
        case "loggedIn":
          return r.stats.loggedInSeconds ?? -1;
      }
    };
    const list = rows.filter((r) => !needle || r.person.name.toLowerCase().includes(needle));
    list.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const c = typeof av === "string" ? av.localeCompare(String(bv)) : av - (bv as number);
      return sort.dir === "asc" ? c : -c;
    });
    return list;
  }, [rows, needle, sort]);

  const onBreak = shown.filter((r) => isOnBreak(r.now)).length;

  const head = (key: SortKey, label: string, hint?: string, align = "text-right") => (
    <th key={key} title={hint} className={cn("px-3 py-2 font-medium text-muted-foreground", align)}>
      <button
        type="button"
        onClick={() =>
          setSort((s) => ({
            key,
            dir:
              s.key === key ? (s.dir === "asc" ? "desc" : "asc") : key === "name" ? "asc" : "desc",
          }))
        }
        className="inline-flex items-center gap-0.5 hover:text-foreground"
      >
        {label}
        {sort.key === key &&
          (sort.dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </button>
    </th>
  );

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
        <Users className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">Everyone today</span>
        <span className="text-[11px] text-muted-foreground">
          {shown.length} {shown.length === 1 ? "person" : "people"} · since midnight
          {onBreak > 0 && (
            <>
              {" · "}
              <strong className="text-blue-600 dark:text-blue-400">{onBreak} on break now</strong>
            </>
          )}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          {people.length ? "Nobody matches that name." : "Loading…"}
        </p>
      ) : (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border">
                {head("name", "Agent", undefined, "text-left")}
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Now</th>
                {COLUMNS.map((c) => head(c.key, c.label, c.hint))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map(({ person, stats, now: cur }) => {
                const brk = isOnBreak(cur);
                return (
                  <tr key={person.email} className="hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium text-foreground">{person.name}</td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-3 py-2",
                        brk
                          ? "font-medium text-blue-600 dark:text-blue-400"
                          : cur
                            ? "text-success"
                            : "text-muted-foreground",
                      )}
                    >
                      {statusLabel(cur)}
                      {cur && brk && (
                        <span className="ml-1 font-normal text-muted-foreground">
                          since{" "}
                          {new Date(cur.since).toLocaleTimeString("en-IN", {
                            hour: "numeric",
                            minute: "2-digit",
                            timeZone: "Asia/Kolkata",
                          })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-blue-500">
                      {formatDurationOrDash(stats.ringingSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">
                      {formatDuration(stats.callingSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-violet-600 dark:text-violet-400">
                      {formatDurationOrDash(stats.dispositionSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-600 dark:text-amber-400">
                      {formatDurationOrDash(stats.idleSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-blue-600 dark:text-blue-400">
                      {formatDurationOrDash(stats.breakSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatDurationOrDash(stats.loggedInSeconds)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        Click a heading to sort. &quot;—&quot; = not recorded (nobody signed in yet, or no calls
        with that figure), never zero. Idle = signed in with no call, wrap-up or break. Break
        includes lunch and training. &quot;Now&quot; is the status the agent picked; someone not
        heard from for 3 minutes shows as not signed in.
      </p>
    </div>
  );
}
