import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { DateRangeFilter } from "@/components/date-range-filter";
import type { DateRange } from "@/lib/date-filter";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import {
  getAuditOrg,
  getAuditSummary,
  listTeamReviews,
  saveTeamReview,
} from "@/lib/call-audit.server";
import {
  fmtSeconds,
  istDayKeyDaysAgo,
  type AuditSummary,
  type TeamReviewRow,
} from "@/lib/call-audit";
import { dmy, istDateTime } from "@/lib/portfolio-feedback";

export const Route = createFileRoute("/auditor/teams")({
  head: () => ({ meta: [{ title: "Teams & Managers · SamvadX" }] }),
  component: AuditorTeams,
});

type Org = Awaited<ReturnType<typeof getAuditOrg>>;
type Team = Org["teams"][number];

function ReviewForm({
  team,
  from,
  to,
  onSaved,
}: {
  team: Team;
  from: string;
  to: string;
  onSaved: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [summary, setSummary] = useState("");
  const [strengths, setStrengths] = useState("");
  const [improvements, setImprovements] = useState("");
  const [actionItems, setActionItems] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!rating) return toast.error("Give a rating out of 5.");
    if (!summary.trim()) return toast.error("Write a summary.");
    setSaving(true);
    try {
      await saveTeamReview({
        data: {
          accessToken: await getAccessToken(),
          teamId: team.id,
          from,
          to,
          rating,
          summary,
          strengths,
          improvements,
          actionItems,
        },
      });
      toast.success(`Review sent to ${team.managerName ?? team.name}`);
      onSaved();
    } catch (e) {
      toast.error(errorText(e, "Could not save this review"));
    } finally {
      setSaving(false);
    }
  };

  const area = (label: string, value: string, set: (v: string) => void) => (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      <Textarea rows={2} value={value} onChange={(e) => set(e.target.value)} />
    </div>
  );

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        Review for {dmy(from)} to {dmy(to)}
      </p>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-label={`${n} of 5`} onClick={() => setRating(n)}>
            <Star
              className={cn(
                "h-5 w-5",
                n <= rating ? "fill-amber-500 text-amber-500" : "text-muted-foreground",
              )}
            />
          </button>
        ))}
      </div>
      {area("Summary *", summary, setSummary)}
      {area("What's going well", strengths, setStrengths)}
      {area("What to improve", improvements, setImprovements)}
      {area("Actions for the manager", actionItems, setActionItems)}
      <Button size="sm" disabled={saving} onClick={save}>
        {saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        Send review
      </Button>
    </div>
  );
}

function AuditorTeams() {
  const [range, setRange] = useState<DateRange>({
    from: istDayKeyDaysAgo(29),
    to: istDayKeyDaysAgo(0),
  });
  const [org, setOrg] = useState<Org | null>(null);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [reviews, setReviews] = useState<TeamReviewRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = range.from || istDayKeyDaysAgo(29);
  const to = range.to || istDayKeyDaysAgo(0);

  const load = useCallback(async () => {
    try {
      const accessToken = await getAccessToken();
      const [o, s, r] = await Promise.all([
        getAuditOrg({ data: { accessToken } }),
        getAuditSummary({ data: { accessToken, from, to } }),
        listTeamReviews({ data: { accessToken, from: "2026-01-01", to: istDayKeyDaysAgo(0) } }),
      ]);
      setOrg(o);
      setSummary(s);
      setReviews(r);
    } catch (e) {
      setError(errorText(e, "Could not load teams"));
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Teams &amp; Managers
          </h1>
          <p className="text-sm text-muted-foreground">
            Review each team as a whole. The manager is told and can reply.
          </p>
        </div>
        <DateRangeFilter value={range} onChange={setRange} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!org && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {org?.teams.length === 0 && (
        <p className="text-sm text-muted-foreground">Your company has no teams yet.</p>
      )}

      <div className="space-y-3">
        {org?.teams.map((team) => {
          const s = summary?.teams.find((t) => t.team_id === team.id);
          const past = reviews.filter((r) => r.team_id === team.id);
          return (
            <Card key={team.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Link
                    to="/auditor/calls"
                    search={{ team: team.id }}
                    className="text-sm font-semibold text-primary hover:underline"
                  >
                    {team.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    Manager: {team.managerName ?? "None"}
                  </div>
                </div>
                {org.canReview && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOpen(open === team.id ? null : team.id)}
                  >
                    {open === team.id ? "Close" : "Write review"}
                  </Button>
                )}
              </div>
              <dl className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
                {[
                  ["Calls", s?.calls ?? 0],
                  ["Connected", s?.connected ?? 0],
                  ["Talk Time", fmtSeconds(s?.talk_seconds ?? 0)],
                  ["Reviewed", s?.audited ?? 0],
                  ["Avg Score", s?.avg_score != null ? `${s.avg_score}%` : "—"],
                  ["Fatal", s?.fatal ?? 0],
                ].map(([k, v]) => (
                  <div key={k as string}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-semibold text-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
              {open === team.id && (
                <ReviewForm
                  team={team}
                  from={from}
                  to={to}
                  onSaved={() => {
                    setOpen(null);
                    void load();
                  }}
                />
              )}
              {past.length > 0 && (
                <ul className="space-y-2 border-t border-border pt-3">
                  {past.slice(0, 5).map((r) => (
                    <li key={r.id} className="text-xs">
                      <div className="flex justify-between gap-2 text-muted-foreground">
                        <span>
                          {dmy(r.period_from)} to {dmy(r.period_to)} · {r.rating}/5 ·{" "}
                          {r.auditor_name ?? ""}
                        </span>
                        <span>
                          {r.acknowledged_at
                            ? `Acknowledged ${istDateTime(r.acknowledged_at)}`
                            : "Not acknowledged"}
                        </span>
                      </div>
                      <p className="text-foreground">{r.summary}</p>
                      {r.manager_response && (
                        <p className="text-muted-foreground">Manager: {r.manager_response}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
