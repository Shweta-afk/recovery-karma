import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Loader2, Mic, Search, Star } from "lucide-react";
import { toast } from "sonner";
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
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DateRangeFilter } from "@/components/date-range-filter";
import { ManagerCallSheet } from "@/components/audit/manager-call-sheet";
import { ReceivedReviews } from "@/components/audit/received-reviews";
import type { DateRange } from "@/lib/date-filter";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { useAuth } from "@/lib/auth";
import { useActiveTeam } from "@/lib/active-team-store";
import { BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import { auditFeedbackSheet } from "@/lib/call-audit-reports";
import {
  getManagerExportPage,
  getManagerPerformance,
  getManagerScope,
  listManagerCalls,
} from "@/lib/call-audit.server";
import {
  OUTCOME_LABEL,
  dispositionLabel,
  fmtSeconds,
  istDayKeyDaysAgo,
  type AuditCallRow,
  type TeamPerformance,
} from "@/lib/call-audit";
import { istDateTime } from "@/lib/portfolio-feedback";

type Tab = "calls" | "performance" | "reviews";
interface AuditSearch {
  tab?: Tab;
  call?: string;
}

export const Route = createFileRoute("/manager/audit")({
  head: () => ({ meta: [{ title: "Call Audit · SamvadX" }] }),
  validateSearch: (s: Record<string, unknown>): AuditSearch => ({
    tab: s.tab === "performance" || s.tab === "reviews" ? s.tab : undefined,
    call: typeof s.call === "string" ? s.call : undefined,
  }),
  component: CallAuditPage,
});

const ALL = "all";
const PAGE_SIZE = 50;
const BUCKETS: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];
type Sort = "newest" | "oldest" | "longest" | "score_high" | "score_low";
type Scope = Awaited<ReturnType<typeof getManagerScope>>;
const scoreText = (s: number | null) => (s === null ? "—" : `${s}%`);

