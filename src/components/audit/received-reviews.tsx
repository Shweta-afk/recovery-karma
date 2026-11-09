// What the Call Auditor's reviews look like from the receiving end: an agent's own calls, or a
// manager's team plus reviews of the team as a whole. Internal notes never reach this screen.
import { useEffect, useState } from "react";
import { Loader2, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { RecordingAudio } from "@/components/telephony/recording-audio";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { FATAL_ERRORS, dispositionLabel, fmtSeconds } from "@/lib/call-audit";
import { dmy, istDateTime } from "@/lib/portfolio-feedback";
import {
  acknowledgeReview,
  acknowledgeTeamReview,
  listMyReviews,
  type ReceivedAudit,
} from "@/lib/call-audit.server";

type Data = Awaited<ReturnType<typeof listMyReviews>>;
type TeamReview = Data["teamReviews"][number];

const gradeClass = (grade: string) =>
  grade === "Fatal" || grade === "Poor"
    ? "border-destructive/30 text-destructive"
    : grade === "Needs Improvement"
      ? "border-amber-500/30 text-amber-600"
      : "border-success/30 text-success";

function Reply({ onSend }: { onSend: (response: string) => Promise<void> }) {
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <Textarea
        rows={2}
        placeholder="Your reply (optional)"
        value={response}
        onChange={(e) => setResponse(e.target.value)}
      />
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSend(response);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        Acknowledge
      </Button>
    </div>
  );
}

function Text({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <p className="whitespace-pre-wrap text-sm text-foreground">{value}</p>
    </div>
  );
}

function AuditCard({
  r,
  myAgentId,
  onChanged,
}: {
  r: ReceivedAudit;
  myAgentId: string;
  onChanged: () => void;
}) {
  const mine = r.agent_id === myAgentId;
  const fatal = r.fatal_codes
    .map((c) => FATAL_ERRORS.find((f) => f.id === c)?.label ?? c)
    .join(", ");
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">
            {r.customer_name || "Manual call"}
            {r.loan_reference ? ` · ${r.loan_reference}` : ""}
          </div>
          <div className="text-xs text-muted-foreground">
            {!mine && `${r.agent_name} · `}
            {istDateTime(r.call_time)} · {dispositionLabel(r.outcome)} ·{" "}
            {fmtSeconds(r.duration_seconds)}
          </div>
        </div>
        <Badge variant="outline" className={cn("shrink-0", gradeClass(r.grade))}>
          {r.final_percent}% · {r.grade}
        </Badge>
      </div>
      {r.recording_url && <RecordingAudio url={r.recording_url} compact />}
      {fatal && <p className="text-xs font-medium text-destructive">Fatal error: {fatal}</p>}
      <Text label="What went well" value={r.strengths} />
      <Text label="What to improve" value={r.improvements} />
      <Text label="Feedback" value={r.feedback_agent} />
      <Text label="Feedback to you as manager" value={r.feedback_manager} />
      <p className="text-xs text-muted-foreground">
        Reviewed by {r.auditor_name ?? "Call Auditor"}
      </p>
      {r.agent_ack_at ? (
        <p className="text-xs text-muted-foreground">
          Acknowledged {istDateTime(r.agent_ack_at)}
          {r.agent_response ? ` — "${r.agent_response}"` : ""}
        </p>
      ) : mine ? (
        <Reply
          onSend={async (response) => {
            try {
              await acknowledgeReview({
                data: { accessToken: await getAccessToken(), auditId: r.id, response },
              });
              onChanged();
            } catch (e) {
              toast.error(errorText(e, "Could not save your reply"));
            }
          }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Agent has not acknowledged yet.</p>
      )}
    </Card>
  );
}

function TeamReviewCard({ r, onChanged }: { r: TeamReview; onChanged: () => void }) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">{r.team_name}</div>
          <div className="text-xs text-muted-foreground">
            {dmy(r.period_from)} to {dmy(r.period_to)} · by {r.auditor_name ?? "Call Auditor"}
          </div>
        </div>
        <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
          <Star className="h-4 w-4 text-amber-500" /> {r.rating}/5
        </span>
      </div>
      <Text label="Summary" value={r.summary} />
      <Text label="What's going well" value={r.strengths} />
      <Text label="What to improve" value={r.improvements} />
      <Text label="Actions to take" value={r.action_items} />
      {r.acknowledged_at ? (
        <p className="text-xs text-muted-foreground">
          Acknowledged {istDateTime(r.acknowledged_at)}
          {r.manager_response ? ` — "${r.manager_response}"` : ""}
        </p>
      ) : (
        <Reply
          onSend={async (response) => {
            try {
              await acknowledgeTeamReview({
                data: { accessToken: await getAccessToken(), reviewId: r.id, response },
              });
              onChanged();
            } catch (e) {
              toast.error(errorText(e, "Could not save your reply"));
            }
          }}
        />
      )}
    </Card>
  );
}

export function ReceivedReviews({
  title,
  subtitle,
  teamId,
}: {
  /** Leave out inside a page that already has its own heading. */
  title?: string;
  subtitle?: string;
  teamId?: string;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    getAccessToken()
      .then((accessToken) => listMyReviews({ data: { accessToken, teamId } }))
      .then(setData)
      .catch((e) => setError(errorText(e, "Could not load reviews")));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the team changes
  }, [teamId]);

  return (
    <div className="space-y-6">
      {title && (
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && data.teamReviews.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Reviews of your team</h2>
          {data.teamReviews.map((r) => (
            <TeamReviewCard key={r.id} r={r} onChanged={() => void load()} />
          ))}
        </section>
      )}
      {data && (
        <section className="space-y-3">
          {data.isManager && (
            <h2 className="text-sm font-semibold text-foreground">Call reviews</h2>
          )}
          {data.reviews.length === 0 && (
            <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
              No calls have been reviewed yet.
            </p>
          )}
          {data.reviews.map((r) => (
            <AuditCard key={r.id} r={r} myAgentId={data.myAgentId} onChanged={() => void load()} />
          ))}
        </section>
      )}
    </div>
  );
}
