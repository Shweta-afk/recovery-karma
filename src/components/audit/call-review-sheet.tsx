// One call under review: listen, see what the AI suggested, score it, give feedback.
// The AI never completes a review. It waits here until the auditor agrees or disagrees.
import { useEffect, useMemo, useState } from "react";
import { Loader2, Mic, Sparkles, Star, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RecordingAudio } from "@/components/telephony/recording-audio";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { analyzeCallSentiment } from "@/lib/call-sentiment-actions.server";
import { getAuditCall, saveCallAudit } from "@/lib/call-audit.server";
import {
  FATAL_ERRORS,
  SCORECARD,
  computeScore,
  dispositionLabel,
  fmtSeconds,
  type AiAgreement,
  type AuditCallRow,
  type AuditSentiment,
  type ScoreAnswers,
  type ScoreValue,
} from "@/lib/call-audit";
import { istDateTime } from "@/lib/portfolio-feedback";

const SCORE_OPTIONS: { value: ScoreValue; label: string; active: string }[] = [
  { value: "yes", label: "Yes", active: "bg-success/15 text-success border-success/40" },
  {
    value: "partial",
    label: "Partly",
    active: "bg-amber-500/15 text-amber-600 border-amber-500/40",
  },
  { value: "no", label: "No", active: "bg-destructive/15 text-destructive border-destructive/40" },
  { value: "na", label: "N/A", active: "bg-muted text-foreground border-foreground/30" },
];
const TONES: AuditSentiment[] = ["happy", "neutral", "frustrated", "rude"];
const AI_VERDICTS: { value: AiAgreement; label: string }[] = [
  { value: "agree", label: "AI is right" },
  { value: "partly", label: "Partly right" },
  { value: "disagree", label: "AI is wrong" },
];

