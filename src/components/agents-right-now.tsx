// "Agents right now" on Live Calls (2026-11-25): every calling agent's live state with a running
// timer — on a call, wrapping up (call ended, disposition not saved yet), idle (Available with
// no call), or on a break. Managers asked to see who is doing nothing and how long agents spend
// writing dispositions.
//
// Sources, all scoped by RLS to what the viewer may see (a manager's team, an admin's company):
//   - live_calls rows: ringing / connected / wrapup, written by each agent's own browser
//     (call-session.tsx). Wrap-up is timed from phase_since.
//   - agent_status_log: the agent's chosen status (Available, Break, …) — agent-presence-store.
//   - live_calls rows that ended recently: an Available agent is idle since their last call or
//     wrap-up ended, or since they became Available, whichever is later.
import { useEffect, useMemo, useState } from "react";
import { Coffee, Hourglass, PhoneCall, PenLine, PowerOff } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  PRESENCE_STALE_MS,
  fetchStatusIntervals,
  todayPresenceKey,
} from "@/lib/agent-presence-store";
import type { LiveCall } from "@/lib/live-calls-store";

type State = "wrapup" | "idle" | "on_call" | "break" | "offline";

interface AgentNow {
  id: string;
  name: string;
  state: State;
  /** When the current state began (ms); null when unknown. */
  since: number | null;
  /** Break / lunch / training — the status the agent picked. */
  detail?: string;
}

const STATE_META: Record<State, { label: string; cls: string; icon: typeof Hourglass }> = {
  wrapup: { label: "Wrap-up", cls: "text-violet-600 dark:text-violet-400", icon: PenLine },
  idle: { label: "Idle", cls: "text-amber-600 dark:text-amber-400", icon: Hourglass },
  on_call: { label: "On a call", cls: "text-success", icon: PhoneCall },
  break: { label: "Break", cls: "text-blue-600 dark:text-blue-400", icon: Coffee },
  offline: { label: "Not signed in", cls: "text-muted-foreground", icon: PowerOff },
};

/** Seconds after which a state turns amber / red on screen. */
const WARN: Partial<Record<State, [number, number]>> = {
  wrapup: [60, 120],
  idle: [120, 240],
};

/** Idle longer than this counts as a break (user, 2026-11-25). */
const IDLE_IS_BREAK_SECONDS = 5 * 60;

