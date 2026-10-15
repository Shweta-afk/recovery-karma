import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Download,
  Search,
  X,
  Filter,
  ChevronDown,
  Clock,
  User,
  Bot,
  Mic,
  Play,
  Smile,
  Meh,
  Frown,
  Angry,
  ShieldQuestion,
  PhoneCall,
  Sparkles,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { DateRangeFilter } from "@/components/date-range-filter";
import { EMPTY_RANGE, inDateRange, type DateRange } from "@/lib/date-filter";
import { bucketOf, BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import { OUTCOME_META } from "@/lib/call-queue/types";
import { useAuth } from "@/lib/auth";
import { useTeamAgents } from "@/lib/team-store";
import { useActiveTeam } from "@/lib/active-team-store";
import { supabase } from "@/lib/supabase";
import { analyzeCallSentiment } from "@/lib/call-sentiment-actions.server";
import {
  getDispositions,
  refreshDispositions,
  setCallSentiment,
  type DispositionRecord,
  type CallSentiment,
} from "@/lib/disposition-store";
import { useStorageSync } from "@/lib/storage-sync";
import { errorText } from "@/lib/app-error";

export const Route = createFileRoute("/manager/audit")({
  head: () => ({ meta: [{ title: "Call Audit · SamvadX" }] }),
  component: CallAuditPage,
});

/* ─── helpers ────────────────────────────────────────────────────────────── */

type CallerType = "agent" | "ai";

function callerTypeOf(d: DispositionRecord): CallerType {
  return d.callType === "ai" || d.callType === "bot" ? "ai" : "agent";
}

function fmtDuration(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
  };
}

// The actual point of "Call Audit": how the call went for the debtor, not just what the
// outcome was. Manual QA tag a manager sets after listening — see setCallSentiment().
const SENTIMENT_META: Record<
  CallSentiment,
  { label: string; icon: LucideIcon; cls: string; dot: string }
> = {
  happy: {
    label: "Happy",
    icon: Smile,
    cls: "bg-success/10 text-success border-success/20",
    dot: "bg-success",
  },
  neutral: {
    label: "Neutral",
    icon: Meh,
    cls: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground",
  },
  frustrated: {
    label: "Frustrated",
    icon: Frown,
    cls: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    dot: "bg-amber-500",
  },
  rude: {
    label: "Rude",
    icon: Angry,
    cls: "bg-destructive/10 text-destructive border-destructive/20",
    dot: "bg-destructive",
  },
};

/* ─── sub-components ─────────────────────────────────────────────────────── */

function RecordingPlayer({ url }: { url?: string }) {
  if (!url) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        <Mic className="h-4 w-4 shrink-0" />
        No recording available for this call — some providers publish recordings asynchronously, so
        it may still arrive later.
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <audio controls src={url} className="w-full h-9" />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Download className="h-3 w-3" />
        Open recording
      </a>
    </div>
  );
}

/** The 4-way sentiment picker — used both inline in the table and, larger, in the detail
 * sheet. `size` controls icon-only (table) vs icon+label (sheet). */
function SentimentPicker({
  value,
  onPick,
  saving,
  size = "sm",
}: {
  value?: CallSentiment;
  onPick: (s: CallSentiment) => void;
  saving: boolean;
  size?: "sm" | "lg";
}) {
  return (
    <div className="flex items-center gap-1">
      {(
        Object.entries(SENTIMENT_META) as [CallSentiment, (typeof SENTIMENT_META)[CallSentiment]][]
      ).map(([key, meta]) => {
        const active = value === key;
        const Icon = meta.icon;
        return (
          <button
            key={key}
            type="button"
            disabled={saving}
            title={meta.label}
            onClick={(e) => {
              e.stopPropagation();
              onPick(key);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border transition-all disabled:opacity-50",
              size === "lg" ? "px-2.5 py-1.5 text-xs" : "h-6 w-6 justify-center",
              active
                ? meta.cls + " ring-1 ring-current"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40",
            )}
          >
            <Icon className={size === "lg" ? "h-3.5 w-3.5" : "h-3.5 w-3.5"} />
            {size === "lg" && meta.label}
          </button>
        );
      })}
    </div>
  );
}

/** AI-suggested tone — manager-triggered (never automatic), transcribes the recording via
 * Groq and classifies tone via Gemini. Shown alongside, never in place of, the manual
 * SentimentPicker above: this is a suggestion the manager can agree or disagree with. */
