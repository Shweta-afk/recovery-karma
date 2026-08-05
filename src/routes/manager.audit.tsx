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
} from "lucide-react";
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
import { bucketOf, BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import { useAuth } from "@/lib/auth";
import { useManagerTeamAgents } from "@/lib/team-store";
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { useStorageSync } from "@/lib/storage-sync";

export const Route = createFileRoute("/manager/audit")({
  head: () => ({ meta: [{ title: "Call Audit · Axiora" }] }),
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

const OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  promised: "PTP",
  refused: "Refused",
  no_answer: "No Answer",
  callback: "Callback",
  voicemail: "Voicemail",
  dispute: "Dispute",
  settlement: "Settlement",
};

/* ─── sub-components ─────────────────────────────────────────────────────── */

function RecordingPlayer({ url }: { url?: string }) {
  if (!url) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        <Mic className="h-4 w-4 shrink-0" />
        No recording available for this call — Tata publishes recordings asynchronously, so it may
        still arrive later.
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

function CallDetailSheet({ call }: { call: DispositionRecord }) {
  const { date, time } = fmtDateTime(call.time);
  const caller = callerTypeOf(call);

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
          <Badge variant="outline" className="shrink-0">
            {OUTCOME_LABEL[call.outcome] ?? call.outcome}
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
  const agents = useManagerTeamAgents(managerId);
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
  const [filterCaller, setFilterCaller] = useState<CallerType | "all">("all");
  const [filterOutcome, setFilterOutcome] = useState<string>("all");
  const [filterBucket, setFilterBucket] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [selected, setSelected] = useState<DispositionRecord | null>(null);

  const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];
  const bucketFor = (d: DispositionRecord): DPDBucket => bucketOf(d.dpd ?? 0);

  const filtered = useMemo(() => {
    return calls.filter((c) => {
      if (filterCaller !== "all" && callerTypeOf(c) !== filterCaller) return false;
      if (filterOutcome !== "all" && c.outcome !== filterOutcome) return false;
      if (filterBucket !== "all" && bucketFor(c) !== filterBucket) return false;
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
  }, [calls, search, filterCaller, filterOutcome, filterBucket]);

  const agentCalls = calls.filter((c) => callerTypeOf(c) === "agent").length;
  const aiCalls = calls.filter((c) => callerTypeOf(c) === "ai").length;
  const withRecording = calls.filter((c) => !!c.recordingUrl).length;

  return (
    <>
      <div className="space-y-6">
        <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Audit</h1>
            <p className="text-sm text-muted-foreground">
              Real call history for your team — outcomes, notes, and recordings as they're logged.
            </p>
          </div>
        </div>

        {/* Stats strip — real counts, no sentiment/flagging (not backed by the schema yet) */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Total Calls", value: calls.length },
            { label: "Agent Calls", value: agentCalls },
            { label: "AI/Bot Calls", value: aiCalls },
            { label: "With Recording", value: withRecording },
          ].map(({ label, value }) => (
            <Card key={label} className="p-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
              </div>
              <div className="text-2xl font-bold mt-1 text-foreground">{value}</div>
            </Card>
          ))}
        </div>

        {calls.length === 0 && (
          <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            No calls logged yet for your team — this fills in as agents log dispositions. (Call
            sentiment and transcripts aren't shown here — there's no transcription/sentiment
            pipeline wired up yet, so this view sticks to what's actually recorded: outcome,
            duration, notes, and the recording itself.)
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
              {Object.entries(OUTCOME_LABEL).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
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
            search) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-xs text-muted-foreground gap-1"
              onClick={() => {
                setSearch("");
                setFilterCaller("all");
                setFilterOutcome("all");
                setFilterBucket("all");
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
                  return (
                    <tr
                      key={call.id}
                      className="hover:bg-accent/30 transition-colors cursor-pointer"
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
                        <Badge variant="secondary" className="text-[10px]">
                          {OUTCOME_LABEL[call.outcome] ?? call.outcome}
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
                    <td colSpan={6} className="py-16 text-center text-sm text-muted-foreground">
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
          {selected && <CallDetailSheet call={selected} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