function since(ms: number | null, now: number): string {
  if (ms == null) return "—";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${sec}s` : `${sec}s`;
}

const ORDER: State[] = ["wrapup", "idle", "break", "on_call", "offline"];
/** On a call: counted, not listed (user, 2026-11-25) — the call cards below show them. */
const LISTED: State[] = ["wrapup", "idle", "break", "offline"];

export function AgentsRightNow({ liveRows, search }: { liveRows: LiveCall[]; search: string }) {
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [status, setStatus] = useState<
    Map<string, { status: string; startedAt: number; seenAt: number }>
  >(new Map());
  const [lastEnd, setLastEnd] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  // Who, their status, and when their last call/wrap-up ended — every 15 s.
  useEffect(() => {
    let live = true;
    const load = async () => {
      const { data: rows } = await supabase
        .from("agents")
        .select("id, name, role, is_active, agent_extension")
        .eq("is_active", true)
        .in("role", ["agent", "manager"])
        .not("agent_extension", "is", null);
      const list = ((rows ?? []) as { id: string; name: string }[]).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ""),
      }));
      const ids = list.map((a) => a.id);
      const [intervals, ended] = await Promise.all([
        fetchStatusIntervals(ids, todayPresenceKey()),
        ids.length
          ? supabase
              .from("live_calls")
              .select("agent_id, ended_at")
              .in("agent_id", ids)
              .not("ended_at", "is", null)
              .gte("ended_at", new Date(Date.now() - 3 * 3600_000).toISOString())
              .order("ended_at", { ascending: false })
              .limit(1000)
          : Promise.resolve({ data: [] as { agent_id: string; ended_at: string }[] }),
      ]);
      if (!live) return;
      // The status each signed-in person is in: their open interval with a recent heartbeat
      // (usePresenceHeartbeat on every page). An open interval with no heartbeat for
      // PRESENCE_STALE_MS is a closed laptop, not a signed-in agent.
      const st = new Map<string, { status: string; startedAt: number; seenAt: number }>();
      for (const i of intervals) {
        if (i.endedAt) continue;
        const t = Date.parse(i.startedAt);
        const seenAt = Date.parse(i.lastSeenAt ?? i.startedAt);
        if (Date.now() - seenAt > PRESENCE_STALE_MS) continue;
        const prev = st.get(i.agentId);
        if (!prev || t > prev.startedAt)
          st.set(i.agentId, { status: i.status, startedAt: t, seenAt });
      }
      const le = new Map<string, number>();
      for (const r of (ended.data ?? []) as { agent_id: string; ended_at: string }[]) {
        if (!le.has(String(r.agent_id))) le.set(String(r.agent_id), Date.parse(r.ended_at));
      }
      setAgents(list);
      setStatus(st);
      setLastEnd(le);
    };
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const people = useMemo<AgentNow[]>(() => {
    const rowByAgent = new Map<string, LiveCall>();
    for (const r of liveRows) if (!r.stale) rowByAgent.set(r.agentId, r);
    return agents.map((a) => {
      const row = rowByAgent.get(a.id);
      if (row?.phase === "wrapup")
        return { ...a, state: "wrapup", since: Date.parse(row.phaseSince) || null };
      if (row) return { ...a, state: "on_call", since: Date.parse(row.startedAt) || null };
      const s = status.get(a.id);
      if (!s || s.status === "offline") return { ...a, state: "offline", since: null };
      if (s.status !== "available")
        return { ...a, state: "break", since: s.startedAt, detail: s.status };
      const idleSince = Math.max(s.startedAt, lastEnd.get(a.id) ?? 0);
      // Idle past 5 minutes is a break (user, 2026-11-25), timed from when they went idle.
      if ((now - idleSince) / 1000 >= IDLE_IS_BREAK_SECONDS)
        return { ...a, state: "break", since: idleSince, detail: "Idle over 5 min" };
      return { ...a, state: "idle", since: idleSince };
    });
  }, [agents, liveRows, status, lastEnd, now]);

  const needle = search.trim().toLowerCase();
  const shown = people
    .filter((p) => !needle || p.name.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.since ?? now) - (b.since ?? now),
    );
  const count = (s: State) => shown.filter((p) => p.state === s).length;

  if (!agents.length) return null;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold text-foreground">Agents right now</span>
        {ORDER.map((s) => {
          const M = STATE_META[s];
          return (
            <span key={s} className={cn("inline-flex items-center gap-1 text-xs", M.cls)}>
              <M.icon className="h-3.5 w-3.5" />
              {M.label} <strong className="tabular-nums">{count(s)}</strong>
            </span>
          );
        })}
      </div>
      <p className="px-4 pt-2 text-[11px] text-muted-foreground">
        Wrap-up = the call has ended and the disposition isn&apos;t saved yet. Idle = signed in and
        Available with no call, since their last call or since they became Available; after 5
        minutes they move to Break. Not signed in = no app open (checked every minute). People on a
        call are counted, not listed — their calls are below.
      </p>
      <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown
          .filter((p) => LISTED.includes(p.state))
          .map((p) => {
            const M = STATE_META[p.state];
            const secs = p.since == null ? 0 : (now - p.since) / 1000;
            const warn = WARN[p.state];
            const level = warn ? (secs >= warn[1] ? "red" : secs >= warn[0] ? "amber" : "") : "";
            return (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2",
                  level === "red"
                    ? "border-destructive/40 bg-destructive/5"
                    : level === "amber"
                      ? "border-amber-500/40 bg-amber-500/5"
                      : "border-border",
                )}
              >
                <M.icon className={cn("h-4 w-4 flex-shrink-0", M.cls)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{p.name}</div>
                  <div className={cn("text-[11px]", M.cls)}>
                    {p.detail ? p.detail.charAt(0).toUpperCase() + p.detail.slice(1) : M.label}
                  </div>
                </div>
                <span
                  className={cn(
                    "font-mono text-xs tabular-nums",
                    level === "red"
                      ? "font-semibold text-destructive"
                      : level === "amber"
                        ? "font-semibold text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground",
                  )}
                >
                  {since(p.since, now)}
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}
