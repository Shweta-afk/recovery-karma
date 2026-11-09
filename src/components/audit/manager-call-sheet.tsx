// One of the manager's team's calls: the recording, the auditor's review (read-only), and the
// manager's own tone tag and AI check, which are kept apart from the official score.
import { useEffect, useState } from "react";
import { Loader2, Mic, Sparkles, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RecordingAudio } from "@/components/telephony/recording-audio";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { analyzeCallSentiment } from "@/lib/call-sentiment-actions.server";
import { getManagerCall, setManagerTone } from "@/lib/call-audit.server";
import {
  FATAL_ERRORS,
  SCORECARD,
  dispositionLabel,
  fmtSeconds,
  type AuditCallRow,
  type AuditSentiment,
} from "@/lib/call-audit";
import { istDateTime } from "@/lib/portfolio-feedback";

const TONES: AuditSentiment[] = ["happy", "neutral", "frustrated", "rude"];
const ANSWER_LABEL = { yes: "Yes", partial: "Partly", no: "No", na: "N/A" } as const;
const answerClass = (v: string) =>
  v === "yes"
    ? "text-success"
    : v === "no"
      ? "text-destructive"
      : v === "partial"
        ? "text-amber-600"
        : "text-muted-foreground";

function Block({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <p className="whitespace-pre-wrap text-sm text-foreground">{value}</p>
    </div>
  );
}

export function ManagerCallSheet({ callId, onChanged }: { callId: string; onChanged: () => void }) {
  const [call, setCall] = useState<AuditCallRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const load = async () => {
    const row = await getManagerCall({ data: { accessToken: await getAccessToken(), callId } });
    setCall(row);
  };

  useEffect(() => {
    setCall(null);
    setError(null);
    load().catch((e) => setError(errorText(e, "Could not load this call")));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the call changes
  }, [callId]);

  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
  if (!call) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading call…
      </div>
    );
  }

  const tag = async (sentiment: AuditSentiment) => {
    setSaving(true);
    try {
      await setManagerTone({ data: { accessToken: await getAccessToken(), callId, sentiment } });
      await load();
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not save your tag"));
    } finally {
      setSaving(false);
    }
  };

  const runAi = async () => {
    setAnalyzing(true);
    try {
      await analyzeCallSentiment({ data: { accessToken: await getAccessToken(), callId } });
      await load();
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "AI analysis failed"));
    } finally {
      setAnalyzing(false);
    }
  };

  const fatal = (call.fatal_codes ?? [])
    .map((c) => FATAL_ERRORS.find((f) => f.id === c)?.label ?? c)
    .join(", ");
  const details: [string, string][] = [
    ["Agent", call.agent_name],
    ["Team", call.team_name ?? "No team"],
    ["Loan ID", call.loan_reference ?? "Manual call"],
    ["Portfolio", call.portfolio_name ?? "—"],
    ["Number", call.customer_phone ?? "—"],
    [
      "Disposition",
      [dispositionLabel(call.outcome), call.outcome_reason].filter(Boolean).join(" · "),
    ],
    ["Duration", fmtSeconds(call.duration_seconds)],
  ];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border px-6 py-4">
        <h2 className="pr-6 text-base font-semibold text-foreground">
          {call.customer_name || "Unknown customer"}
        </h2>
        <p className="text-xs text-muted-foreground">{istDateTime(call.created_at)} IST</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
          {details.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate font-medium text-foreground" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-5 px-6 py-4">
        {call.recording_url ? (
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <RecordingAudio key={call.recording_url} url={call.recording_url} showOpenLink />
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            <Mic className="mt-0.5 h-4 w-4 shrink-0" />
            No recording is available for this call yet.
          </div>
        )}

        <Block label="Agent's notes" value={call.raw_notes?.trim() || "No notes logged."} />

        <section className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Auditor's review
            </h3>
            {call.audit_id && (
              <Badge variant="outline">
                {call.final_percent}% · {call.grade}
              </Badge>
            )}
          </div>
          {call.audit_id ? (
            <>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                By {call.auditor_name ?? "Call Auditor"}
                {call.exemplary && (
                  <>
                    · <Star className="h-3.5 w-3.5 text-amber-500" /> Best call
                  </>
                )}
                {call.coaching_required && " · Needs coaching"}
              </p>
              {fatal && <p className="text-xs font-medium text-destructive">Fatal: {fatal}</p>}
              <Block label="What went well" value={call.strengths} />
              <Block label="What to improve" value={call.improvements} />
              <Block label="Feedback to the agent" value={call.feedback_agent} />
              <Block label="Feedback to you" value={call.feedback_manager} />
              <Block label="Agent's reply" value={call.agent_response} />
              <ul className="divide-y divide-border">
                {SCORECARD.filter((p) => call.scores?.[p.id]).map((p) => {
                  const a = call.scores?.[p.id];
                  return (
                    <li key={p.id} className="py-1.5 text-xs">
                      <div className="flex justify-between gap-3">
                        <span className="text-foreground">{p.label}</span>
                        <span className={cn("font-medium", a && answerClass(a.value))}>
                          {a && ANSWER_LABEL[a.value]}
                        </span>
                      </div>
                      {a?.remark && <p className="text-muted-foreground">{a.remark}</p>}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">The auditor has not reviewed this call.</p>
          )}
        </section>

        <section className="space-y-2 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Manager's tag
            </h3>
            {call.manager_sentiment && call.manager_audited_by && (
              <span className="text-[11px] text-muted-foreground">
                By {call.manager_audited_by}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Your own note. It doesn't change the score.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {TONES.map((t) => (
              <button
                key={t}
                type="button"
                disabled={saving}
                aria-pressed={call.manager_sentiment === t}
                onClick={() => tag(t)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors disabled:opacity-60",
                  call.manager_sentiment === t
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> AI suggestion
            </h3>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              disabled={analyzing || !call.recording_url}
              onClick={runAi}
            >
              {analyzing && <Loader2 className="h-3 w-3 animate-spin" />}
              {analyzing ? "Analysing…" : call.ai_sentiment ? "Analyse again" : "Analyse with AI"}
            </Button>
          </div>
          {call.ai_sentiment ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                {[
                  ["Agent", call.ai_agent_tone],
                  ["Customer", call.ai_debtor_tone],
                  ["Overall", call.ai_sentiment],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div className="text-muted-foreground">{k}</div>
                    <div className="font-semibold capitalize text-foreground">{v ?? "—"}</div>
                  </div>
                ))}
              </div>
              <Block label="Why" value={call.ai_sentiment_reasoning} />
              {call.ai_transcript && (
                <div>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setShowTranscript((s) => !s)}
                  >
                    {showTranscript ? "Hide transcript" : "Show transcript"}
                  </button>
                  {showTranscript && (
                    <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-2.5 text-xs text-muted-foreground">
                      {call.ai_transcript}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {call.recording_url ? "Not analysed yet." : "AI analysis needs a recording."}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