function Picker({
  value,
  onChange,
  all,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  all: string;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CallsTab({
  from,
  to,
  teamId,
  scope,
  onOpen,
  reloadKey,
}: {
  from: string;
  to: string;
  teamId?: string;
  scope: Scope | null;
  onOpen: (id: string) => void;
  reloadKey: number;
}) {
  const [agent, setAgent] = useState(ALL);
  const [review, setReview] = useState(ALL);
  const [outcome, setOutcome] = useState(ALL);
  const [tag, setTag] = useState(ALL);
  const [caller, setCaller] = useState(ALL);
  const [bucket, setBucket] = useState(ALL);
  const [sort, setSort] = useState<Sort>("newest");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditCallRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const pick = <T extends string>(v: string) => (v === ALL ? undefined : (v as T));
  const filters = useMemo(
    () => ({
      from,
      to,
      teamId,
      agentId: pick(agent),
      outcome: pick(outcome),
      audit: pick<"pending" | "audited" | "fatal" | "exemplary" | "coaching">(review),
      managerTag: pick<"none" | "happy" | "neutral" | "frustrated" | "rude">(tag),
      caller: pick<"agent" | "ai">(caller),
      bucket: pick<DPDBucket>(bucket),
      search: query || undefined,
      sort,
    }),
    [from, to, teamId, agent, outcome, review, tag, caller, bucket, query, sort],
  );

  useEffect(() => setPage(0), [filters]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await listManagerCalls({
        data: {
          accessToken: await getAccessToken(),
          filters,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
      });
      if (!live) return;
      setRows(res.rows);
      if (res.total !== null) setTotal(res.total);
    })()
      .catch((e) => live && setError(errorText(e, "Could not load calls")))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filters, page, reloadKey]);

  const agents = (scope?.agents ?? []).filter((a) => !teamId || a.teamIds.includes(teamId));
  const pages = total ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-52">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search calls"
            placeholder="Customer, number, loan ID"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-9 pl-8 text-xs"
          />
        </div>
        <Picker
          value={agent}
          onChange={setAgent}
          all="All agents"
          options={agents.map((a) => ({ value: a.id, label: a.name }))}
        />
        <Picker
          value={review}
          onChange={setReview}
          all="Any review"
          options={[
            { value: "pending", label: "Not reviewed" },
            { value: "audited", label: "Reviewed" },
            { value: "fatal", label: "Fatal errors" },
            { value: "exemplary", label: "Best calls" },
            { value: "coaching", label: "Needs coaching" },
          ]}
        />
        <Picker
          value={outcome}
          onChange={setOutcome}
          all="All dispositions"
          options={Object.keys(OUTCOME_LABEL).map((value) => ({
            value,
            label: value === "voicemail" ? "Voicemail" : OUTCOME_LABEL[value],
          }))}
        />
        <Picker
          value={tag}
          onChange={setTag}
          all="Manager's tag: any"
          options={[
            { value: "none", label: "Not tagged" },
            { value: "happy", label: "Happy" },
            { value: "neutral", label: "Neutral" },
            { value: "frustrated", label: "Frustrated" },
            { value: "rude", label: "Rude" },
          ]}
        />
        <Picker
          value={caller}
          onChange={setCaller}
          all="Agent + AI"
          options={[
            { value: "agent", label: "Agent only" },
            { value: "ai", label: "AI Bot only" },
          ]}
        />
        <Picker
          value={bucket}
          onChange={setBucket}
          all="All buckets"
          options={BUCKETS.map((b) => ({ value: b, label: BUCKET_META[b].label }))}
        />
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger className="h-9 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="longest">Longest first</SelectItem>
            <SelectItem value="score_high">Best score first</SelectItem>
            <SelectItem value="score_low">Lowest score first</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">
          {total === null ? "" : `${total.toLocaleString("en-IN")} calls`}
        </span>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-muted-foreground">
              {[
                "Date",
                "Agent",
                "Customer",
                "Disposition",
                "Duration",
                "Manager's Tag",
                "Auditor's Score",
              ].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 py-2.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((c) => (
              <tr
                key={c.call_id}
                tabIndex={0}
                className="cursor-pointer hover:bg-accent/30 focus:bg-accent/30 focus:outline-none"
                onClick={() => onOpen(c.call_id)}
                onKeyDown={(e) => e.key === "Enter" && onOpen(c.call_id)}
              >
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {istDateTime(c.created_at)}
                </td>
                <td className="px-4 py-2.5 text-foreground">{c.agent_name}</td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-foreground">
                    {c.customer_name || "Manual call"}
                  </div>
                  <div className="text-muted-foreground">{c.loan_reference ?? ""}</div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="text-foreground">{dispositionLabel(c.outcome)}</div>
                  <div className="text-muted-foreground">{c.outcome_reason ?? ""}</div>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {fmtSeconds(c.duration_seconds)}
                    {c.recording_url && (
                      <Mic aria-label="Has recording" className="h-3 w-3 text-primary" />
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5 capitalize text-foreground">
                  {c.manager_sentiment ?? "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {c.audit_id ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 font-semibold text-foreground",
                        c.fatal && "text-destructive",
                      )}
                    >
                      {c.exemplary && <Star className="h-3.5 w-3.5 text-amber-500" />}
                      {c.final_percent}% · {c.grade}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not reviewed</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-14 text-center text-sm text-muted-foreground">
                  {loading ? "Loading…" : "No calls match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        Page {page + 1} of {pages}
        <Button
          aria-label="Previous page"
          size="icon"
          variant="outline"
          className="h-8 w-8"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          aria-label="Next page"
          size="icon"
          variant="outline"
          className="h-8 w-8"
          disabled={page + 1 >= pages}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function PerformanceTab({
  from,
  to,
  teamId,
  reloadKey,
}: {
  from: string;
  to: string;
  teamId?: string;
  reloadKey: number;
}) {
  const [data, setData] = useState<TeamPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    (async () => {
      const res = await getManagerPerformance({
        data: { accessToken: await getAccessToken(), from, to, teamId },
      });
      if (live) setData(res);
    })().catch((e) => live && setError(errorText(e, "Could not load team performance")));
    return () => {
      live = false;
    };
  }, [from, to, teamId, reloadKey]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const cards = [
    { label: "Calls", value: data.calls },
    { label: "Connected", value: data.connected },
    { label: "Talk Time", value: fmtSeconds(data.talk_seconds) },
    { label: "Reviewed", value: data.audited },
    { label: "Not Reviewed", value: data.not_audited },
    { label: "Average Score", value: scoreText(data.avg_score) },
    { label: "Fatal Errors", value: data.fatal, bad: data.fatal > 0 },
    { label: "Need Coaching", value: data.coaching },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label} className="p-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {c.label}
            </div>
            <div
              className={cn("mt-1 text-2xl font-bold text-foreground", c.bad && "text-destructive")}
            >
              {c.value}
            </div>
          </Card>
        ))}
      </div>

      <Card className="overflow-x-auto">
        <h2 className="px-4 pt-4 text-sm font-semibold text-foreground">Agents, best first</h2>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              {[
                "Agent",
                "Calls",
                "Connected",
                "Talk Time",
                "Reviewed",
                "Avg Score",
                "Best Calls",
                "Fatal",
                "Coaching",
                "Weakest Area",
              ].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.agents.map((a) => (
              <tr key={a.agent_id}>
                <td className="px-4 py-2 font-medium text-foreground">{a.agent_name}</td>
                <td className="px-4 py-2">{a.calls}</td>
                <td className="px-4 py-2">{a.connected}</td>
                <td className="px-4 py-2">{fmtSeconds(a.talk_seconds)}</td>
                <td className="px-4 py-2">{a.audited}</td>
                <td className="px-4 py-2 font-semibold">{scoreText(a.avg_score)}</td>
                <td className="px-4 py-2">{a.best_calls}</td>
                <td className={cn("px-4 py-2", a.fatal > 0 && "font-semibold text-destructive")}>
                  {a.fatal}
                </td>
                <td className="px-4 py-2">{a.coaching}</td>
                <td className="px-4 py-2 text-muted-foreground">{a.weakest ?? "—"}</td>
              </tr>
            ))}
            {data.agents.length === 0 && (
              <tr>
                <td colSpan={10} className="py-8 text-center text-muted-foreground">
                  No calls in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {data.parameters.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            Scorecard results, weakest first
          </h2>
          <ul className="space-y-2.5">
            {data.parameters.map((p) => (
              <li key={p.id} className="text-xs">
                <div className="mb-1 flex justify-between gap-3">
                  <span className="text-foreground">{p.label}</span>
                  <span className="font-semibold text-foreground">{p.percent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${p.percent}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function CallAuditPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { user } = useAuth();
  const { activeTeam } = useActiveTeam(user?.email ?? user?.id ?? "");
  const teamId = activeTeam?.id;
  const [range, setRange] = useState<DateRange>({
    from: istDayKeyDaysAgo(29),
    to: istDayKeyDaysAgo(0),
  });
  const [scope, setScope] = useState<Scope | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getAccessToken()
      .then((accessToken) => getManagerScope({ data: { accessToken } }))
      .then(setScope)
      .catch((e) => toast.error(errorText(e, "Could not load your team")));
  }, []);

  const from = range.from || istDayKeyDaysAgo(29);
  const to = range.to || istDayKeyDaysAgo(0);
  const tab = search.tab ?? "calls";

  const openCall = useCallback(
    (call?: string) => navigate({ search: (s: AuditSearch) => ({ ...s, call }), replace: true }),
    [navigate],
  );

  const download = async () => {
    setExporting(true);
    try {
      const accessToken = await getAccessToken();
      const rows: AuditCallRow[] = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await getManagerExportPage({
          data: { accessToken, from, to, teamId, limit: 1000, offset },
        });
        rows.push(...page);
        if (page.length < 1000) break;
      }
      await downloadXlsx(reportFilename("team-audit-feedback", { from, to }), [
        auditFeedbackSheet(rows, window.location.origin, "manager"),
      ]);
      toast.success(`${rows.length} reviewed calls downloaded`);
    } catch (e) {
      toast.error(errorText(e, "Could not build this report"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Audit</h1>
            <p className="text-sm text-muted-foreground">
              Your team's calls, scores and what the auditor said.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeFilter value={range} onChange={setRange} />
            <Button
              variant="outline"
              className="h-9 gap-2 text-xs"
              disabled={exporting}
              onClick={download}
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Audit + Feedback Excel
            </Button>
          </div>
        </div>

        <Tabs
          value={tab}
          onValueChange={(v) =>
            navigate({ search: (s: AuditSearch) => ({ ...s, tab: v as Tab }), replace: true })
          }
        >
          <TabsList>
            <TabsTrigger value="calls">Calls</TabsTrigger>
            <TabsTrigger value="performance">Team Performance</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
          </TabsList>
          <TabsContent value="calls" className="mt-4">
            <CallsTab
              from={from}
              to={to}
              teamId={teamId}
              scope={scope}
              onOpen={openCall}
              reloadKey={reloadKey}
            />
          </TabsContent>
          <TabsContent value="performance" className="mt-4">
            <PerformanceTab from={from} to={to} teamId={teamId} reloadKey={reloadKey} />
          </TabsContent>
          <TabsContent value="reviews" className="mt-4">
            <ReceivedReviews teamId={teamId} />
          </TabsContent>
        </Tabs>
      </div>

      <Sheet open={!!search.call} onOpenChange={(open) => !open && openCall(undefined)}>
        <SheetContent side="right" className="w-full max-w-2xl overflow-hidden p-0 sm:max-w-2xl">
          <SheetTitle className="sr-only">Call details</SheetTitle>
          {search.call && (
            <ManagerCallSheet callId={search.call} onChanged={() => setReloadKey((k) => k + 1)} />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