function Choice({
  active,
  disabled,
  onClick,
  className,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors disabled:opacity-60",
        active
          ? className || "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

export function CallReviewSheet({
  callId,
  canReview,
  onSaved,
}: {
  callId: string;
  canReview: boolean;
  onSaved: () => void;
}) {
  const [call, setCall] = useState<AuditCallRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<ScoreAnswers>({});
  const [fatal, setFatal] = useState<string[]>([]);
  const [tone, setTone] = useState<AuditSentiment | null>(null);
  const [aiVerdict, setAiVerdict] = useState<AiAgreement | null>(null);
  const [aiComment, setAiComment] = useState("");
  const [exemplary, setExemplary] = useState(false);
  const [coaching, setCoaching] = useState(false);
  const [strengths, setStrengths] = useState("");
  const [improvements, setImprovements] = useState("");
  const [feedbackAgent, setFeedbackAgent] = useState("");
  const [feedbackManager, setFeedbackManager] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const load = async () => {
    const row = await getAuditCall({ data: { accessToken: await getAccessToken(), callId } });
    setCall(row);
    return row;
  };

  useEffect(() => {
    let live = true;
    setCall(null);
    setLoadError(null);
    load()
      .then((c) => {
        if (!live) return;
        setAnswers(c.scores ?? {});
        setFatal(c.fatal_codes ?? []);
        setTone((c.audit_sentiment as AuditSentiment | null) ?? null);
        setAiVerdict((c.ai_agreement as AiAgreement | null) ?? null);
        setAiComment(c.ai_comment ?? "");
        setExemplary(!!c.exemplary);
        setCoaching(!!c.coaching_required);
        setStrengths(c.strengths ?? "");
        setImprovements(c.improvements ?? "");
        setFeedbackAgent(c.feedback_agent ?? "");
        setFeedbackManager(c.feedback_manager ?? "");
        setInternalNote(c.internal_note ?? "");
      })
      .catch((e) => live && setLoadError(errorText(e, "Could not load this call")));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the call changes
  }, [callId]);

  const score = useMemo(() => computeScore(answers, fatal), [answers, fatal]);
  const sections = useMemo(() => [...new Set(SCORECARD.map((p) => p.section))], []);

  if (loadError) return <p className="p-6 text-sm text-destructive">{loadError}</p>;
  if (!call) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading call…
      </div>
    );
  }

  const setAnswer = (id: string, value: ScoreValue) =>
    setAnswers((a) => ({ ...a, [id]: { ...a[id], value } }));
  const setRemark = (id: string, remark: string) =>
    setAnswers((a) => (a[id] ? { ...a, [id]: { ...a[id], remark } } : a));

  const runAi = async () => {
    setAnalyzing(true);
    try {
      await analyzeCallSentiment({ data: { accessToken: await getAccessToken(), callId } });
      await load();
      toast.success("AI analysis is ready for your review");
    } catch (e) {
      toast.error(errorText(e, "AI analysis failed"));
    } finally {
      setAnalyzing(false);
    }
  };

  const submit = async () => {
    if (!tone) return toast.error("Choose how the call felt.");
    if (!feedbackAgent.trim()) return toast.error("Write the feedback for the agent.");
    if (call.ai_sentiment && !aiVerdict) return toast.error("Say whether the AI got it right.");
    setSaving(true);
    try {
      await saveCallAudit({
        data: {
          accessToken: await getAccessToken(),
          callId,
          scores: answers,
          fatalCodes: fatal,
          sentiment: tone,
          aiAgreement: aiVerdict,
          aiComment,
          exemplary,
          coachingRequired: coaching,
          strengths,
          improvements,
          feedbackAgent,
          feedbackManager,
          internalNote,
        },
      });
      toast.success("Review saved. The agent and manager have been told.");
      onSaved();
    } catch (e) {
      toast.error(errorText(e, "Could not save this review"));
    } finally {
      setSaving(false);
    }
  };

  const details: [string, string][] = [
    ["Agent", call.agent_name],
    ["Team", call.team_name ?? "No team"],
    ["Manager", call.manager_name ?? "—"],
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
        <div className="flex items-start justify-between gap-3 pr-6">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {call.customer_name || "Unknown customer"}
            </h2>
            <p className="text-xs text-muted-foreground">{istDateTime(call.created_at)} IST</p>
          </div>
          {call.audit_id ? (
            <Badge variant="outline">Reviewed by {call.auditor_name ?? "auditor"}</Badge>
          ) : (
            <Badge variant="outline" className="border-amber-500/30 text-amber-600">
              Not reviewed
            </Badge>
          )}
        </div>
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
            <span>
              No recording is available for this call
              {call.recording_status === "none" ? " (the call was not answered)." : " yet."}
            </span>
          </div>
        )}

        <section className="rounded-lg border border-border p-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground">
            Agent's feedback on the call
          </h3>
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {call.raw_notes?.trim() || "The agent logged no notes."}
          </p>
        </section>

        <section className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" /> AI sentiment
            </h3>
            {canReview && (
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
            )}
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
              {call.ai_sentiment_reasoning && (
                <p className="text-xs leading-relaxed text-foreground">
                  {call.ai_sentiment_reasoning}
                </p>
              )}
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
              <Field label="Is the AI right?">
                <div className="flex flex-wrap gap-1.5">
                  {AI_VERDICTS.map((v) => (
                    <Choice
                      key={v.value}
                      active={aiVerdict === v.value}
                      disabled={!canReview}
                      onClick={() => setAiVerdict(v.value)}
                    >
                      {v.label}
                    </Choice>
                  ))}
                </div>
              </Field>
              <Input
                placeholder="Your comment on the AI's view (optional)"
                value={aiComment}
                disabled={!canReview}
                onChange={(e) => setAiComment(e.target.value)}
                className="h-8 text-xs"
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {call.recording_url
                ? "Not analysed yet."
                : "AI analysis needs a recording of the call."}
            </p>
          )}
        </section>

        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Scorecard
            </h3>
            <span
              className={cn(
                "text-sm font-semibold",
                score.fatal ? "text-destructive" : "text-foreground",
              )}
            >
              {score.finalPercent}% · {score.grade}
            </span>
          </div>
          {sections.map((section) => (
            <div key={section} className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">{section}</h4>
              {SCORECARD.filter((p) => p.section === section).map((p) => (
                <div key={p.id} className="rounded-md border border-border p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-foreground">
                      {p.label} <span className="text-muted-foreground">({p.weight})</span>
                    </span>
                    <div className="flex gap-1">
                      {SCORE_OPTIONS.map((o) => (
                        <Choice
                          key={o.value}
                          active={answers[p.id]?.value === o.value}
                          disabled={!canReview}
                          className={o.active}
                          onClick={() => setAnswer(p.id, o.value)}
                        >
                          {o.label}
                        </Choice>
                      ))}
                    </div>
                  </div>
                  {answers[p.id] && (
                    <Input
                      placeholder="Remark (optional)"
                      value={answers[p.id]?.remark ?? ""}
                      disabled={!canReview}
                      onChange={(e) => setRemark(p.id, e.target.value)}
                      className="mt-2 h-7 text-xs"
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </section>

        <section className="space-y-2 rounded-lg border border-destructive/30 p-4">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-destructive">
            <TriangleAlert className="h-3.5 w-3.5" /> Fatal errors (any one scores the call 0%)
          </h3>
          {FATAL_ERRORS.map((f) => (
            <label key={f.id} className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={fatal.includes(f.id)}
                disabled={!canReview}
                onCheckedChange={(on) =>
                  setFatal((list) => (on ? [...list, f.id] : list.filter((x) => x !== f.id)))
                }
              />
              {f.label}
            </label>
          ))}
        </section>

        <section className="space-y-3">
          <Field label="How did the call feel? (your final call)">
            <div className="flex flex-wrap gap-1.5">
              {TONES.map((t) => (
                <Choice
                  key={t}
                  active={tone === t}
                  disabled={!canReview}
                  onClick={() => setTone(t)}
                >
                  {t}
                </Choice>
              ))}
            </div>
          </Field>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={exemplary}
                disabled={!canReview}
                onCheckedChange={(on) => setExemplary(!!on)}
              />
              <Star className="h-3.5 w-3.5 text-amber-500" /> Best call (example for others)
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox
                checked={coaching}
                disabled={!canReview}
                onCheckedChange={(on) => setCoaching(!!on)}
              />
              Needs coaching
            </label>
          </div>
          <Field label="What went well">
            <Textarea
              rows={2}
              value={strengths}
              disabled={!canReview}
              onChange={(e) => setStrengths(e.target.value)}
            />
          </Field>
          <Field label="What to improve">
            <Textarea
              rows={2}
              value={improvements}
              disabled={!canReview}
              onChange={(e) => setImprovements(e.target.value)}
            />
          </Field>
          <Field label="Feedback to the agent *">
            <Textarea
              rows={3}
              value={feedbackAgent}
              disabled={!canReview}
              onChange={(e) => setFeedbackAgent(e.target.value)}
            />
          </Field>
          <Field label="Feedback to the manager">
            <Textarea
              rows={2}
              value={feedbackManager}
              disabled={!canReview}
              onChange={(e) => setFeedbackManager(e.target.value)}
            />
          </Field>
          <Field label="Internal note (auditors and admins only)">
            <Textarea
              rows={2}
              value={internalNote}
              disabled={!canReview}
              onChange={(e) => setInternalNote(e.target.value)}
            />
          </Field>
          {call.agent_response && (
            <p className="rounded-md bg-muted/40 p-2.5 text-xs text-foreground">
              <span className="font-medium">Agent's reply:</span> {call.agent_response}
            </p>
          )}
        </section>

        {canReview && (
          <Button className="w-full" disabled={saving} onClick={submit}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {call.audit_id ? "Update review" : "Submit review"}
          </Button>
        )}
      </div>
    </div>
  );
}
