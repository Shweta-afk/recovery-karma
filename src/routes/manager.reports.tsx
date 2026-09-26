import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo, Fragment } from "react";
import {
  BarChart2,
  Users,
  PhoneCall,
  IndianRupee,
  FileDown,
  ChevronRight,
  CheckCircle2,
  HandCoins,
  AlertTriangle,
  Search,
  Trophy,
  Target,
  User,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { DateRangeFilter } from "@/components/date-range-filter";
import { InsightsReports } from "@/components/profilex/insights-reports";
import type { InsightsPeriod } from "@/lib/profilex/period";
import {
  EMPTY_RANGE,
  inDateRange,
  isRangeActive,
  describeRange,
  type DateRange,
} from "@/lib/date-filter";
import { useActiveTeam } from "@/lib/active-team-store";
import { useTeamAgents } from "@/lib/team-store";
import {
  getTeamDispositions,
  refreshDispositions,
  getTeamPtpFollowups,
  calcStats,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { getVisiblePortfolioMeta, refreshVisiblePortfolioMeta } from "@/lib/scoped-debtors";
import { usePosByDebtor } from "@/lib/pos-lookup";
import {
  getAgentAccountCounts,
  getPortfolioTotals,
  refreshReportMetrics,
} from "@/lib/report-metrics-store";
import { getPayments, refreshPayments, type PaymentRecord } from "@/lib/payments-store";
import { MonthlyTrendPanel, type TrendGroup } from "@/components/reports/monthly-trend";
import { scopeToAgents, unattributedCollected } from "@/lib/monthly-trend";
import { formatINR } from "@/lib/mock-debtors";
import { downloadCsv } from "@/lib/csv-export";
import {
  OUTCOME_LABELS,
  OUTCOME_COLOR,
  OutcomeBreakdown,
} from "@/components/reports/outcome-breakdown";
import { Stat } from "@/components/reports/stat-card";
import { AgentCallLog } from "@/components/reports/agent-call-log";
import { DataTable, ReportSection } from "@/components/reports/data-table";
import { AgentReportDetail } from "@/components/reports/agent-detail";
import {
  Leaderboard,
  LEADER_METRIC_CAPTION,
  type LeaderboardMetric,
} from "@/components/reports/leaderboard";
import { DIAL_MODE_META, UNKNOWN_DIAL_MODE_LABEL, type DialMode } from "@/lib/call-queue/types";

// Fixed display order for the Dial Mode report — Productive (multi_line) and Progressive
// (sequential) first since they're the headline comparison, then single/manual, then whatever
// predates dial_mode tracking.
const DIAL_MODE_ORDER: (DialMode | "unknown")[] = [
  "multi_line",
  "sequential",
  "single",
  "manual",
  "unknown",
];

export const Route = createFileRoute("/manager/reports")({
  head: () => ({ meta: [{ title: "Reports · SamvadX Manager" }] }),
  component: ManagerReportsPage,
});

function ManagerReportsPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const { activeTeam } = useActiveTeam(managerId);
  const teamAgents = useTeamAgents(activeTeam?.id);

  const [disps, setDisps] = useState<DispositionRecord[]>(() =>
    activeTeam ? getTeamDispositions(activeTeam.id) : [],
  );
  const [search, setSearch] = useState("");
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  // null = "not chosen yet" — see effectiveLeaderMetric below.
  const [leaderMetric, setLeaderMetric] = useState<LeaderboardMetric | null>(null);
  // Scopes the Overview KPIs, Leaderboard, Outcome Mix, By Agent table and Call Log to a date
  // range — Monthly Trend and PTP Follow-ups stay unfiltered since they're inherently their own
  // time window (this month vs last) or a current-state view (promises still open), not a slice
  // of the call log.
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_RANGE);
  const [insightsPeriod, setInsightsPeriod] = useState<InsightsPeriod>("this-month");

  useEffect(() => {
    const load = () => setDisps(activeTeam ? getTeamDispositions(activeTeam.id) : []);
    load();
    window.addEventListener("dispositions-updated", load);
    refreshDispositions();
    return () => window.removeEventListener("dispositions-updated", load);
    // Only the active team's id should retrigger this, not every re-render of the team object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam?.id]);

  const [allPayments, setAllPayments] = useState<PaymentRecord[]>(() => getPayments());
  useEffect(() => {
    const load = () => setAllPayments(getPayments());
    load();
    window.addEventListener("payments-updated", load);
    refreshPayments();
    return () => window.removeEventListener("payments-updated", load);
  }, []);

  // Counts come from SQL aggregates, not from counting cached debtor rows — the portfolio
  // cache exceeds localStorage's quota on this dataset and serves a partial snapshot.
  // See report-metrics-store.ts.
  const [agentCounts, setAgentCounts] = useState(() => getAgentAccountCounts());
  const [portfolioTotals, setPortfolioTotals] = useState(() => getPortfolioTotals());
  useEffect(() => {
    const load = () => {
      setAgentCounts(getAgentAccountCounts());
      setPortfolioTotals(getPortfolioTotals());
    };
    load();
    window.addEventListener("report-metrics-updated", load);
    refreshReportMetrics();
    return () => window.removeEventListener("report-metrics-updated", load);
  }, []);

  const activeCountByAgent = useMemo(
    () => new Map(agentCounts.map((a) => [a.agentEmail, a.activeAssigned])),
    [agentCounts],
  );

  // The team's portfolios (only their ids are read, to attribute bank-reported payments) come
  // from the portfolio list, not the full debtor sync this page used to run (growth plan #3).
  const [portfolioVersion, setPortfolioVersion] = useState(0);
  useEffect(() => {
    const bump = () => setPortfolioVersion((n) => n + 1);
    window.addEventListener("visible-portfolio-meta-updated", bump);
    const refetch = () => void refreshVisiblePortfolioMeta();
    window.addEventListener("portfolios-updated", refetch);
    refetch();
    return () => {
      window.removeEventListener("visible-portfolio-meta-updated", bump);
      window.removeEventListener("portfolios-updated", refetch);
    };
  }, []);

  const portfolios = useMemo(
    () => getVisiblePortfolioMeta().filter((p) => p.teamId === activeTeam?.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTeam?.id, portfolioVersion],
  );
  // Loan amount per account named in these calls/payments, for the POS Worked / POS Promised
  // trend metrics — fetched for those accounts only (pos-lookup.ts).
  const posByDebtor = usePosByDebtor([
    ...disps.map((d) => d.debtorId),
    ...allPayments.map((p) => p.debtorId),
  ]);
  // Summed from the per-agent SQL aggregate, so it is correct regardless of how much of the
  // portfolio cache survived localStorage's quota.
  const assignedCount = useMemo(
    () => teamAgents.reduce((s, a) => s + (activeCountByAgent.get(a.id) ?? 0), 0),
    [teamAgents, activeCountByAgent],
  );
  const activePortfolioCount = useMemo(
    () => portfolioTotals.filter((p) => p.isOpen && p.teamId === activeTeam?.id).length,

    [portfolioTotals, activeTeam?.id],
  );

  const rangedDisps = useMemo(
    () => disps.filter((d) => inDateRange(d.time, dateRange)),
    [disps, dateRange],
  );

  const globalStats = useMemo(() => calcStats(rangedDisps), [rangedDisps]);

  // How effective each dial mode has actually been — "Productive Dial" (dialerMode
  // "predictive", stored dial_mode "multi_line") vs "Progressive Dial" (dialerMode
  // "productive", stored "sequential") vs single/manual dials, and "Before tracking" for calls
  // logged before dial_mode existed (20260827_call_logs_dial_mode.sql). See DIAL_MODE_META in
  // call-queue/types.ts for why the display labels and stored values don't match each other.
  const dialModeStats = useMemo(
    () =>
      DIAL_MODE_ORDER.map((mode) => {
        const disps =
          mode === "unknown"
            ? rangedDisps.filter((d) => !d.dialMode)
            : rangedDisps.filter((d) => d.dialMode === mode);
        return {
          mode,
          label: mode === "unknown" ? UNKNOWN_DIAL_MODE_LABEL : DIAL_MODE_META[mode].label,
          ...calcStats(disps),
        };
      }).filter((r) => r.total > 0),
    [rangedDisps],
  );

  // The team's money, both ways it arrives: what the team's agents collected, plus what the
  // bank reported against the team's own portfolios (agent_id null — nobody collected it, but
  // it is unarguably this team's recovery and omitting it understates the team every month a
  // paid file lands).
  const teamPayments = useMemo(() => {
    const roster = new Set(teamAgents.map((a) => a.id));
    const teamPortfolioIds = new Set(portfolios.map((p) => p.id));
    return allPayments.filter((p) =>
      p.agentId === null
        ? p.portfolioId !== undefined && teamPortfolioIds.has(p.portfolioId)
        : roster.has(p.agentId),
    );
  }, [allPayments, teamAgents, portfolios]);

  const agentTrendGroups = useMemo<TrendGroup[]>(
    () =>
      teamAgents.map((a) => {
        const scoped = scopeToAgents(disps, allPayments, [a.id]);
        return { id: a.id, name: a.name, sub: a.id, ...scoped };
      }),
    [teamAgents, disps, allPayments],
  );

  const teamUnattributed = useMemo(() => unattributedCollected(teamPayments), [teamPayments]);

  const agentStats = useMemo(
    () =>
      teamAgents
        .map((agent) => {
          const agentDisps = rangedDisps.filter((d) => d.agentId === agent.id);
          // Straight from the SQL aggregate — see report-metrics-store.ts.
          const assigned = activeCountByAgent.get(agent.id) ?? 0;
          return {
            agentId: agent.id,
            name: agent.name,
            stats: calcStats(agentDisps),
            assignedCount: assigned,
            disps: agentDisps,
          };
        })
        .sort((a, b) => b.stats.total - a.stats.total),
    [teamAgents, rangedDisps, activeCountByAgent],
  );

  const filtered = search.trim()
    ? agentStats.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agentStats;

  const leaderboardEntries = useMemo(
    () =>
      agentStats.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        collected: a.stats.paidAmount,
        ptps: a.stats.ptps,
        ptpAmount: a.stats.ptpAmount,
        calls: a.stats.total,
        contactRate: a.stats.contactRate,
      })),
    [agentStats],
  );

  // Rank by collections once anyone has collected; otherwise fall back to a metric that
  // actually distinguishes agents instead of showing an all-zero ordering.
  const effectiveLeaderMetric: LeaderboardMetric =
    leaderMetric ??
    (leaderboardEntries.some((e) => e.collected > 0)
      ? "collected"
      : leaderboardEntries.some((e) => e.ptpAmount > 0)
        ? "ptpAmount"
        : "calls");

  const followups = useMemo(
    () => (activeTeam ? getTeamPtpFollowups(activeTeam.agentIds) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTeam?.id, disps],
  );
  const overdueFollowups = followups.filter((f) => f.daysLeft < 0);

  const hasData = disps.length > 0;

  if (!activeTeam) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
        <p className="text-sm text-muted-foreground">No team selected.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
          <p className="text-sm text-muted-foreground">
            {activeTeam.name} — agent performance, call outcomes, and open promises.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-normal text-xs">
            {teamAgents.length} agent{teamAgents.length !== 1 ? "s" : ""}
          </Badge>
          <Badge variant="outline" className="font-normal text-xs">
            {activePortfolioCount} active portfolio
            {activePortfolioCount !== 1 ? "s" : ""}
          </Badge>
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        Overview, Leaderboard, By Agent and Call Log are scoped to{" "}
        <span className="font-medium text-foreground">{describeRange(dateRange)}</span>. Monthly
        Trend and PTP Follow-ups are always all-time.
      </p>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat
          icon={CheckCircle2}
          label="Collected"
          value={formatINR(globalStats.paidAmount)}
          sub={`${globalStats.paid} payments`}
          green
        />
        <Stat
          icon={IndianRupee}
          label="PTP Value"
          value={formatINR(globalStats.ptpAmount)}
          sub={`${globalStats.ptps} promises`}
          green
        />
        <Stat
          icon={PhoneCall}
          label="Calls Logged"
          value={globalStats.total.toLocaleString()}
          sub={`${globalStats.contactRate}% contact rate`}
        />
        <Stat
          icon={Users}
          label="Active Accounts"
          value={assignedCount.toLocaleString()}
          sub="assigned & still open"
        />
        <Stat
          icon={Target}
          label="Open Promises"
          value={formatINR(followups.reduce((s, f) => s + f.ptpAmount, 0))}
          sub={`${followups.length} open${
            overdueFollowups.length > 0 ? ` · ${overdueFollowups.length} overdue` : ""
          }`}
        />
      </div>

      {!hasData && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <BarChart2 className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-foreground">No call data yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Reports populate as your agents log call outcomes in the queue.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="agents">By Agent</TabsTrigger>
          <TabsTrigger value="trend">Monthly Trend</TabsTrigger>
          <TabsTrigger value="outcomes">Outcome Breakdown</TabsTrigger>
          <TabsTrigger value="dialmode">Dial Mode</TabsTrigger>
          <TabsTrigger value="followups">
            PTP Follow-ups
            {overdueFollowups.length > 0 && (
              <Badge variant="destructive" className="ml-1.5 text-[10px] py-0">
                {overdueFollowups.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="detail">Call Log</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>

        {/* ── INSIGHTS TAB ── what each lookup found and what happened on the account after.
            Scoped to this manager's team by RLS, so there is no manager filter here. */}
        <TabsContent value="insights" className="mt-4 space-y-4">
          <InsightsReports
            period={insightsPeriod}
            onPeriodChange={setInsightsPeriod}
            showManagerFilter={false}
          />
        </TabsContent>

        {/* ── MONTHLY TREND TAB ── */}
        <TabsContent value="trend" className="mt-4">
          <MonthlyTrendPanel
            posByDebtor={posByDebtor}
            disps={disps}
            payments={teamPayments}
            note={
              teamUnattributed.current > 0 || teamUnattributed.previousSamePeriod > 0
                ? `${formatINR(teamUnattributed.current)} of this month's collections came from a paid-file upload with no collector, so it counts in the team total above but in no agent's row below (${formatINR(teamUnattributed.previousSamePeriod)} over the same days last month).`
                : "Team totals include bank-reported paid-file collections; the per-agent table below only counts money credited to a person."
            }
            breakdowns={[
              {
                title: "Agent",
                description: `Every agent in ${activeTeam.name}, this month against the same days last month`,
                icon: User,
                exportName: `team-${activeTeam.name.toLowerCase().replace(/\s+/g, "-")}-agents`,
                groups: agentTrendGroups,
              },
            ]}
          />
        </TabsContent>

        {/* ── AGENTS TAB ── */}
        {/* ── OVERVIEW TAB ── */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ReportSection
              title="Team Leaderboard"
              description={`Ranked by ${LEADER_METRIC_CAPTION[effectiveLeaderMetric]} across ${activeTeam.name}`}
              icon={Trophy}
              action={
                <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
                  {(["collected", "ptpAmount", "calls"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setLeaderMetric(m)}
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                        effectiveLeaderMetric === m
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m === "collected" ? "Collected" : m === "ptpAmount" ? "PTP" : "Calls"}
                    </button>
                  ))}
                </div>
              }
            >
              <Leaderboard entries={leaderboardEntries} metric={effectiveLeaderMetric} limit={10} />
            </ReportSection>

            <ReportSection
              title="Outcome Mix"
              description="How your team's calls resolved"
              icon={BarChart2}
            >
              {rangedDisps.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No calls logged {isRangeActive(dateRange) ? "in this range" : "yet"}.
                </p>
              ) : (
                <OutcomeBreakdown disps={rangedDisps} />
              )}
            </ReportSection>
          </div>
        </TabsContent>

        <TabsContent value="agents" className="mt-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search agent…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  `${activeTeam.name}-agent-performance.csv`,
                  [
                    "Agent",
                    "Assigned Accounts",
                    "Calls Logged",
                    "PTPs",
                    "PTP Amount (₹)",
                    "Paid (₹)",
                    "Contact Rate %",
                  ],
                  agentStats.map((a) => [
                    a.name,
                    a.assignedCount,
                    a.stats.total,
                    a.stats.ptps,
                    a.stats.ptpAmount,
                    a.stats.paidAmount,
                    a.stats.contactRate,
                  ]),
                )
              }
              className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <FileDown className="h-3.5 w-3.5" />
              Export All
            </button>
          </div>

          <div className="rounded-lg border border-border overflow-hidden bg-card">
            <div className="overflow-auto max-h-[640px]">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-muted/60 backdrop-blur text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">
                      Agent
                    </th>
                    <th className="border-b border-r border-border px-3 py-2 text-right font-semibold">
                      Assigned
                    </th>
                    <th className="border-b border-r border-border px-3 py-2 text-right font-semibold">
                      Calls
                    </th>
                    <th className="border-b border-r border-border px-3 py-2 text-right font-semibold">
                      PTPs
                    </th>
                    <th className="border-b border-r border-border px-3 py-2 text-right font-semibold">
                      PTP Value
                    </th>
                    <th className="border-b border-r border-border px-3 py-2 text-right font-semibold">
                      Collected
                    </th>
                    <th className="border-b border-r border-border px-3 py-2 text-right font-semibold">
                      Contact%
                    </th>
                    <th className="border-b border-border px-3 py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-xs text-muted-foreground">
                        No agents match
                      </td>
                    </tr>
                  )}
                  {filtered.map((a, i) => {
                    const open = expandedAgent === a.agentId;
                    return (
                      <Fragment key={a.agentId}>
                        <tr
                          className={cn(
                            "cursor-pointer transition-colors hover:bg-primary/5",
                            i % 2 === 1 && "bg-muted/20",
                            open && "bg-primary/10",
                          )}
                          onClick={() => setExpandedAgent(open ? null : a.agentId)}
                        >
                          <td className="border-b border-r border-border/60 px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold text-muted-foreground shrink-0">
                                {a.name
                                  .split(" ")
                                  .map((n) => n[0])
                                  .join("")
                                  .slice(0, 2)}
                              </div>
                              <span className="font-medium text-foreground">{a.name}</span>
                            </div>
                          </td>
                          <td className="border-b border-r border-border/60 px-3 py-1.5 text-right tabular-nums">
                            {a.assignedCount}
                          </td>
                          <td className="border-b border-r border-border/60 px-3 py-1.5 text-right tabular-nums">
                            {a.stats.total}
                          </td>
                          <td className="border-b border-r border-border/60 px-3 py-1.5 text-right tabular-nums text-blue-500 font-medium">
                            {a.stats.ptps}
                          </td>
                          <td className="border-b border-r border-border/60 px-3 py-1.5 text-right tabular-nums text-success">
                            {a.stats.ptpAmount > 0 ? formatINR(a.stats.ptpAmount) : "—"}
                          </td>
                          <td className="border-b border-r border-border/60 px-3 py-1.5 text-right tabular-nums font-medium">
                            {a.stats.paidAmount > 0 ? formatINR(a.stats.paidAmount) : "—"}
                          </td>
                          <td className="border-b border-r border-border/60 px-3 py-1.5 text-right tabular-nums">
                            {a.stats.total > 0 ? `${a.stats.contactRate}%` : "—"}
                          </td>
                          <td className="border-b border-border/60 px-3 py-1.5 text-center">
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 text-muted-foreground transition-transform",
                                open && "rotate-90",
                              )}
                            />
                          </td>
                        </tr>
                        {open && (
                          <tr>
                            <td
                              colSpan={8}
                              className="border-b border-border bg-muted/10 px-4 py-3"
                            >
                              {/* Full per-agent report. The call log below it is kept — it
                                  answers "what did they actually do", which the summary above
                                  deliberately does not. */}
                              <div className="space-y-4">
                                <AgentReportDetail
                                  agentId={a.agentId}
                                  agentName={a.name}
                                  disps={a.disps}
                                  payments={allPayments.filter((p) => p.agentId === a.agentId)}
                                  posByDebtor={posByDebtor}
                                />
                                <div className="border-t border-border pt-3">
                                  <AgentCallLog disps={a.disps} agentName={a.name} />
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot className="sticky bottom-0">
                  <tr className="bg-muted/70 backdrop-blur font-semibold">
                    <td className="border-t-2 border-r border-border px-3 py-2">
                      Total · {filtered.length} agents
                    </td>
                    <td className="border-t-2 border-r border-border px-3 py-2 text-right tabular-nums">
                      {filtered.reduce((s, a) => s + a.assignedCount, 0).toLocaleString()}
                    </td>
                    <td className="border-t-2 border-r border-border px-3 py-2 text-right tabular-nums">
                      {filtered.reduce((s, a) => s + a.stats.total, 0).toLocaleString()}
                    </td>
                    <td className="border-t-2 border-r border-border px-3 py-2 text-right tabular-nums text-blue-500">
                      {filtered.reduce((s, a) => s + a.stats.ptps, 0).toLocaleString()}
                    </td>
                    <td className="border-t-2 border-r border-border px-3 py-2 text-right tabular-nums text-success">
                      {formatINR(filtered.reduce((s, a) => s + a.stats.ptpAmount, 0))}
                    </td>
                    <td className="border-t-2 border-r border-border px-3 py-2 text-right tabular-nums">
                      {formatINR(filtered.reduce((s, a) => s + a.stats.paidAmount, 0))}
                    </td>
                    <td className="border-t-2 border-r border-border px-3 py-2" colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* ── OUTCOMES TAB ── */}
        <TabsContent value="outcomes" className="mt-4">
          <ReportSection
            title={`Outcome Distribution — ${activeTeam.name}`}
            description="Share of calls by disposition"
            icon={BarChart2}
          >
            {rangedDisps.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No calls logged {isRangeActive(dateRange) ? "in this range" : "yet"}.
              </p>
            ) : (
              <OutcomeBreakdown disps={rangedDisps} />
            )}
          </ReportSection>
        </TabsContent>

        {/* ── DIAL MODE TAB ── */}
        <TabsContent value="dialmode" className="mt-4">
          <ReportSection
            title={`Dial Mode Effectiveness — ${activeTeam.name}`}
            description="How Productive Dial (multi-line) and Progressive Dial (one at a time) compare, plus single/manual calls"
            icon={PhoneCall}
            action={
              dialModeStats.length > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    downloadCsv(
                      `${activeTeam.name}-dial-mode.csv`,
                      [
                        "Dial Mode",
                        "Calls",
                        "Contact Rate %",
                        "PTPs",
                        "PTP Rate %",
                        "PTP Value (₹)",
                        "Paid",
                        "Paid Rate %",
                        "Collected (₹)",
                      ],
                      dialModeStats.map((r) => [
                        r.label,
                        r.total,
                        r.contactRate,
                        r.ptps,
                        r.total ? Math.round((r.ptps / r.total) * 100) : 0,
                        r.ptpAmount,
                        r.paid,
                        r.total ? Math.round((r.paid / r.total) * 100) : 0,
                        r.paidAmount,
                      ]),
                    )
                  }
                  className="inline-flex items-center gap-1.5 h-7 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  Export
                </button>
              ) : undefined
            }
          >
            {dialModeStats.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No calls logged {isRangeActive(dateRange) ? "in this range" : "yet"}.
              </p>
            ) : (
              <DataTable
                rows={dialModeStats}
                keyOf={(r) => r.mode}
                columns={[
                  {
                    key: "mode",
                    header: "Dial Mode",
                    render: (r) => <span className="font-medium text-foreground">{r.label}</span>,
                  },
                  {
                    key: "calls",
                    header: "Calls",
                    numeric: true,
                    render: (r) => r.total.toLocaleString(),
                  },
                  {
                    key: "contact",
                    header: "Contact Rate",
                    numeric: true,
                    render: (r) => `${r.contactRate}%`,
                  },
                  {
                    key: "ptps",
                    header: "PTPs",
                    numeric: true,
                    render: (r) => (
                      <span className="text-blue-500 font-medium">
                        {r.ptps}{" "}
                        <span className="text-muted-foreground font-normal">
                          ({r.total ? Math.round((r.ptps / r.total) * 100) : 0}%)
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: "ptpValue",
                    header: "PTP Value",
                    numeric: true,
                    render: (r) =>
                      r.ptpAmount > 0 ? (
                        <span className="text-success font-medium">{formatINR(r.ptpAmount)}</span>
                      ) : (
                        "—"
                      ),
                  },
                  {
                    key: "paid",
                    header: "Paid",
                    numeric: true,
                    render: (r) => (
                      <span className="font-medium">
                        {r.paid}{" "}
                        <span className="text-muted-foreground font-normal">
                          ({r.total ? Math.round((r.paid / r.total) * 100) : 0}%)
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: "collected",
                    header: "Collected",
                    numeric: true,
                    render: (r) =>
                      r.paidAmount > 0 ? (
                        <span className="font-semibold">{formatINR(r.paidAmount)}</span>
                      ) : (
                        "—"
                      ),
                  },
                ]}
              />
            )}
          </ReportSection>
        </TabsContent>

        {/* ── PTP FOLLOW-UPS TAB ── */}
        <TabsContent value="followups" className="mt-4">
          <ReportSection
            title={`Open Promises — ${activeTeam.name}`}
            description="Every unfulfilled promise-to-pay, most urgent first"
            icon={HandCoins}
            action={
              followups.length > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    downloadCsv(
                      `${activeTeam.name}-ptp-followups.csv`,
                      ["Debtor", "Phone", "PTP Amount (₹)", "Due Date", "Days Left", "Notes"],
                      followups.map((f) => [
                        f.debtorName,
                        f.phone,
                        f.ptpAmount,
                        f.ptpDateIso,
                        f.daysLeft,
                        f.notes,
                      ]),
                    )
                  }
                  className="inline-flex items-center gap-1.5 h-7 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  Export
                </button>
              ) : undefined
            }
          >
            <DataTable
              rows={followups}
              keyOf={(f) => f.id}
              empty="No open promises-to-pay across this team right now."
              maxHeight="max-h-[600px]"
              columns={[
                {
                  key: "debtor",
                  header: "Debtor",
                  render: (f) => (
                    <span className="font-medium text-foreground">{f.debtorName}</span>
                  ),
                },
                {
                  key: "phone",
                  header: "Phone",
                  render: (f) => <span className="font-mono text-muted-foreground">{f.phone}</span>,
                },
                {
                  key: "amount",
                  header: "Amount",
                  numeric: true,
                  render: (f) => (
                    <span className="font-medium text-success">{formatINR(f.ptpAmount)}</span>
                  ),
                },
                {
                  key: "due",
                  header: "Due",
                  render: (f) => <span className="text-muted-foreground">{f.ptpDateIso}</span>,
                },
                {
                  key: "status",
                  header: "Status",
                  render: (f) =>
                    f.daysLeft < 0 ? (
                      <span className="inline-flex items-center gap-1 font-medium text-destructive">
                        <AlertTriangle className="h-3 w-3" />
                        {-f.daysLeft}d overdue
                      </span>
                    ) : f.daysLeft === 0 ? (
                      <span className="font-medium text-amber-500">Due today</span>
                    ) : (
                      <span className="text-muted-foreground">in {f.daysLeft}d</span>
                    ),
                },
              ]}
              footer={[
                `${followups.length} open`,
                "",
                formatINR(followups.reduce((s, f) => s + f.ptpAmount, 0)),
                "",
                overdueFollowups.length > 0 ? `${overdueFollowups.length} overdue` : "",
              ]}
            />
          </ReportSection>
        </TabsContent>

        {/* ── CALL LOG TAB ── */}
        <TabsContent value="detail" className="mt-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">{rangedDisps.length} calls total</span>
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  `${activeTeam.name}-call-log.csv`,
                  [
                    "Time",
                    "Debtor",
                    "Phone",
                    "Agent",
                    "Portfolio",
                    "Outcome",
                    "PTP Amount",
                    "PTP Date",
                    "Notes",
                  ],
                  rangedDisps.map((d) => [
                    new Date(d.time).toLocaleString("en-IN"),
                    d.debtorName,
                    d.phone,
                    d.agentName,
                    d.portfolioName ?? "—",
                    d.outcome,
                    d.ptpAmount ?? "",
                    d.ptpDate ?? "",
                    d.notes,
                  ]),
                )
              }
              className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <FileDown className="h-3.5 w-3.5" />
              Export Log
            </button>
          </div>

          <DataTable
            rows={rangedDisps}
            keyOf={(d) => d.id}
            empty={`No calls logged ${isRangeActive(dateRange) ? "in this range" : "yet"}.`}
            maxHeight="max-h-[640px]"
            columns={[
              {
                key: "time",
                header: "Time",
                render: (d) => (
                  <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                    {new Date(d.time).toLocaleString("en-IN", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                ),
              },
              {
                key: "debtor",
                header: "Debtor",
                render: (d) => (
                  <div>
                    <div className="font-medium text-foreground">{d.debtorName || "—"}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{d.phone}</div>
                  </div>
                ),
              },
              { key: "agent", header: "Agent", render: (d) => d.agentName || "—" },
              {
                key: "outcome",
                header: "Outcome",
                render: (d) => (
                  <>
                    <span className={cn("font-medium", OUTCOME_COLOR[d.outcome])}>
                      {OUTCOME_LABELS[d.outcome] ?? d.outcome}
                    </span>
                    {d.ptpDate && (
                      <div className="text-[10px] text-muted-foreground">PTP {d.ptpDate}</div>
                    )}
                  </>
                ),
              },
              {
                key: "ptpAmt",
                header: "PTP Amt",
                numeric: true,
                render: (d) =>
                  d.ptpAmount ? (
                    <span className="font-medium text-success">{formatINR(d.ptpAmount)}</span>
                  ) : (
                    "—"
                  ),
              },
              {
                key: "notes",
                header: "Notes",
                render: (d) => (
                  <span className="block max-w-[240px] truncate text-muted-foreground">
                    {d.notes || "—"}
                  </span>
                ),
              },
            ]}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