function AiSentimentPanel({
  call,
  onAnalyzed,
}: {
  call: DispositionRecord;
  onAnalyzed: (updated: DispositionRecord) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — please sign in again");

      const result = await analyzeCallSentiment({
        data: { accessToken: session.access_token, callId: call.id },
      });

      onAnalyzed({
        ...call,
        aiTranscript: result.transcript,
        aiAgentTone: result.agent_tone,
        aiDebtorTone: result.debtor_tone,
        aiSentiment: result.overall_call_sentiment,
        aiSentimentConfidence: result.confidence,
        aiSentimentReasoning: result.reasoning,
        aiSentimentAnalyzedAt: new Date().toISOString(),
      });
      toast.success("AI sentiment analysis complete");
    } catch (e) {
      toast.error(errorText(e, "AI analysis failed"));
    } finally {
      setAnalyzing(false);
    }
  };

  if (!call.aiSentiment) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={analyzing || !call.recordingUrl}
          onClick={handleAnalyze}
        >
          {analyzing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {analyzing ? "Transcribing & analyzing…" : "Analyze with AI"}
        </Button>
        {!call.recordingUrl && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Needs a recording to analyze — none available for this call yet.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          AI Suggested Sentiment
        </span>
        {call.aiSentimentAnalyzedAt && (
          <span className="text-[10px] text-muted-foreground">
            {fmtDateTime(call.aiSentimentAnalyzedAt).date}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Agent", tone: call.aiAgentTone },
          { label: "Debtor", tone: call.aiDebtorTone },
          { label: "Overall", tone: call.aiSentiment },
        ].map(({ label, tone }) => {
          const toneMeta = tone ? SENTIMENT_META[tone] : undefined;
          return (
            <div key={label} className="text-center">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {label}
              </div>
              <div
                className={cn(
                  "mt-0.5 text-xs font-semibold capitalize",
                  toneMeta ? toneMeta.cls.split(" ").find((c) => c.startsWith("text-")) : "",
                )}
              >
                {toneMeta?.label ?? "—"}
              </div>
            </div>
          );
        })}
      </div>

      {call.aiSentimentConfidence != null && (
        <p className="text-[11px] text-muted-foreground">
          Confidence: {Math.round(call.aiSentimentConfidence * 100)}%
        </p>
      )}
      {call.aiSentimentReasoning && (
        <p className="text-xs text-foreground leading-relaxed">{call.aiSentimentReasoning}</p>
      )}

      {call.aiTranscript && (
        <div>
          <button
            type="button"
            onClick={() => setShowTranscript((p) => !p)}
            className="text-[11px] text-primary hover:underline"
          >
            {showTranscript ? "Hide transcript" : "Show transcript"}
          </button>
          {showTranscript && (
            <div className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {call.aiTranscript}
            </div>
          )}
        </div>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1.5 text-[11px] text-muted-foreground"
        disabled={analyzing}
        onClick={handleAnalyze}
      >
        {analyzing ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="h-3 w-3" />
        )}
        Re-analyze
      </Button>
    </div>
  );
}

function CallDetailSheet({
  call,
  managerEmail,
  onSentimentSaved,
}: {
  call: DispositionRecord;
  managerEmail: string;
  onSentimentSaved: (updated: DispositionRecord) => void;
}) {
  const { date, time } = fmtDateTime(call.time);
  const caller = callerTypeOf(call);
  const [saving, setSaving] = useState(false);

  const handlePick = async (sentiment: CallSentiment) => {
    setSaving(true);
    try {
      await setCallSentiment(call.id, sentiment, managerEmail);
      onSentimentSaved({
        ...call,
        sentiment,
        auditedByName: "You",
        auditedAt: new Date().toISOString(),
      });
      toast.success(`Marked ${SENTIMENT_META[sentiment].label.toLowerCase()}`);
    } catch (e) {
      toast.error(errorText(e, "Failed to save sentiment"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <SheetHeader className="px-6 py-4 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div>
            <SheetTitle className="text-base">{call.debtorName}</SheetTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {date} {time}
              {call.portfolioName ? ` · ${call.portfolioName}` : ""}
            </p>
          </div>
          <Badge variant="outline" className={cn("shrink-0", OUTCOME_META[call.outcome]?.cls)}>
            {OUTCOME_META[call.outcome]?.label ?? call.outcome}
          </Badge>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-3">
          {[
            {
              icon: caller === "ai" ? Bot : User,
              label: caller === "ai" ? "AI Bot" : call.agentName,
            },
            {
              icon: Clock,
              label: call.durationSeconds != null ? fmtDuration(call.durationSeconds) : "—",
            },
            { icon: Mic, label: call.recordingUrl ? "Recording available" : "No recording" },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs text-foreground"
            >
              <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {label}
            </div>
          ))}
        </div>
      </SheetHeader>

      <div className="px-6 pt-4 pb-2">
        <RecordingPlayer url={call.recordingUrl} />
      </div>

      {/* Call sentiment — the actual audit judgment, listen to the recording (or read the
          notes) and tag how the call went. */}
      <div className="px-6 pb-4">
        <div className="rounded-lg border border-border bg-card p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Call Sentiment
            </span>
            {call.sentiment && call.auditedByName && (
              <span className="text-[10px] text-muted-foreground">
                Audited by {call.auditedByName}
                {call.auditedAt ? ` · ${fmtDateTime(call.auditedAt).date}` : ""}
              </span>
            )}
          </div>
          <SentimentPicker value={call.sentiment} onPick={handlePick} saving={saving} size="lg" />
        </div>
      </div>

      <div className="px-6 pb-4">
        <AiSentimentPanel call={call} onAnalyzed={onSentimentSaved} />
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="text-xs font-semibold text-foreground mb-2">Notes</div>
        <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-foreground leading-relaxed whitespace-pre-wrap">
          {call.notes?.trim() || "No notes logged for this call."}
        </div>
        {call.ptpAmount != null && (
          <p className="mt-3 text-xs text-muted-foreground">
            Promise to pay: ₹{call.ptpAmount.toLocaleString("en-IN")}
            {call.ptpDate ? ` by ${call.ptpDate}` : ""}
          </p>
        )}
        {call.paidAmount != null && (
          <p className="mt-1 text-xs text-muted-foreground">
            Paid: ₹{call.paidAmount.toLocaleString("en-IN")}
          </p>
        )}
      </div>
    </div>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function CallAuditPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const { activeTeam } = useActiveTeam(managerId);
  const agents = useTeamAgents(activeTeam?.id);
  const teamAgentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);

  const [allDisps, setAllDisps] = useState<DispositionRecord[]>(() => getDispositions());
  useEffect(() => {
    const reload = () => setAllDisps(getDispositions());
    window.addEventListener("dispositions-updated", reload);
    refreshDispositions();
    return () => window.removeEventListener("dispositions-updated", reload);
  }, []);
  useStorageSync(() => setAllDisps(getDispositions()));

  const calls = useMemo(
    () =>
      allDisps
        .filter((d) => teamAgentIds.has(d.agentId))
        .sort((a, b) => (a.time < b.time ? 1 : -1)),
    [allDisps, teamAgentIds],
  );

  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_RANGE);
  const [filterCaller, setFilterCaller] = useState<CallerType | "all">("all");
  const [filterOutcome, setFilterOutcome] = useState<string>("all");
  const [filterBucket, setFilterBucket] = useState<DPDBucket | "all">("all");
  const [filterSentiment, setFilterSentiment] = useState<CallSentiment | "unreviewed" | "all">(
    "all",
  );
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [selected, setSelected] = useState<DispositionRecord | null>(null);
  // Which row's sentiment picker is currently saving — disables that row's buttons only.
  const [savingId, setSavingId] = useState<string | null>(null);

  const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];
  const bucketFor = (d: DispositionRecord): DPDBucket => bucketOf(d.dpd ?? 0);

  const filtered = useMemo(() => {
    return calls.filter((c) => {
      if (!inDateRange(c.time, dateRange)) return false;
      if (filterCaller !== "all" && callerTypeOf(c) !== filterCaller) return false;
      if (filterOutcome !== "all" && c.outcome !== filterOutcome) return false;
      if (filterBucket !== "all" && bucketFor(c) !== filterBucket) return false;
      if (filterSentiment === "unreviewed" && c.sentiment) return false;
      if (
        filterSentiment !== "all" &&
        filterSentiment !== "unreviewed" &&
        c.sentiment !== filterSentiment
      )
        return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !c.debtorName.toLowerCase().includes(q) &&
          !c.agentName.toLowerCase().includes(q) &&
          !c.phone?.toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
  }, [calls, search, dateRange, filterCaller, filterOutcome, filterBucket, filterSentiment]);

  const withRecording = calls.filter((c) => !!c.recordingUrl).length;
  const unreviewed = calls.filter((c) => !c.sentiment).length;
  const flagged = calls.filter(
    (c) => c.sentiment === "rude" || c.sentiment === "frustrated",
  ).length;

  const handleInlinePick = async (call: DispositionRecord, sentiment: CallSentiment) => {
    setSavingId(call.id);
    try {
      await setCallSentiment(call.id, sentiment, managerId);
      toast.success(`${call.debtorName}: marked ${SENTIMENT_META[sentiment].label.toLowerCase()}`);
    } catch (e) {
      toast.error(errorText(e, "Failed to save sentiment"));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <>
      <div className="space-y-6">
        <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Audit</h1>
            <p className="text-sm text-muted-foreground">
              Review how your team's calls actually went — tag sentiment, not just the outcome.
            </p>
          </div>
        </div>

        {/* Stats strip — audit-focused: how much is reviewed and how much needs attention,
            not just raw counts. Each card is colored by what it means, not just labeled. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            {
              label: "Total Calls",
              value: calls.length,
              icon: PhoneCall,
              cls: "text-foreground",
              iconCls: "bg-primary/10 text-primary",
              borderCls: "border-l-primary/50",
            },
            {
              label: "Needs Review",
              value: unreviewed,
              icon: ShieldQuestion,
              cls: unreviewed > 0 ? "text-amber-600" : "text-foreground",
              iconCls: "bg-amber-500/10 text-amber-600",
              borderCls: unreviewed > 0 ? "border-l-amber-500" : "border-l-border",
            },
            {
              label: "Rude / Frustrated",
              value: flagged,
              icon: Angry,
              cls: flagged > 0 ? "text-destructive" : "text-foreground",
              iconCls: "bg-destructive/10 text-destructive",
              borderCls: flagged > 0 ? "border-l-destructive" : "border-l-border",
            },
            {
              label: "With Recording",
              value: withRecording,
              icon: Mic,
              cls: "text-foreground",
              iconCls: "bg-purple-500/10 text-purple-600",
              borderCls: "border-l-purple-500/50",
            },
          ].map(({ label, value, icon: Icon, cls, iconCls, borderCls }) => (
            <Card key={label} className={cn("p-3 border-l-4", borderCls)}>
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {label}
                </div>
                <div className={cn("rounded-md p-1", iconCls)}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
              </div>
              <div className={cn("text-2xl font-bold mt-1", cls)}>{value}</div>
            </Card>
          ))}
        </div>

        {calls.length === 0 && (
          <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            No calls logged yet for your team — this fills in as agents log dispositions. Once a
            call has a recording, tag its sentiment here (or from the detail panel) — there's no
            automatic transcription/sentiment pipeline wired up yet, so this is a manual QA tag.
          </p>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search debtor, agent, phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9 text-sm"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Select
            value={filterSentiment}
            onValueChange={(v) => setFilterSentiment(v as CallSentiment | "unreviewed" | "all")}
          >
            <SelectTrigger className="w-36 h-9 text-xs">
              <SelectValue placeholder="Sentiment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any sentiment</SelectItem>
              <SelectItem value="unreviewed">Needs review</SelectItem>
              {(Object.entries(SENTIMENT_META) as [CallSentiment, { label: string }][]).map(
                ([key, meta]) => (
                  <SelectItem key={key} value={key}>
                    {meta.label}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
          <Select
            value={filterCaller}
            onValueChange={(v) => setFilterCaller(v as CallerType | "all")}
          >
            <SelectTrigger className="w-32 h-9 text-xs">
              <SelectValue placeholder="Caller" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Agent + AI</SelectItem>
              <SelectItem value="agent">Agent only</SelectItem>
              <SelectItem value="ai">AI Bot only</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterOutcome} onValueChange={setFilterOutcome}>
            <SelectTrigger className="w-36 h-9 text-xs">
              <SelectValue placeholder="Outcome" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              {Object.entries(OUTCOME_META).map(([key, meta]) => (
                <SelectItem key={key} value={key}>
                  {meta.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative">
            <button
              type="button"
              onClick={() => setBucketDropOpen((p) => !p)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs transition-all",
                filterBucket !== "all"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
            >
              <Filter className="h-3 w-3 opacity-60" />
              {filterBucket === "all" ? "Bucket" : BUCKET_META[filterBucket].label}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {bucketDropOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-44 rounded-lg border border-border bg-card shadow-lg py-1">
                <button
                  type="button"
                  onClick={() => {
                    setFilterBucket("all");
                    setBucketDropOpen(false);
                  }}
                  className={cn(
                    "w-full px-3 py-1.5 text-left text-xs hover:bg-accent/50 transition-colors",
                    filterBucket === "all"
                      ? "text-foreground font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  All buckets
                </button>
                {BUCKET_ORDER.map((b) => {
                  const count = calls.filter((c) => bucketFor(c) === b).length;
                  if (count === 0) return null;
                  const meta = BUCKET_META[b];
                  return (
                    <button
                      key={b}
                      type="button"
                      onClick={() => {
                        setFilterBucket(b);
                        setBucketDropOpen(false);
                      }}
                      className={cn(
                        "w-full px-3 py-1.5 text-left text-xs hover:bg-accent/50 transition-colors flex items-center justify-between",
                        filterBucket === b
                          ? "text-foreground font-medium"
                          : "text-muted-foreground",
                      )}
                    >
                      <span className={meta.color.split(" ").find((c) => c.startsWith("text-"))}>
                        {meta.label}
                      </span>
                      <span className="opacity-50">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {(filterCaller !== "all" ||
            filterOutcome !== "all" ||
            filterBucket !== "all" ||
            filterSentiment !== "all" ||
            search) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-xs text-muted-foreground gap-1"
              onClick={() => {
                setSearch("");
                setDateRange(EMPTY_RANGE);
                setFilterCaller("all");
                setFilterOutcome("all");
                setFilterBucket("all");
                setFilterSentiment("all");
              }}
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">{filtered.length} calls</span>
        </div>

        {/* Call table */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="py-2.5 pl-4 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Date
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Caller
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Debtor
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Sentiment
                  </th>
                  <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Outcome
                  </th>
                  <th className="py-2.5 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Dur.
                  </th>
                  <th className="py-2.5 pr-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((call) => {
                  const { date, time } = fmtDateTime(call.time);
                  const caller = callerTypeOf(call);
                  const bucket = bucketFor(call);
                  const rowAccent =
                    call.sentiment === "rude"
                      ? "border-l-destructive bg-destructive/[0.03]"
                      : call.sentiment === "frustrated"
                        ? "border-l-amber-500 bg-amber-500/[0.03]"
                        : call.sentiment === "happy"
                          ? "border-l-success"
                          : call.sentiment === "neutral"
                            ? "border-l-muted-foreground/30"
                            : "border-l-transparent";
                  return (
                    <tr
                      key={call.id}
                      className={cn(
                        "border-l-4 hover:bg-accent/30 transition-colors cursor-pointer",
                        rowAccent,
                      )}
                      onClick={() => setSelected(call)}
                    >
                      <td className="py-3 pl-4">
                        <div className="text-[10px] text-muted-foreground">
                          {date} {time}
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-1.5">
                          {caller === "ai" ? (
                            <Bot className="h-3.5 w-3.5 text-purple-500" />
                          ) : (
                            <User className="h-3.5 w-3.5 text-primary" />
                          )}
                          <span className="text-xs text-foreground">
                            {caller === "ai" ? "AI Bot" : call.agentName}
                          </span>
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="text-xs font-medium text-foreground">{call.debtorName}</div>
                      </td>
                      <td className="py-3">
                        {call.sentiment ? (
                          <SentimentPicker
                            value={call.sentiment}
                            onPick={(s) => handleInlinePick(call, s)}
                            saving={savingId === call.id}
                          />
                        ) : (
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
                              title="Not yet audited"
                            >
                              <ShieldQuestion className="h-3.5 w-3.5" />
                              Unreviewed
                            </span>
                            <SentimentPicker
                              value={call.sentiment}
                              onPick={(s) => handleInlinePick(call, s)}
                              saving={savingId === call.id}
                            />
                          </div>
                        )}
                      </td>
                      <td className="py-3">
                        <Badge
                          variant="outline"
                          className={cn("text-[10px]", OUTCOME_META[call.outcome]?.cls)}
                        >
                          {OUTCOME_META[call.outcome]?.label ?? call.outcome}
                        </Badge>
                        <span
                          className={cn(
                            "ml-1.5 inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-medium",
                            BUCKET_META[bucket].color,
                          )}
                        >
                          {BUCKET_META[bucket].label}
                        </span>
                      </td>
                      <td className="py-3 text-center">
                        <span className="text-xs text-muted-foreground">
                          {call.durationSeconds != null ? fmtDuration(call.durationSeconds) : "—"}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs gap-1 text-primary hover:text-primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(call);
                          }}
                          disabled={!call.recordingUrl}
                        >
                          <Play className="h-3 w-3" />
                          {call.recordingUrl ? "Play" : "View"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && calls.length > 0 && (
                  <tr>
                    <td colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                      No calls match your filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full max-w-2xl p-0 overflow-hidden flex flex-col sm:max-w-2xl"
        >
          {selected && (
            <CallDetailSheet
              call={selected}
              managerEmail={managerId}
              onSentimentSaved={setSelected}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
