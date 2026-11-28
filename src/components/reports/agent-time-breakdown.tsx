// "What did this agent do?" — the agent report's time section (user, 2026-11-28: agents told the
// manager the system's idle / calling / ringing figures were wrong, so the report must be easy to
// check). One table that ADDS UP — talking + ringing + wrap-up + break + idle = signed-in time —
// with a plain-English line for each, the rules stated on the page (8 am–8 pm, the company's fixed
// break left out), and for the last day of the period a call-by-call and sign-in timeline the
// agent can compare against their own memory.
import { useMemo } from "react";
import { Clock3 } from "lucide-react";
import {
  WORK_END_HOUR,
  WORK_START_HOUR,
  effectiveEnd,
  fixedBreakWindow,
  formatDuration,
  getFixedBreak,
  workWindow,
  type AgentTimeStats,
} from "@/lib/agent-time-stats";
import type { DispositionRecord } from "@/lib/disposition-store";
import type { StatusInterval } from "@/lib/agent-presence-store";
import { istDayKey } from "@/lib/monthly-trend";
import { cn } from "@/lib/utils";

const hh = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? " am" : " pm"}`;
/** "13:10" → "1:10 pm". */
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
const t = (ms: number | string | Date) =>
  new Date(ms).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
  });

interface Row {
  key: string;
  label: string;
  seconds: number | null;
  bar: string;
  text: string;
  what: string;
}

export function AgentTimeBreakdown({
  agentId,
  agentName,
  time,
  disps,
  intervals,
  fromDay,
  toDay,
  avgCallSeconds,
}: {
  agentId: string;
  agentName: string;
  time: AgentTimeStats;
  disps: DispositionRecord[];
  intervals: StatusInterval[];
  fromDay: string;
  toDay: string;
  avgCallSeconds: number;
}) {
  const fb = getFixedBreak();
  const first = agentName.split(" ")[0];

  const rows: Row[] = [
    {
      key: "talk",
      label: "Talking",
      seconds: time.callingSeconds,
      bar: "bg-success",
      text: "text-success",
      what: "Time on connected calls, from the call's start to its end.",
    },
    {
      key: "ring",
      label: "Ringing",
      seconds: time.ringingSeconds,
      bar: "bg-sky-500",
      text: "text-sky-600 dark:text-sky-400",
      what: "Time the borrower's phone rang before it was picked up (or nobody answered).",
    },
    {
      key: "wrap",
      label: "Wrap-up",
      seconds: time.dispositionSeconds,
      bar: "bg-violet-500",
      text: "text-violet-600 dark:text-violet-400",
      what: "From the call ending until the disposition (outcome) was saved.",
    },
    {
      key: "break",
      label: "Break (chosen by the agent)",
      seconds: time.breakSeconds,
      bar: "bg-blue-500",
      text: "text-blue-600 dark:text-blue-400",
      what: "Time in Break, Lunch or Training status, outside the fixed company break.",
    },
    {
      key: "idle",
      label: "Idle",
      seconds: time.idleSeconds,
      bar: "bg-amber-500",
      text: "text-amber-600 dark:text-amber-400",
      what: "Signed in, but not on a call, ringing, wrapping up or on a break.",
    },
  ];

  const accounted = rows.reduce((a, r) => a + (r.seconds ?? 0), 0);
  const signedIn = Math.max(time.loggedInSeconds ?? 0, accounted);
  const raised = (time.loggedInSeconds ?? 0) < accounted;
  const pct = (s: number | null) => (signedIn > 0 && s ? Math.round((s / signedIn) * 100) : 0);

  // ── Timeline of the last day of the period ──
  const day = toDay;
  const timeline = useMemo(() => {
    const w = workWindow(day);
    const lunch = fixedBreakWindow(day);
    const calls = disps
      .filter((d) => istDayKey(d.time) === day)
      .filter((d) => {
        const ms = new Date(d.time).getTime();
        return ms >= w.start && ms < w.end;
      })
      .sort((a, b) => a.time.localeCompare(b.time));
    const segs = intervals
      .filter((i) => i.agentId === agentId && i.status !== "offline")
      .flatMap((i) => {
        const from = Math.max(Date.parse(i.startedAt), w.start);
        const to = Math.min(effectiveEnd(i), w.end);
        return to > from ? [{ status: String(i.status), from, to }] : [];
      })
      .sort((a, b) => a.from - b.from);
    return { calls, segs, lunch };
  }, [disps, intervals, agentId, day]);

  const multiDay = fromDay !== toDay;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Clock3 className="h-3 w-3" />
        What {first} did {multiDay ? `(${fromDay} to ${toDay})` : `(${toDay})`}
        {!time.presenceRecorded && (
          <span className="ml-1 normal-case tracking-normal text-amber-500">
            · sign-in time not recorded for this period
          </span>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
          How this is counted: only{" "}
          <strong className="text-foreground">
            {hh(WORK_START_HOUR)} – {hh(WORK_END_HOUR)}
          </strong>{" "}
          each day
          {fb && (
            <>
              , and the company&apos;s fixed break{" "}
              <strong className="text-foreground">
                {clock(fb.start)} – {clock(fb.end)}
              </strong>{" "}
              is left out (nobody is counted idle at lunch; it is shown on its own below)
            </>
          )}
          . The five lines add up to the signed-in time.
        </div>

        {/* One bar: how the signed-in time was spent. */}
        {signedIn > 0 && (
          <div className="px-3 pt-3">
            <div className="flex h-3 overflow-hidden rounded-full bg-muted">
              {rows.map((r) =>
                r.seconds ? (
                  <div
                    key={r.key}
                    className={r.bar}
                    style={{ width: `${(r.seconds / signedIn) * 100}%` }}
                    title={`${r.label}: ${formatDuration(r.seconds)}`}
                  />
                ) : null,
              )}
            </div>
          </div>
        )}

        <table className="w-full text-xs">
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="w-44 px-3 py-2 align-top">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <span className={cn("h-2 w-2 rounded-full", r.bar)} />
                    {r.label}
                  </span>
                </td>
                <td
                  className={cn(
                    "w-24 px-3 py-2 text-right align-top font-mono tabular-nums",
                    r.text,
                  )}
                >
                  {r.seconds == null ? "—" : formatDuration(r.seconds)}
                  {r.seconds ? (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {pct(r.seconds)}%
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-[11px] text-muted-foreground">{r.what}</td>
              </tr>
            ))}
            <tr className="bg-muted/30 font-semibold">
              <td className="px-3 py-2 text-foreground">Signed in (counted)</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                {time.presenceRecorded || accounted > 0 ? formatDuration(signedIn) : "—"}
              </td>
              <td className="px-3 py-2 text-[11px] font-normal text-muted-foreground">
                {time.loginTime
                  ? `First sign-in ${t(time.loginTime)}${time.logoutTime ? `, last sign-out ${t(time.logoutTime)}` : ", still signed in"}.`
                  : "No sign-in recorded."}
                {raised &&
                  " Calls were logged for longer than the recorded sign-in time (the app was closed or not heartbeating), so signed-in time is raised to match them."}
              </td>
            </tr>
            {fb && (
              <tr>
                <td className="px-3 py-2 font-medium text-foreground">
                  Fixed break ({clock(fb.start)}–{clock(fb.end)})
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {time.lunchSeconds == null ? "—" : formatDuration(time.lunchSeconds)}
                </td>
                <td className="px-3 py-2 text-[11px] text-muted-foreground">
                  The company&apos;s daily break. Not counted as signed-in, idle or break time.
                  Calls saved during it still count as calls.
                </td>
              </tr>
            )}
            <tr>
              <td className="px-3 py-2 font-medium text-foreground">Average call</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {formatDuration(avgCallSeconds)}
              </td>
              <td className="px-3 py-2 text-[11px] text-muted-foreground">
                Talking time divided by the number of calls.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Compare against memory: what happened on the last day of the period, in order. */}
      <details className="rounded-lg border border-border bg-card" open={!multiDay}>
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">
          {first}&apos;s day, step by step ({day}) — {timeline.calls.length}{" "}
          {timeline.calls.length === 1 ? "call" : "calls"}
        </summary>
        <div className="grid gap-3 border-t border-border p-3 lg:grid-cols-[18rem_1fr]">
          <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Signed in
            </div>
            {timeline.segs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No sign-in recorded for this day.</p>
            ) : (
              <ul className="space-y-1 text-[11px]">
                {timeline.segs.map((s, i) => (
                  <li key={i} className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "capitalize",
                        s.status === "available"
                          ? "text-success"
                          : "text-blue-600 dark:text-blue-400",
                      )}
                    >
                      {s.status}
                    </span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {t(s.from)} – {t(s.to)} · {formatDuration(Math.round((s.to - s.from) / 1000))}
                    </span>
                  </li>
                ))}
                {timeline.lunch && fb && (
                  <li className="flex items-center justify-between gap-2 border-t border-border pt-1">
                    <span className="text-muted-foreground">Fixed break (not counted)</span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {clock(fb.start)} – {clock(fb.end)}
                    </span>
                  </li>
                )}
              </ul>
            )}
          </div>
          <div className="min-w-0">
            <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Calls (time = when the outcome was saved)
            </div>
            {timeline.calls.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No calls saved on this day.</p>
            ) : (
              <div className="max-h-80 overflow-auto rounded-md border border-border">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">Saved at</th>
                      <th className="px-2 py-1.5 font-medium">Borrower</th>
                      <th className="px-2 py-1.5 font-medium">Outcome</th>
                      <th className="px-2 py-1.5 text-right font-medium">Ringing</th>
                      <th className="px-2 py-1.5 text-right font-medium">Talking</th>
                      <th className="px-2 py-1.5 text-right font-medium">Wrap-up</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {timeline.calls.map((d) => (
                      <tr key={d.id}>
                        <td className="whitespace-nowrap px-2 py-1 font-mono tabular-nums">
                          {t(d.time)}
                        </td>
                        <td className="max-w-[10rem] truncate px-2 py-1 text-foreground">
                          {d.debtorName || "Manual call"}
                        </td>
                        <td className="px-2 py-1 capitalize text-muted-foreground">
                          {String(d.outcome).replace(/_/g, " ")}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-sky-600 dark:text-sky-400">
                          {d.ringSeconds != null ? formatDuration(d.ringSeconds) : "—"}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-success">
                          {formatDuration(d.durationSeconds ?? 0)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular-nums text-violet-600 dark:text-violet-400">
                          {d.wrapSeconds != null ? formatDuration(d.wrapSeconds) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
