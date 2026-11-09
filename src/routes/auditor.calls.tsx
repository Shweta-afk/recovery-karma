import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Mic,
  Search,
  Sparkles,
  Star,
  TriangleAlert,
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
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { DateRangeFilter } from "@/components/date-range-filter";
import { CallReviewSheet } from "@/components/audit/call-review-sheet";
import type { DateRange } from "@/lib/date-filter";
import { errorText } from "@/lib/app-error";
import { getAccessToken } from "@/lib/access-token";
import { getAuditOrg, listAuditCalls } from "@/lib/call-audit.server";
import {
  dispositionLabel,
  fmtSeconds,
  istDayKeyDaysAgo,
  OUTCOME_LABEL,
  type AuditCallRow,
  type AuditQueueFilter,
} from "@/lib/call-audit";
import { istDateTime } from "@/lib/portfolio-feedback";

interface CallsSearch {
  call?: string;
  team?: string;
  agent?: string;
}

export const Route = createFileRoute("/auditor/calls")({
  head: () => ({ meta: [{ title: "All Calls · SamvadX" }] }),
  validateSearch: (s: Record<string, unknown>): CallsSearch => ({
    call: typeof s.call === "string" ? s.call : undefined,
    team: typeof s.team === "string" ? s.team : undefined,
    agent: typeof s.agent === "string" ? s.agent : undefined,
  }),
  component: AuditorCalls,
});

const PAGE_SIZE = 50;
const ALL = "all";
type Org = Awaited<ReturnType<typeof getAuditOrg>>;
type SortKey = "newest" | "oldest" | "longest" | "score_high" | "score_low";

function Picker({
  value,
  onChange,
  all,
  options,
  width = "w-40",
}: {
  value: string;
  onChange: (v: string) => void;
  all: string;
  options: { value: string; label: string }[];
  width?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={`h-9 text-xs ${width}`}>
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

function AuditorCalls() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [org, setOrg] = useState<Org | null>(null);
  const [range, setRange] = useState<DateRange>({
    from: istDayKeyDaysAgo(29),
    to: istDayKeyDaysAgo(0),
  });
  const [team, setTeam] = useState(search.team ?? ALL);
  const [manager, setManager] = useState(ALL);
  const [agent, setAgent] = useState(search.agent ?? ALL);
  const [portfolio, setPortfolio] = useState(ALL);
  const [outcome, setOutcome] = useState(ALL);
  const [audit, setAudit] = useState<string>(ALL);
  const [recording, setRecording] = useState(ALL);
  const [sort, setSort] = useState<SortKey>("newest");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditCallRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    getAccessToken()
      .then((accessToken) => getAuditOrg({ data: { accessToken } }))
      .then(setOrg)
      .catch((e) => setError(errorText(e, "Could not load teams")));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const from = range.from || istDayKeyDaysAgo(29);
  const to = range.to || istDayKeyDaysAgo(0);
  const filters = useMemo(
    () => ({
      from,
      to,
      teamId: team === ALL ? undefined : team,
      managerId: manager === ALL ? undefined : manager,
      agentId: agent === ALL ? undefined : agent,
      portfolioId: portfolio === ALL ? undefined : portfolio,
      outcome: outcome === ALL ? undefined : outcome,
      audit: audit === ALL ? undefined : (audit as AuditQueueFilter),
      recording: recording === ALL ? undefined : (recording as "yes" | "no"),
      search: query || undefined,
      sort,
    }),
    [from, to, team, manager, agent, portfolio, outcome, audit, recording, query, sort],
  );

  // Any filter change starts again at the first page.
  useEffect(() => setPage(0), [filters]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await listAuditCalls({
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

  const openCall = useCallback(
    (call?: string) => navigate({ search: (s: CallsSearch) => ({ ...s, call }), replace: true }),
    [navigate],
  );

  const managers = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of org?.teams ?? [])
      if (t.managerId && t.managerName) m.set(t.managerId, t.managerName);
    return [...m.entries()].map(([value, label]) => ({ value, label }));
  }, [org]);
  const pages = total ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">All Calls</h1>
          <p className="text-sm text-muted-foreground">
            Open any call to listen, read the AI's view and give your review.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="Search calls"
              placeholder="Customer, number, loan ID, agent"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-9 pl-8 text-xs"
            />
          </div>
          <DateRangeFilter value={range} onChange={setRange} />
          <Picker
            value={team}
            onChange={setTeam}
            all="All teams"
            options={(org?.teams ?? []).map((t) => ({ value: t.id, label: t.name }))}
          />
          <Picker value={manager} onChange={setManager} all="All managers" options={managers} />
          <Picker
            value={agent}
            onChange={setAgent}
            all="All agents"
            options={(org?.agents ?? []).map((a) => ({ value: a.id, label: a.name }))}
          />
          <Picker
            value={portfolio}
            onChange={setPortfolio}
            all="All portfolios"
            options={(org?.portfolios ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
          <Picker
            value={audit}
            onChange={setAudit}
            all="Any review status"
            options={[
              { value: "pending", label: "Not reviewed" },
              { value: "ai_waiting", label: "AI done, waiting for you" },
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
            width="w-36"
            options={Object.keys(OUTCOME_LABEL).map((value) => ({
              value,
              label: value === "voicemail" ? "Voicemail" : OUTCOME_LABEL[value],
            }))}
          />
          <Picker
            value={recording}
            onChange={setRecording}
            all="Recording: any"
            width="w-32"
            options={[
              { value: "yes", label: "Has recording" },
              { value: "no", label: "No recording" },
            ]}
          />
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
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
                  "Team / Manager",
                  "Agent",
                  "Customer",
                  "Disposition",
                  "Duration",
                  "Review",
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
                  onClick={() => openCall(c.call_id)}
                  onKeyDown={(e) => e.key === "Enter" && openCall(c.call_id)}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                    {istDateTime(c.created_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="text-foreground">{c.team_name ?? "No team"}</div>
                    <div className="text-muted-foreground">{c.manager_name ?? ""}</div>
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
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {c.audit_id ? (
                      <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                        {c.fatal && (
                          <TriangleAlert
                            aria-label="Fatal error"
                            className="h-3.5 w-3.5 text-destructive"
                          />
                        )}
                        {c.exemplary && (
                          <Star aria-label="Best call" className="h-3.5 w-3.5 text-amber-500" />
                        )}
                        {c.final_percent}% · {c.grade}
                      </span>
                    ) : c.ai_sentiment ? (
                      <Badge variant="outline" className="gap-1 border-primary/30 text-primary">
                        <Sparkles className="h-3 w-3" /> AI done, waiting for you
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">Not reviewed</span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-14 text-center text-sm text-muted-foreground">
                    No calls match these filters.
                  </td>
                </tr>
              )}
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-14 text-center text-sm text-muted-foreground">
                    Loading…
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

      <Sheet open={!!search.call} onOpenChange={(open) => !open && openCall(undefined)}>
        <SheetContent side="right" className="w-full max-w-2xl overflow-hidden p-0 sm:max-w-2xl">
          <SheetTitle className="sr-only">Call review</SheetTitle>
          {search.call && (
            <CallReviewSheet
              callId={search.call}
              canReview={!!org?.canReview}
              onSaved={() => {
                setReloadKey((k) => k + 1);
                openCall(undefined);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
