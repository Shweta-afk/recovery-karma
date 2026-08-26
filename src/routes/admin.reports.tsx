import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo, Fragment } from "react";
import {
  BarChart2,
  Users,
  TrendingUp,
  PhoneCall,
  IndianRupee,
  FileDown,
  ChevronDown,
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertTriangle,
  HandCoins,
  Search,
  Target,
  ShieldAlert,
  Trophy,
  User,
  Building2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { getAgentById, useRoster, useTeams } from "@/lib/team-store";
import {
  getDispositions,
  refreshDispositions,
  calcStats,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { getPortfolios, refreshPortfolios } from "@/lib/portfolio-store";
import { formatINR } from "@/lib/mock-debtors";
import { MonthlyTrendPanel, type TrendGroup } from "@/components/reports/monthly-trend";
import { scopeToAgents, unattributedCollected } from "@/lib/monthly-trend";
import { getAgentTimeStats, formatDuration, formatClockTime } from "@/lib/agent-time-stats";
import {
  getPayments,
  refreshPayments,
  getSettlements,
  refreshSettlements,
  type PaymentRecord,
  type SettlementStatus,
} from "@/lib/payments-store";
import {
  getDisputes,
  refreshDisputes,
  type DisputeRecord,
  type DisputeStatus,
} from "@/lib/dispute-store";
import {
  getAgentAccountCounts,
  getPortfolioTotals,
  refreshReportMetrics,
  summariseTotals,
} from "@/lib/report-metrics-store";
import { downloadCsv } from "@/lib/csv-export";
import {
  OUTCOME_LABELS,
  OUTCOME_COLOR,
  OutcomeBreakdown,
} from "@/components/reports/outcome-breakdown";
import { Stat } from "@/components/reports/stat-card";
import { AgentCallLog } from "@/components/reports/agent-call-log";
import { ProfilexSpendPanel } from "@/components/profilex/spend-panel";
import { InsightsUsagePanel } from "@/components/profilex/usage-panel";
import { DataTable, ReportSection } from "@/components/reports/data-table";
import {
  Leaderboard,
  LEADER_METRIC_CAPTION,
  type LeaderboardMetric,
} from "@/components/reports/leaderboard";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({ meta: [{ title: "Reports · SamvadX Admin" }] }),
  component: AdminReportsPage,
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function isSameDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** Hour-of-day (0-23) in IST, regardless of the viewer's own timezone — RBI's Fair Practices
 * Code contact window (07:00-19:00) is an India-wide rule, not a local-to-the-admin one. */
function getISTHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value;
  return hour ? parseInt(hour, 10) : 0;
}

/**
 * Recovery rates in this dataset sit well under 1% (₹2,92,509 collected against ₹40,38,47,235
 * placed = 0.07%), and `Math.round(x * 100)` flattened every one of them to a bare "0%" — which
 * reads as "nothing was recorded" when money demonstrably was. Keep the ratio unrounded and only
 * round here, with enough precision that a non-zero collection never renders as zero.
 */
function formatPct(value: number): string {
  if (value === 0) return "0%";
  if (value < 0.01) return "<0.01%";
  if (value < 1) return `${value.toFixed(2)}%`;
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

function formatIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── page ─────────────────────────────────────────────────────────────────────

function AdminReportsPage() {
  const teams = useTeams();
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  const [search, setSearch] = useState("");
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  // null = "not chosen yet", so we can fall back to a metric that actually separates the
  // agents. Ranking by Collected when every agent is at zero produces a meaningless order.
  const [leaderMetric, setLeaderMetric] = useState<LeaderboardMetric | null>(null);
  useRoster(); // triggers a background refresh so agent names stay current

  useEffect(() => {
    const load = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", load);
    refreshDispositions();
    return () => {
      window.removeEventListener("dispositions-updated", load);
    };
  }, []);

  const portfolios = useMemo(() => getPortfolios(), []);
  const teamName = (teamId?: string) => teams.find((t) => t.id === teamId)?.name ?? "—";

  useEffect(() => {
    refreshPortfolios();
  }, []);

  const [payments, setPayments] = useState<PaymentRecord[]>(() => getPayments());
  useEffect(() => {
    const load = () => setPayments(getPayments());
    load();
    window.addEventListener("payments-updated", load);
    refreshPayments();
    return () => window.removeEventListener("payments-updated", load);
  }, []);

  const [settlements, setSettlements] = useState(() => getSettlements());
  useEffect(() => {
    const load = () => setSettlements(getSettlements());
    load();
    window.addEventListener("settlements-updated", load);
    refreshSettlements();
    return () => window.removeEventListener("settlements-updated", load);
  }, []);

  const [disputes, setDisputes] = useState<DisputeRecord[]>(() => getDisputes());
  useEffect(() => {
    const load = () => setDisputes(getDisputes());
    load();
    window.addEventListener("disputes-updated", load);
    refreshDisputes();
    return () => window.removeEventListener("disputes-updated", load);
  }, []);

  // Account counts come from SQL aggregates, NOT from counting cached debtor rows: the
  // portfolio cache exceeds localStorage's quota at this dataset's size and silently serves a
  // partial snapshot, which made every count here wrong. See report-metrics-store.ts.
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

  // Global stats
  const globalStats = useMemo(() => calcStats(disps), [disps]);

  // "Active" = the dialer's definition (buildAssignedQueue): open portfolio, not already
  // settled. Computed in Postgres so it is correct regardless of what the localStorage
  // portfolio cache managed to hold.
  const totals = useMemo(() => summariseTotals(portfolioTotals), [portfolioTotals]);
  const activeAccounts = totals.activeAccounts;
  const allTimeAccounts = totals.allTimeAccounts;
  const activeCountByAgent = useMemo(
    () => new Map(agentCounts.map((a) => [a.agentEmail, a.activeAssigned])),
    [agentCounts],
  );
  const assignedByPortfolio = useMemo(
    () => new Map(portfolioTotals.map((p) => [p.portfolioId, p.assignedRows])),
    [portfolioTotals],
  );

  // Per-team stats
  const teamStats = useMemo(() => {
    const now = new Date();
    return teams.map((team) => {
      const teamDisps = disps.filter((d) => d.teamId === team.id);
      const teamPortfolios = portfolios.filter((p) => p.teamId === team.id);
      // Summed from the per-agent SQL aggregate rather than the cached rows, so it agrees
      // with the KPI strip and survives the portfolio cache being truncated.
      const assignedCount = team.agentIds.reduce(
        (s, aid) => s + (activeCountByAgent.get(aid) ?? 0),
        0,
      );
      // Today's time breakdown per agent — see agent-time-stats.ts for what's real (calling)
      // vs. estimated (idle/disposition/login-logout) pending a real presence-log table.
      const todayTimeStats = team.agentIds.map((aid) => {
        const todayDisps = teamDisps.filter((d) => d.agentId === aid && isSameDay(d.time, now));
        return getAgentTimeStats(aid, todayDisps);
      });
      const avgIdlePct =
        todayTimeStats.length > 0
          ? Math.round(
              (todayTimeStats.reduce(
                (s, t) => s + (t.loggedInSeconds > 0 ? t.idleSeconds / t.loggedInSeconds : 0),
                0,
              ) /
                todayTimeStats.length) *
                100,
            )
          : 0;
      return {
        team,
        stats: calcStats(teamDisps),
        assignedCount,
        disps: teamDisps,
        portfolios: teamPortfolios,
        avgIdlePct,
      };
    });
  }, [teams, disps, portfolios, activeCountByAgent]);

  // All agents across all teams with stats
  const agentStats = useMemo(() => {
    const allAgentIds = Array.from(new Set(teams.flatMap((t) => t.agentIds)));
    return allAgentIds
      .map((agentId) => {
        const agentDisps = disps.filter((d) => d.agentId === agentId);
        const ref = getAgentById(agentId);
        const team = teams.find((t) => t.agentIds.includes(agentId));
        // Straight from the SQL aggregate — see report-metrics-store.ts.
        const assignedCount = activeCountByAgent.get(agentId) ?? 0;
        return {
          agentId,
          name: ref?.name ?? agentId,
          teamName: team?.name ?? "—",
          stats: calcStats(agentDisps),
          assignedCount,
          disps: agentDisps,
        };
      })
      .sort((a, b) => b.stats.total - a.stats.total);
  }, [teams, disps, activeCountByAgent]);

  // ── month-over-month groupings ──────────────────────────────────────────────
  // Company-wide totals use every payment, including bank-reported paid-file rows that no
  // person collected. The team and agent breakdowns can't: a bank-reported row credits nobody,
  // so it is attributed to a team only through the portfolio it belongs to, and to no agent at
  // all. `companyUnattributed` names the resulting gap rather than leaving the tables looking
  // like they lost money.
  const teamTrendGroups = useMemo<TrendGroup[]>(
    () =>
      teams.map((team) => {
        const roster = new Set(team.agentIds);
        const teamPortfolioIds = new Set(
          portfolios.filter((p) => p.teamId === team.id).map((p) => p.id),
        );
        return {
          id: team.id,
          name: team.name,
          sub: `${team.agentIds.length} agent${team.agentIds.length === 1 ? "" : "s"}`,
          disps: disps.filter((d) => d.teamId === team.id),
          payments: payments.filter((p) =>
            p.agentId === null
              ? p.portfolioId !== undefined && teamPortfolioIds.has(p.portfolioId)
              : roster.has(p.agentId),
          ),
        };
      }),
    [teams, disps, payments, portfolios],
  );

  const agentTrendGroups = useMemo<TrendGroup[]>(() => {
    const seen = new Map<string, { name: string; teamName: string }>();
    for (const team of teams) {
      for (const aid of team.agentIds) {
        if (!seen.has(aid)) {
          seen.set(aid, { name: getAgentById(aid)?.name ?? aid, teamName: team.name });
        }
      }
    }
    return Array.from(seen.entries()).map(([aid, meta]) => ({
      id: aid,
      name: meta.name,
      sub: meta.teamName,
      ...scopeToAgents(disps, payments, [aid]),
    }));
  }, [teams, disps, payments]);

  const companyUnattributed = useMemo(() => unattributedCollected(payments), [payments]);

  const filtered = search.trim()
    ? agentStats.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.teamName.toLowerCase().includes(search.toLowerCase()),
      )
    : agentStats;

  const hasData = disps.length > 0;

  // Recovery rate per portfolio — $ collected (completed payments) ÷ $ placed (sum of
  // loanAmount across the portfolio's rows). No cost-to-collect here: there's no cost/expense
  // data anywhere in the schema (no telephony spend, no agent-cost tracking) to divide by.
  // `placed` comes from the SQL aggregate (sum of loan_amount per portfolio); `collected` is
  // summed from the payments cache, which is small enough to be reliable.
  const recoveryByPortfolio = useMemo(() => {
    return portfolioTotals
      .map((p) => {
        const collected = payments
          .filter((pay) => pay.portfolioId === p.portfolioId && pay.status === "completed")
          .reduce((s, pay) => s + pay.amount, 0);
        return {
          id: p.portfolioId,
          name: p.portfolioName,
          placed: p.placedAmount,
          collected,
          // Unrounded — formatPct decides the precision at render time.
          rate: p.placedAmount > 0 ? (collected / p.placedAmount) * 100 : 0,
        };
      })
      .filter((p) => p.placed > 0)
      .sort((a, b) => b.placed - a.placed);
  }, [portfolioTotals, payments]);

  const totalPlaced = useMemo(
    () => recoveryByPortfolio.reduce((s, p) => s + p.placed, 0),
    [recoveryByPortfolio],
  );
  const totalCollectedAllTime = useMemo(
    () => payments.filter((p) => p.status === "completed").reduce((s, p) => s + p.amount, 0),
    [payments],
  );
  const overallRecoveryRate = totalPlaced > 0 ? (totalCollectedAllTime / totalPlaced) * 100 : 0;

  // PTP-kept: of the promises an agent secured, how many were followed by a completed
  // payment from that same debtor afterward. Approximate by design — it confirms *a* payment
  // landed after the promise, not that the amount matches exactly, since promise_amount and
  // payment.amount are never reconciled against each other anywhere in the schema.
  const ptpKept = useMemo(() => {
    const ptps = disps.filter((d) => d.outcome === "promised" && d.ptpAmount);
    let kept = 0;
    for (const p of ptps) {
      const paidAfter = payments.some(
        (pay) =>
          pay.debtorId === p.debtorId &&
          pay.status === "completed" &&
          new Date(pay.receivedAt ?? pay.createdAt).getTime() >= new Date(p.time).getTime(),
      );
      if (paidAfter) kept++;
    }
    return {
      total: ptps.length,
      kept,
      rate: ptps.length > 0 ? Math.round((kept / ptps.length) * 100) : 0,
    };
  }, [disps, payments]);

  const disputeCounts = useMemo(() => {
    const counts: Record<DisputeStatus, number> = {
      open: 0,
      under_review: 0,
      resolved: 0,
      escalated_legal: 0,
    };
    for (const d of disputes) counts[d.status]++;
    return counts;
  }, [disputes]);

  // RBI Fair Practices Code: contact only permitted 07:00-19:00 IST. Flags every logged call
  // outside that window, regardless of who/what handled it (human, AI, or IVR) — the rule is
  // about when the debtor was contacted, not who placed the call.
  const complianceViolations = useMemo(
    () =>
      disps
        .filter((d) => {
          const hour = getISTHour(d.time);
          return hour < 7 || hour >= 19;
        })
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
    [disps],
  );
  const complianceAgentCount = useMemo(
    () => new Set(complianceViolations.map((d) => d.agentId).filter(Boolean)).size,
    [complianceViolations],
  );
  const complianceRate =
    disps.length > 0 ? Math.round((complianceViolations.length / disps.length) * 100) : 0;

  const leaderboardEntries = useMemo(
    () =>
      agentStats.map((a) => ({
        agentId: a.agentId,
        name: a.name,
        teamName: a.teamName,
        collected: a.stats.paidAmount,
        ptps: a.stats.ptps,
        ptpAmount: a.stats.ptpAmount,
        calls: a.stats.total,
        contactRate: a.stats.contactRate,
      })),
    [agentStats],
  );

  // Collections is the metric the business is judged on, so prefer it — but only once
  // someone has actually collected something. Until then fall back to calls, which does
  // separate the agents. Any explicit click wins over this.
  const effectiveLeaderMetric: LeaderboardMetric =
    leaderMetric ??
    (leaderboardEntries.some((e) => e.collected > 0)
      ? "collected"
      : leaderboardEntries.some((e) => e.ptpAmount > 0)
        ? "ptpAmount"
        : "calls");

  const settlementCounts = useMemo(() => {
    const counts: Record<SettlementStatus, number> = {
      pending_manager: 0,
      approved: 0,
      rejected: 0,
      sent_to_bank: 0,
    };
    let totalWaiver = 0;
    for (const s of settlements) {
      counts[s.status]++;
      if (s.status === "approved" || s.status === "sent_to_bank") {
        totalWaiver += s.originalAmount - s.proposedAmount;
      }
    }
    return { counts, totalWaiver };
  }, [settlements]);

  return (
    <div className="space-y-5">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Org-wide recovery reporting — every team, agent, outcome and rupee.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            {teams.length} team{teams.length !== 1 ? "s" : ""}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {totals.openPortfolios} active portfolio
            {totals.openPortfolios !== 1 ? "s" : ""}
          </Badge>
        </div>
      </div>

      {/* Global KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
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
          icon={Target}
          label="Recovery Rate"
          value={formatPct(overallRecoveryRate)}
          sub="collected ÷ placed"
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
          value={activeAccounts.toLocaleString()}
          sub={`${allTimeAccounts.toLocaleString()} incl. closed/paid`}
        />
        <Stat
          icon={ShieldAlert}
          label="Compliance Flags"
          value={complianceViolations.length.toLocaleString()}
          sub="outside 07:00–19:00 IST"
        />
      </div>

      {!hasData && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <BarChart2 className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-foreground">No call data yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Reports populate as agents log call outcomes in the queue.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="overview">
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="teams">By Team</TabsTrigger>
            <TabsTrigger value="agents">By Agent</TabsTrigger>
            <TabsTrigger value="trend">Monthly Trend</TabsTrigger>
            <TabsTrigger value="outcomes">Outcome Breakdown</TabsTrigger>
            <TabsTrigger value="recovery">Recovery</TabsTrigger>
            <TabsTrigger value="disputes">Disputes</TabsTrigger>
            <TabsTrigger value="settlements">Settlements</TabsTrigger>
            <TabsTrigger value="compliance">
              Compliance
              {complianceViolations.length > 0 && (
                <Badge variant="destructive" className="ml-1.5 text-[10px] py-0">
                  {complianceViolations.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="profilex">Insights</TabsTrigger>
            <TabsTrigger value="detail">Call Log</TabsTrigger>
          </TabsList>
        </div>

        {/* ── OVERVIEW TAB (leaderboard + at-a-glance boxes) ── */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ReportSection
              title="Agent Leaderboard"
              description={`Ranked by ${LEADER_METRIC_CAPTION[effectiveLeaderMetric]}, across every team`}
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
              <Leaderboard
                entries={leaderboardEntries}
                metric={effectiveLeaderMetric}
                showTeam
                limit={10}
              />
            </ReportSection>

            <div className="space-y-4">
              <ReportSection
                title="Team Standings"
                description="Collections and contact rate by team"
                icon={Users}
              >
                <DataTable
                  rows={[...teamStats].sort((a, b) => b.stats.paidAmount - a.stats.paidAmount)}
                  keyOf={(t) => t.team.id}
                  empty="No teams created yet."
                  columns={[
                    {
                      key: "team",
                      header: "Team",
                      render: (t) => (
                        <div>
                          <div className="font-medium text-foreground">{t.team.name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {t.team.agentIds.length} agents
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: "calls",
                      header: "Calls",
                      numeric: true,
                      render: (t) => t.stats.total.toLocaleString(),
                    },
                    {
                      key: "ptps",
                      header: "PTPs",
                      numeric: true,
                      render: (t) => <span className="text-blue-500">{t.stats.ptps}</span>,
                    },
                    {
                      key: "collected",
                      header: "Collected",
                      numeric: true,
                      render: (t) => (
                        <span className="text-success font-medium">
                          {formatINR(t.stats.paidAmount)}
                        </span>
                      ),
                    },
                    {
                      key: "contact",
                      header: "Contact",
                      numeric: true,
                      render: (t) => `${t.stats.contactRate}%`,
                    },
                  ]}
                  footer={[
                    "Total",
                    globalStats.total.toLocaleString(),
                    globalStats.ptps.toLocaleString(),
                    formatINR(globalStats.paidAmount),
                    `${globalStats.contactRate}%`,
                  ]}
                />
              </ReportSection>

              <ReportSection
                title="Outcome Mix"
                description="How every logged call resolved"
                icon={BarChart2}
              >
                {disps.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No calls logged yet.
                  </p>
                ) : (
                  <OutcomeBreakdown disps={disps} />
                )}
              </ReportSection>
            </div>
          </div>
        </TabsContent>

        {/* ── TEAMS TAB ── */}
        <TabsContent value="teams" className="mt-4 space-y-3">
          {teamStats.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No teams created yet. Go to Admin → Teams to create one.
            </p>
          )}
          {teamStats.map(
            ({ team, stats, assignedCount, disps: td, portfolios: tp, avgIdlePct }) => {
              const open = expandedTeam === team.id;
              return (
                <Card key={team.id} className="overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedTeam(open ? null : team.id)}
                    className="w-full flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                  >
                    <ChevronRight
                      className={cn(
                        "h-4 w-4 text-muted-foreground shrink-0 transition-transform",
                        open && "rotate-90",
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-foreground">{team.name}</span>
                        <span className="text-xs text-muted-foreground">
                          · {team.managerName} · {team.agentIds.length} agents
                        </span>
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                        <span>{assignedCount} accounts assigned</span>
                        <span>{stats.total} calls logged</span>
                        <span className="text-blue-500 font-medium">{stats.ptps} PTPs</span>
                        {stats.ptpAmount > 0 && (
                          <span className="text-success font-medium">
                            {formatINR(stats.ptpAmount)} PTP value
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 shrink-0 text-xs">
                      <div className="text-center hidden sm:block">
                        <div className="font-semibold text-foreground">{stats.contactRate}%</div>
                        <div className="text-muted-foreground">Contact</div>
                      </div>
                      {stats.total > 0 && (
                        <div className="text-center hidden sm:block">
                          <div className="font-semibold text-success">
                            {formatINR(stats.paidAmount)}
                          </div>
                          <div className="text-muted-foreground">Collected</div>
                        </div>
                      )}
                      <div
                        className="text-center hidden md:block"
                        title="Estimated — real presence tracking is coming soon"
                      >
                        <div
                          className={cn(
                            "font-semibold",
                            avgIdlePct > 40
                              ? "text-destructive"
                              : avgIdlePct > 20
                                ? "text-warning-foreground"
                                : "text-foreground",
                          )}
                        >
                          {avgIdlePct}%
                        </div>
                        <div className="text-muted-foreground">Avg Idle*</div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadCsv(
                            `${team.name}-report.csv`,
                            ["Agent", "Calls", "PTPs", "PTP Amount", "Paid", "Contact Rate%"],
                            team.agentIds.map((aid) => {
                              const ad = td.filter((d) => d.agentId === aid);
                              const as_ = calcStats(ad);
                              const ref = getAgentById(aid);
                              return [
                                ref?.name ?? aid,
                                as_.total,
                                as_.ptps,
                                as_.ptpAmount,
                                as_.paidAmount,
                                as_.contactRate,
                              ];
                            }),
                          );
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                      >
                        <FileDown className="h-3 w-3" />
                      </button>
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-border px-4 py-3 space-y-2">
                      {/* Per-agent rows within team */}
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                        Agent Performance
                      </div>
                      <div className="rounded-md border border-border overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-muted/20 border-b border-border">
                              <th className="py-2 px-3 text-left font-medium text-muted-foreground">
                                Agent
                              </th>
                              <th className="py-2 px-3 text-center font-medium text-muted-foreground">
                                Calls
                              </th>
                              <th className="py-2 px-3 text-center font-medium text-muted-foreground">
                                PTPs
                              </th>
                              <th className="py-2 px-3 text-right font-medium text-muted-foreground">
                                PTP Value
                              </th>
                              <th className="py-2 px-3 text-right font-medium text-muted-foreground">
                                Collected
                              </th>
                              <th className="py-2 px-3 text-center font-medium text-muted-foreground">
                                Contact%
                              </th>
                              <th className="py-2 px-3 text-left font-medium text-muted-foreground">
                                Shift (today)*
                              </th>
                              <th className="py-2 px-3 text-right font-medium text-muted-foreground">
                                Ringing*
                              </th>
                              <th className="py-2 px-3 text-right font-medium text-muted-foreground">
                                Calling*
                              </th>
                              <th className="py-2 px-3 text-right font-medium text-muted-foreground">
                                Idle*
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {team.agentIds.map((aid) => {
                              const ad = td.filter((d) => d.agentId === aid);
                              const as_ = calcStats(ad);
                              const ref = getAgentById(aid);
                              const todayAd = ad.filter((d) => isSameDay(d.time, new Date()));
                              const ts = getAgentTimeStats(aid, todayAd);
                              return (
                                <tr key={aid} className="hover:bg-muted/20">
                                  <td className="py-2 px-3 font-medium text-foreground">
                                    {ref?.name ?? aid}
                                  </td>
                                  <td className="py-2 px-3 text-center">{as_.total}</td>
                                  <td className="py-2 px-3 text-center text-blue-500 font-medium">
                                    {as_.ptps}
                                  </td>
                                  <td className="py-2 px-3 text-right text-success">
                                    {as_.ptpAmount > 0 ? formatINR(as_.ptpAmount) : "—"}
                                  </td>
                                  <td className="py-2 px-3 text-right">
                                    {as_.paidAmount > 0 ? formatINR(as_.paidAmount) : "—"}
                                  </td>
                                  <td className="py-2 px-3 text-center">
                                    {as_.total > 0 ? (
                                      <div className="flex items-center gap-1.5">
                                        <Progress
                                          value={as_.contactRate}
                                          className="h-1.5 flex-1"
                                        />
                                        <span className="w-8 text-right">{as_.contactRate}%</span>
                                      </div>
                                    ) : (
                                      "—"
                                    )}
                                  </td>
                                  <td className="py-2 px-3 text-left text-muted-foreground whitespace-nowrap">
                                    {formatClockTime(ts.loginTime)} –{" "}
                                    {ts.logoutTime ? formatClockTime(ts.logoutTime) : "now"}
                                  </td>
                                  <td className="py-2 px-3 text-right text-blue-500 tabular-nums">
                                    {formatDuration(ts.ringingSeconds)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-foreground font-medium tabular-nums">
                                    {formatDuration(ts.callingSeconds)}
                                  </td>
                                  <td className="py-2 px-3 text-right text-muted-foreground tabular-nums">
                                    {formatDuration(ts.idleSeconds)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        * Shift/Calling/Idle are today's figures — Idle, Shift start/end are
                        estimated pending real presence tracking; Calling time is real.
                      </p>

                      {/* Portfolios for team */}
                      {tp.length > 0 && (
                        <div className="pt-2">
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                            Assigned Portfolios
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {tp.map((p) => (
                              <Badge
                                key={p.id}
                                variant="outline"
                                className="text-[10px] font-normal"
                              >
                                {p.name} · {assignedByPortfolio.get(p.id) ?? 0} accounts
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            },
          )}
        </TabsContent>

        {/* ── AGENTS TAB ── */}
        <TabsContent value="agents" className="mt-4 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search agent or team…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  "agent-performance.csv",
                  [
                    "Agent",
                    "Team",
                    "Assigned Accounts",
                    "Calls Logged",
                    "PTPs",
                    "PTP Amount (₹)",
                    "Paid (₹)",
                    "Contact Rate %",
                  ],
                  agentStats.map((a) => [
                    a.name,
                    a.teamName,
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
                    <th className="border-b border-r border-border px-3 py-2 text-left font-semibold">
                      Team
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
                      <td colSpan={9} className="py-8 text-center text-xs text-muted-foreground">
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
                          <td className="border-b border-r border-border/60 px-3 py-1.5 text-muted-foreground">
                            {a.teamName}
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
                              colSpan={9}
                              className="border-b border-border bg-muted/10 px-4 py-3"
                            >
                              <AgentCallLog disps={a.disps} agentName={a.name} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot className="sticky bottom-0">
                  <tr className="bg-muted/70 backdrop-blur font-semibold">
                    <td className="border-t-2 border-r border-border px-3 py-2">Total</td>
                    <td className="border-t-2 border-r border-border px-3 py-2 text-muted-foreground">
                      {filtered.length} agents
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
          <Card>
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold">
                Outcome Distribution — All Teams
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {disps.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No calls logged yet.
                </p>
              ) : (
                <OutcomeBreakdown disps={disps} />
              )}
            </CardContent>
          </Card>

          {teamStats.map(
            ({ team, disps: td }) =>
              td.length > 0 && (
                <Card key={team.id} className="mt-4">
                  <CardHeader className="border-b border-border pb-3">
                    <CardTitle className="text-sm font-semibold">
                      {team.name} — Outcome Breakdown
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <OutcomeBreakdown disps={td} />
                  </CardContent>
                </Card>
              ),
          )}
        </TabsContent>

        {/* ── MONTHLY TREND TAB ── */}
        <TabsContent value="trend" className="mt-4">
          <MonthlyTrendPanel
            disps={disps}
            payments={payments}
            note={
              companyUnattributed.current > 0 || companyUnattributed.previousSamePeriod > 0
                ? `Company totals include ${formatINR(companyUnattributed.current)} this month from paid-file uploads that credit no collector (${formatINR(companyUnattributed.previousSamePeriod)} over the same days last month). That money is attributed to a team through its portfolio, and to no agent — so the agent table below will always sum lower than the company figure.`
                : "Company totals include bank-reported paid-file collections. Those credit no agent, so the per-agent table can sum lower than the company figure."
            }
            breakdowns={[
              {
                title: "Team",
                description: "Every team's month against the same days last month",
                icon: Building2,
                exportName: "company-teams",
                groups: teamTrendGroups,
              },
              {
                title: "Agent",
                description: "Every agent in the company, ranked on the selected metric",
                icon: User,
                exportName: "company-agents",
                groups: agentTrendGroups,
              },
            ]}
          />
        </TabsContent>

        {/* ── RECOVERY TAB ── */}
        <TabsContent value="recovery" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              icon={IndianRupee}
              label="Total Placed"
              value={formatINR(totalPlaced)}
              sub={`${recoveryByPortfolio.length} portfolios`}
            />
            <Stat
              icon={CheckCircle2}
              label="Total Collected"
              value={formatINR(totalCollectedAllTime)}
              sub="all completed payments"
              green
            />
            <Stat
              icon={TrendingUp}
              label="Recovery Rate"
              value={formatPct(overallRecoveryRate)}
              sub="collected ÷ placed"
              green={overallRecoveryRate > 0}
            />
            <Stat
              icon={Target}
              label="PTP-Kept Rate"
              value={`${ptpKept.rate}%`}
              sub={`${ptpKept.kept} of ${ptpKept.total} promises paid`}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            PTP-kept is approximate: it checks whether any completed payment from that debtor landed
            after the promise, not whether the amount matches — promised and paid amounts aren't
            reconciled against each other anywhere in the data.
          </p>

          <ReportSection
            title="Recovery Rate by Portfolio"
            description="Amount collected against amount placed, per portfolio"
            icon={TrendingUp}
            action={
              recoveryByPortfolio.length > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    downloadCsv(
                      "recovery-by-portfolio.csv",
                      ["Portfolio", "Placed (₹)", "Collected (₹)", "Recovery Rate %"],
                      recoveryByPortfolio.map((p) => [
                        p.name,
                        p.placed,
                        p.collected,
                        p.rate.toFixed(2),
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
              rows={recoveryByPortfolio}
              keyOf={(p) => p.id}
              empty="No portfolios with accounts yet."
              columns={[
                {
                  key: "name",
                  header: "Portfolio",
                  render: (p) => <span className="font-medium text-foreground">{p.name}</span>,
                },
                {
                  key: "placed",
                  header: "Placed",
                  numeric: true,
                  render: (p) => formatINR(p.placed),
                },
                {
                  key: "collected",
                  header: "Collected",
                  numeric: true,
                  render: (p) => <span className="text-success">{formatINR(p.collected)}</span>,
                },
                {
                  key: "rate",
                  header: "Recovery Rate",
                  width: "w-48",
                  render: (p) => (
                    <div className="flex items-center gap-1.5">
                      <Progress value={p.rate} className="h-1.5 flex-1" />
                      <span className="w-14 text-right tabular-nums">{formatPct(p.rate)}</span>
                    </div>
                  ),
                },
              ]}
              footer={[
                "Total",
                formatINR(totalPlaced),
                formatINR(totalCollectedAllTime),
                formatPct(overallRecoveryRate),
              ]}
            />
          </ReportSection>
        </TabsContent>

        {/* ── DISPUTES TAB ── */}
        <TabsContent value="disputes" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat icon={AlertTriangle} label="Open" value={disputeCounts.open.toLocaleString()} />
            <Stat
              icon={Clock}
              label="Under Review"
              value={disputeCounts.under_review.toLocaleString()}
            />
            <Stat
              icon={CheckCircle2}
              label="Resolved"
              value={disputeCounts.resolved.toLocaleString()}
              green
            />
            <Stat
              icon={ShieldAlert}
              label="Escalated to Legal"
              value={disputeCounts.escalated_legal.toLocaleString()}
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{disputes.length} disputes total</span>
            {disputes.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  downloadCsv(
                    "disputes.csv",
                    [
                      "Debtor",
                      "Loan ID",
                      "Portfolio",
                      "Type",
                      "Status",
                      "Raised By",
                      "Notes",
                      "Created",
                    ],
                    disputes.map((d) => [
                      d.debtorName,
                      d.loanId,
                      d.portfolioName ?? "—",
                      d.disputeType ?? "—",
                      d.status,
                      d.raisedByName,
                      d.agentNotes || d.debtorReason,
                      new Date(d.createdAt).toLocaleString("en-IN"),
                    ]),
                  )
                }
                className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <FileDown className="h-3.5 w-3.5" />
                Export
              </button>
            )}
          </div>

          <DataTable
            rows={disputes}
            keyOf={(d) => d.id}
            empty="No disputes logged."
            maxHeight="max-h-[600px]"
            columns={[
              {
                key: "debtor",
                header: "Debtor",
                render: (d) => (
                  <div>
                    <div className="font-medium text-foreground">{d.debtorName}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {d.portfolioName ?? "—"}
                    </div>
                  </div>
                ),
              },
              {
                key: "type",
                header: "Type",
                render: (d) => (
                  <span className="capitalize text-muted-foreground">
                    {d.disputeType?.replace(/_/g, " ") ?? "—"}
                  </span>
                ),
              },
              {
                key: "status",
                header: "Status",
                render: (d) => (
                  <Badge
                    variant={d.status === "resolved" ? "secondary" : "outline"}
                    className="text-[10px] font-normal capitalize"
                  >
                    {d.status.replace(/_/g, " ")}
                  </Badge>
                ),
              },
              { key: "raisedBy", header: "Raised By", render: (d) => d.raisedByName },
              {
                key: "notes",
                header: "Notes",
                render: (d) => (
                  <span className="block max-w-[280px] truncate text-muted-foreground">
                    {d.agentNotes || d.debtorReason || "—"}
                  </span>
                ),
              },
              {
                key: "created",
                header: "Created",
                numeric: true,
                render: (d) => (
                  <span className="whitespace-nowrap text-muted-foreground">
                    {new Date(d.createdAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                ),
              },
            ]}
          />
        </TabsContent>

        {/* ── SETTLEMENTS TAB ── */}
        <TabsContent value="settlements" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              icon={Clock}
              label="Pending Manager"
              value={settlementCounts.counts.pending_manager.toLocaleString()}
            />
            <Stat
              icon={CheckCircle2}
              label="Approved"
              value={settlementCounts.counts.approved.toLocaleString()}
              green
            />
            <Stat
              icon={AlertTriangle}
              label="Rejected"
              value={settlementCounts.counts.rejected.toLocaleString()}
            />
            <Stat
              icon={HandCoins}
              label="Total Waived"
              value={formatINR(settlementCounts.totalWaiver)}
              sub="approved + sent to bank"
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {settlements.length} settlement requests total
            </span>
            {settlements.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  downloadCsv(
                    "settlements.csv",
                    [
                      "Debtor",
                      "Loan ID",
                      "Original Amount",
                      "Proposed Amount",
                      "Waiver %",
                      "Status",
                      "Requested By",
                      "Approved By",
                      "Created",
                    ],
                    settlements.map((s) => [
                      s.debtorName,
                      s.loanId,
                      s.originalAmount,
                      s.proposedAmount,
                      s.waiverPct,
                      s.status,
                      s.requestedByName,
                      s.approvedByName ?? "—",
                      new Date(s.createdAt).toLocaleString("en-IN"),
                    ]),
                  )
                }
                className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <FileDown className="h-3.5 w-3.5" />
                Export
              </button>
            )}
          </div>

          <DataTable
            rows={settlements}
            keyOf={(s) => s.id}
            empty="No settlement requests yet."
            maxHeight="max-h-[600px]"
            columns={[
              {
                key: "debtor",
                header: "Debtor",
                render: (s) => (
                  <div>
                    <div className="font-medium text-foreground">{s.debtorName}</div>
                    <div className="text-[10px] text-muted-foreground">{s.loanId}</div>
                  </div>
                ),
              },
              {
                key: "original",
                header: "Original",
                numeric: true,
                render: (s) => formatINR(s.originalAmount),
              },
              {
                key: "proposed",
                header: "Proposed",
                numeric: true,
                render: (s) => formatINR(s.proposedAmount),
              },
              {
                key: "waiver",
                header: "Waiver",
                numeric: true,
                render: (s) => <span className="text-amber-500">{s.waiverPct}%</span>,
              },
              {
                key: "status",
                header: "Status",
                render: (s) => (
                  <Badge
                    variant={
                      s.status === "approved" || s.status === "sent_to_bank"
                        ? "secondary"
                        : "outline"
                    }
                    className="text-[10px] font-normal capitalize"
                  >
                    {s.status.replace(/_/g, " ")}
                  </Badge>
                ),
              },
              {
                key: "requestedBy",
                header: "Requested By",
                render: (s) => <span className="text-muted-foreground">{s.requestedByName}</span>,
              },
            ]}
            footer={[
              "Total",
              formatINR(settlements.reduce((s, r) => s + r.originalAmount, 0)),
              formatINR(settlements.reduce((s, r) => s + r.proposedAmount, 0)),
              formatINR(settlementCounts.totalWaiver),
              "",
              "",
            ]}
          />
        </TabsContent>

        {/* ── COMPLIANCE TAB ── */}
        <TabsContent value="compliance" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              icon={AlertTriangle}
              label="Contact-Hour Violations"
              value={complianceViolations.length.toLocaleString()}
              sub={`${complianceRate}% of all calls`}
            />
            <Stat
              icon={Users}
              label="Agents Involved"
              value={complianceAgentCount.toLocaleString()}
            />
            <Stat
              icon={ShieldAlert}
              label="Compliance Window"
              value="07:00–19:00 IST"
              sub="RBI Fair Practices Code"
            />
            <Stat
              icon={CheckCircle2}
              label="Calls In Window"
              value={(disps.length - complianceViolations.length).toLocaleString()}
              sub={`${100 - complianceRate}% of all calls`}
              green
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Flags every logged call outside 07:00–19:00 IST, per RBI's Fair Practices Code — based
            on <code>call_logs.created_at</code>, regardless of who or what placed the call (human,
            AI, or IVR).
          </p>

          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {complianceViolations.length} calls outside the compliance window
            </span>
            {complianceViolations.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  downloadCsv(
                    "compliance-violations.csv",
                    ["Time (IST)", "Debtor", "Agent", "Team", "Outcome"],
                    complianceViolations.map((d) => [
                      formatIST(d.time),
                      d.debtorName,
                      d.agentName || "—",
                      teamName(d.teamId),
                      OUTCOME_LABELS[d.outcome] ?? d.outcome,
                    ]),
                  )
                }
                className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <FileDown className="h-3.5 w-3.5" />
                Export
              </button>
            )}
          </div>

          <DataTable
            rows={complianceViolations}
            keyOf={(d) => d.id}
            empty="No calls logged outside the 07:00–19:00 IST window."
            maxHeight="max-h-[600px]"
            columns={[
              {
                key: "time",
                header: "Time (IST)",
                render: (d) => (
                  <span className="whitespace-nowrap font-medium text-destructive tabular-nums">
                    {formatIST(d.time)}
                  </span>
                ),
              },
              {
                key: "debtor",
                header: "Debtor",
                render: (d) => <span className="text-foreground">{d.debtorName || "—"}</span>,
              },
              {
                key: "agent",
                header: "Agent",
                render: (d) => <span className="text-muted-foreground">{d.agentName || "—"}</span>,
              },
              {
                key: "team",
                header: "Team",
                render: (d) => <span className="text-muted-foreground">{teamName(d.teamId)}</span>,
              },
              {
                key: "outcome",
                header: "Outcome",
                render: (d) => (
                  <span className={cn("font-medium", OUTCOME_COLOR[d.outcome])}>
                    {OUTCOME_LABELS[d.outcome] ?? d.outcome}
                  </span>
                ),
              },
            ]}
          />
        </TabsContent>

        {/* ── CALL LOG TAB ── */}
        <TabsContent value="profilex" className="mt-4 space-y-6">
          {/* Who spent it, then what it went on. Per-person first: every lookup is charged, so
              the actionable question is which manager is running them, not which service. */}
          <InsightsUsagePanel />
          <ProfilexSpendPanel />
        </TabsContent>

        <TabsContent value="detail" className="mt-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">{disps.length} calls total</span>
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  "call-log.csv",
                  [
                    "Time",
                    "Debtor",
                    "Phone",
                    "Agent",
                    "Team",
                    "Portfolio",
                    "Outcome",
                    "PTP Amount",
                    "PTP Date",
                    "Notes",
                  ],
                  disps.map((d) => [
                    new Date(d.time).toLocaleString("en-IN"),
                    d.debtorName,
                    d.phone,
                    d.agentName,
                    teamName(d.teamId),
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
            rows={disps}
            keyOf={(d) => d.id}
            empty="No calls logged yet."
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
                key: "team",
                header: "Team",
                render: (d) => <span className="text-muted-foreground">{teamName(d.teamId)}</span>,
              },
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
