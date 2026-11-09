import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { DateRangeFilter } from "@/components/date-range-filter";
import type { DateRange } from "@/lib/date-filter";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { getAuditSummary, listAuditCalls } from "@/lib/call-audit.server";
import {
  dispositionLabel,
  fmtSeconds,
  istDayKeyDaysAgo,
  type AuditCallRow,
  type AuditSummary,
} from "@/lib/call-audit";
import { istDateTime } from "@/lib/portfolio-feedback";

export const Route = createFileRoute("/auditor/")({
  head: () => ({ meta: [{ title: "Call Auditor · SamvadX" }] }),
  component: AuditorOverview,
});

const scoreText = (s: number | null) => (s === null ? "—" : `${s}%`);

function CallList({
  title,
  calls,
  empty,
}: {
  title: string;
  calls: AuditCallRow[];
  empty: string;
}) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {calls.length === 0 && <p className="text-xs text-muted-foreground">{empty}</p>}
      <ul className="divide-y divide-border">
        {calls.map((c) => (
          <li key={c.call_id}>
            <Link
              to="/auditor/calls"
              search={{ call: c.call_id }}
              className="flex items-center justify-between gap-3 py-2 hover:bg-accent/30"
            >
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">
                  {c.agent_name} · {c.customer_name || "Manual call"}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {istDateTime(c.created_at)} · {dispositionLabel(c.outcome)}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold text-foreground">
                {c.final_percent}%
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AuditorOverview() {
  const [range, setRange] = useState<DateRange>({
    from: istDayKeyDaysAgo(29),
    to: istDayKeyDaysAgo(0),
  });
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [best, setBest] = useState<AuditCallRow[]>([]);
  const [worst, setWorst] = useState<AuditCallRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const from = range.from || istDayKeyDaysAgo(29);
  const to = range.to || istDayKeyDaysAgo(0);

  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      const accessToken = await getAccessToken();
      const filters = { from, to, audit: "audited" as const };
      const [s, top, low] = await Promise.all([
        getAuditSummary({ data: { accessToken, from, to } }),
        listAuditCalls({
          data: { accessToken, filters: { ...filters, sort: "score_high" }, limit: 5, offset: 0 },
        }),
        listAuditCalls({
          data: { accessToken, filters: { ...filters, sort: "score_low" }, limit: 5, offset: 0 },
        }),
      ]);
      if (!live) return;
      setSummary(s);
      setBest(top.rows);
      setWorst(low.rows);
    })().catch((e) => live && setError(errorText(e, "Could not load the overview")));
    return () => {
      live = false;
    };
  }, [from, to]);

  const t = summary?.totals;
  const cards = t
    ? [
        { label: "Total Calls", value: t.calls },
        { label: "Connected", value: t.connected },
        { label: "With Recording", value: t.with_recording },
        { label: "AI Waiting for You", value: t.ai_waiting, warn: t.ai_waiting > 0 },
        { label: "Reviewed", value: t.audited },
        { label: "Average Score", value: scoreText(t.avg_score) },
        { label: "Fatal Errors", value: t.fatal, bad: t.fatal > 0 },
        { label: "Need Coaching", value: t.coaching, warn: t.coaching > 0 },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Auditor</h1>
          <p className="text-sm text-muted-foreground">Every call in your company, team by team.</p>
        </div>
        <DateRangeFilter value={range} onChange={setRange} />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!summary && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {cards.map((c) => (
              <Card key={c.label} className="p-3">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {c.label}
                </div>
                <div
                  className={cn(
                    "mt-1 text-2xl font-bold text-foreground",
                    c.bad && "text-destructive",
                    c.warn && "text-amber-600",
                  )}
                >
                  {c.value}
                </div>
              </Card>
            ))}
          </div>

          <Card className="overflow-x-auto">
            <h2 className="px-4 pt-4 text-sm font-semibold text-foreground">Teams and managers</h2>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  {[
                    "Team",
                    "Manager",
                    "Agents",
                    "Calls",
                    "Connected",
                    "Talk Time",
                    "Recorded",
                    "Reviewed",
                    "Avg Score",
                    "Fatal",
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.teams.map((r) => (
                  <tr key={r.team_id ?? "none"} className="hover:bg-accent/30">
                    <td className="px-4 py-2 font-medium">
                      {r.team_id ? (
                        <Link
                          to="/auditor/calls"
                          search={{ team: r.team_id }}
                          className="text-primary hover:underline"
                        >
                          {r.team_name}
                        </Link>
                      ) : (
                        r.team_name
                      )}
                    </td>
                    <td className="px-4 py-2">{r.manager_name ?? "—"}</td>
                    <td className="px-4 py-2">{r.agents}</td>
                    <td className="px-4 py-2">{r.calls}</td>
                    <td className="px-4 py-2">{r.connected}</td>
                    <td className="px-4 py-2">{fmtSeconds(r.talk_seconds)}</td>
                    <td className="px-4 py-2">{r.with_recording}</td>
                    <td className="px-4 py-2">{r.audited}</td>
                    <td className="px-4 py-2 font-semibold">{scoreText(r.avg_score)}</td>
                    <td
                      className={cn("px-4 py-2", r.fatal > 0 && "font-semibold text-destructive")}
                    >
                      {r.fatal}
                    </td>
                  </tr>
                ))}
                {summary.teams.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                      No calls in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <CallList title="Best calls" calls={best} empty="No calls reviewed yet." />
            <CallList
              title="Calls that need attention"
              calls={worst}
              empty="No calls reviewed yet."
            />
          </div>

          <Card className="overflow-x-auto">
            <h2 className="px-4 pt-4 text-sm font-semibold text-foreground">Agents, best first</h2>
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  {[
                    "Agent",
                    "Team",
                    "Calls",
                    "Connected",
                    "Talk Time",
                    "Reviewed",
                    "Avg Score",
                    "Best Calls",
                    "Fatal",
                  ].map((h) => (
                    <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.agents.map((a) => (
                  <tr key={`${a.agent_id}-${a.team_id}`} className="hover:bg-accent/30">
                    <td className="px-4 py-2 font-medium">
                      <Link
                        to="/auditor/calls"
                        search={{ agent: a.agent_id }}
                        className="text-primary hover:underline"
                      >
                        {a.agent_name}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{a.team_name}</td>
                    <td className="px-4 py-2">{a.calls}</td>
                    <td className="px-4 py-2">{a.connected}</td>
                    <td className="px-4 py-2">{fmtSeconds(a.talk_seconds)}</td>
                    <td className="px-4 py-2">{a.audited}</td>
                    <td className="px-4 py-2 font-semibold">{scoreText(a.avg_score)}</td>
                    <td className="px-4 py-2">{a.exemplary}</td>
                    <td
                      className={cn("px-4 py-2", a.fatal > 0 && "font-semibold text-destructive")}
                    >
                      {a.fatal}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
