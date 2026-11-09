import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { DateRangeFilter } from "@/components/date-range-filter";
import { CallReviewSheet } from "@/components/audit/call-review-sheet";
import { BatchAiButton } from "@/components/audit/batch-ai-button";
import type { DateRange } from "@/lib/date-filter";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { getAuditOrg, getAuditQueue } from "@/lib/call-audit.server";
import {
  DEFAULT_AUDIT_TARGET,
  MIN_AUDIT_SECONDS,
  dispositionLabel,
  fmtSeconds,
  istDayKeyDaysAgo,
  istWeekStart,
  type QueueAgent,
} from "@/lib/call-audit";
import { istDateTime } from "@/lib/portfolio-feedback";

export const Route = createFileRoute("/auditor/queue")({
  head: () => ({ meta: [{ title: "Audit Queue · SamvadX" }] }),
  component: AuditQueue,
});

const TARGET_KEY = "samvadx_audit_target";

function savedTarget(): number {
  try {
    const n = Number(localStorage.getItem(TARGET_KEY));
    return n >= 1 && n <= 200 ? n : DEFAULT_AUDIT_TARGET;
  } catch {
    return DEFAULT_AUDIT_TARGET;
  }
}

function AuditQueue() {
  const [range, setRange] = useState<DateRange>({ from: istWeekStart(), to: istDayKeyDaysAgo(0) });
  const [target, setTarget] = useState(DEFAULT_AUDIT_TARGET);
  const [team, setTeam] = useState("all");
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<QueueAgent[] | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setTarget(savedTarget()), []);
  useEffect(() => {
    getAccessToken()
      .then((accessToken) => getAuditOrg({ data: { accessToken } }))
      .then((o) => setTeams(o.teams))
      .catch(() => {});
  }, []);

  const from = range.from || istWeekStart();
  const to = range.to || istDayKeyDaysAgo(0);

  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      const res = await getAuditQueue({
        data: {
          accessToken: await getAccessToken(),
          from,
          to,
          target,
          teamId: team === "all" ? undefined : team,
        },
      });
      if (!live) return;
      setAgents(res.agents);
      setCanReview(res.canReview);
    })().catch((e) => live && setError(errorText(e, "Could not load the queue")));
    return () => {
      live = false;
    };
  }, [from, to, target, team, reloadKey]);

  const changeTarget = (value: string) => {
    const n = Math.min(200, Math.max(1, Math.round(Number(value)) || 1));
    setTarget(n);
    try {
      localStorage.setItem(TARGET_KEY, String(n));
    } catch {
      /* the target just isn't remembered next time */
    }
  };

  const totals = useMemo(() => {
    const list = agents ?? [];
    const done = list.reduce((a, x) => a + Math.min(x.audited, x.target), 0);
    const goal = list.reduce((a, x) => a + x.target, 0);
    const left = list.reduce((a, x) => a + x.picks.length, 0);
    return { done, goal, left };
  }, [agents]);
  const aiReady = (agents ?? [])
    .flatMap((a) => a.picks)
    .filter((c) => c.recording_url && !c.ai_sentiment)
    .map((c) => c.call_id);

  return (
    <>
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Audit Queue</h1>
          <p className="text-sm text-muted-foreground">
            A fair sample of each agent's answered calls of {MIN_AUDIT_SECONDS} seconds or more.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <DateRangeFilter value={range} onChange={setRange} />
          <Select value={team} onValueChange={setTeam}>
            <SelectTrigger className="h-9 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-xs text-foreground">
            Calls per agent
            <Input
              type="number"
              min={1}
              max={200}
              value={target}
              onChange={(e) => changeTarget(e.target.value)}
              className="h-9 w-20 text-xs"
            />
          </label>
          {canReview && aiReady.length > 0 && (
            <BatchAiButton callIds={aiReady} onDone={() => setReloadKey((k) => k + 1)} />
          )}
          {agents && (
            <span className="ml-auto text-xs text-muted-foreground">
              {totals.done} of {totals.goal} done · {totals.left} ready to review
            </span>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!agents && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {agents?.length === 0 && (
          <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            No answered calls long enough to review in this period.
          </p>
        )}

        <div className="space-y-3">
          {agents?.map((a) => (
            <Card key={a.agent_id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-foreground">{a.agent_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.team_name} · {a.eligible} calls to choose from
                  </div>
                </div>
                <div className="w-40">
                  <div className="mb-1 text-right text-xs font-medium text-foreground">
                    {a.audited} of {a.target} reviewed
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.min(100, (a.audited / a.target) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
              {a.picks.length > 0 ? (
                <ul className="divide-y divide-border">
                  {a.picks.map((c) => (
                    <li key={c.call_id}>
                      <button
                        type="button"
                        onClick={() => setOpenCall(c.call_id)}
                        className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-accent/30"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-foreground">
                            {c.customer_name || "Manual call"}
                            {c.loan_reference ? ` · ${c.loan_reference}` : ""}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {istDateTime(c.created_at)} · {dispositionLabel(c.outcome)} ·{" "}
                            {fmtSeconds(c.duration_seconds)}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {c.ai_sentiment
                            ? "AI done"
                            : c.recording_url
                              ? "Recording ready"
                              : "No recording yet"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {a.remaining === 0 ? "Target reached." : "No more calls to choose from."}
                </p>
              )}
            </Card>
          ))}
        </div>
      </div>

      <Sheet open={!!openCall} onOpenChange={(open) => !open && setOpenCall(null)}>
        <SheetContent side="right" className="w-full max-w-2xl overflow-hidden p-0 sm:max-w-2xl">
          <SheetTitle className="sr-only">Call review</SheetTitle>
          {openCall && (
            <CallReviewSheet
              callId={openCall}
              canReview={canReview}
              onSaved={() => {
                setOpenCall(null);
                setReloadKey((k) => k + 1);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
