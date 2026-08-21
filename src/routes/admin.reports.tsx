import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
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
import { downloadCsv } from "@/lib/csv-export";
import {
  OUTCOME_LABELS,
  OUTCOME_COLOR,
  OutcomeBreakdown,
} from "@/components/reports/outcome-breakdown";
import { Stat } from "@/components/reports/stat-card";
import { AgentCallLog } from "@/components/reports/agent-call-log";

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

  // Global stats
  const globalStats = useMemo(() => calcStats(disps), [disps]);
  const totalAccounts = useMemo(
    () => portfolios.reduce((s, p) => s + p.rows.length, 0),
    [portfolios],
  );

  // Per-team stats
  const teamStats = useMemo(() => {
    const now = new Date();
    return teams.map((team) => {
      const teamDisps = disps.filter((d) => d.teamId === team.id);
      const teamPortfolios = portfolios.filter((p) => p.teamId === team.id);
      const assignedCount = teamPortfolios.reduce(
        (s, p) => s + p.rows.filter((r) => r.assignedAgentId).length,
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
  }, [teams, disps, portfolios]);

  // All agents across all teams with stats
  const agentStats = useMemo(() => {
    const allAgentIds = Array.from(new Set(teams.flatMap((t) => t.agentIds)));
    return allAgentIds
      .map((agentId) => {
        const agentDisps = disps.filter((d) => d.agentId === agentId);
        const ref = getAgentById(agentId);
        const team = teams.find((t) => t.agentIds.includes(agentId));
        const assignedCount = portfolios.reduce(
          (s, p) => s + p.rows.filter((r) => r.assignedAgentId === agentId).length,
          0,
        );
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
  }, [teams, disps, portfolios]);

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
  const recoveryByPortfolio = useMemo(() => {
    return portfolios
      .map((p) => {
        const placed = p.rows.reduce((s, r) => s + (r.loanAmount || 0), 0);
        const collected = payments
          .filter((pay) => pay.portfolioId === p.id && pay.status === "completed")
          .reduce((s, pay) => s + pay.amount, 0);
        return {
          id: p.id,
          name: p.name,
          placed,
          collected,
          rate: placed > 0 ? Math.round((collected / placed) * 100) : 0,
        };
      })
      .filter((p) => p.placed > 0)
      .sort((a, b) => b.placed - a.placed);
  }, [portfolios, payments]);

  const totalPlaced = useMemo(
    () => recoveryByPortfolio.reduce((s, p) => s + p.placed, 0),
    [recoveryByPortfolio],
  );
  const totalCollectedAllTime = useMemo(
    () => payments.filter((p) => p.status === "completed").reduce((s, p) => s + p.amount, 0),
    [payments],
  );
  const overallRecoveryRate =
    totalPlaced > 0 ? Math.round((totalCollectedAllTime / totalPlaced) * 100) : 0;

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
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Full recovery reporting — all teams, individual agents, call outcomes and PTP performance.
        </p>
      </div>

      {/* Global KPIs */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          icon={IndianRupee}
          label="Total PTP Amount"
          value={formatINR(globalStats.ptpAmount)}
          sub={`${globalStats.ptps} promises`}
          green
        />
        <Stat
          icon={CheckCircle2}
          label="Paid / Collected"
          value={formatINR(globalStats.paidAmount)}
          sub={`${globalStats.paid} accounts`}
          green
        />
        <Stat
          icon={PhoneCall}
          label="Total Calls Logged"
          value={globalStats.total.toLocaleString()}
          sub={`${globalStats.contactRate}% contact rate`}
        />
        <Stat
          icon={Users}
          label="Total Accounts"
          value={totalAccounts.toLocaleString()}
          sub={`${teams.length} team${teams.length !== 1 ? "s" : ""}`}
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

      <Tabs defaultValue="teams">
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="teams">By Team</TabsTrigger>
            <TabsTrigger value="agents">By Agent</TabsTrigger>
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
            <TabsTrigger value="detail">Call Log</TabsTrigger>
          </TabsList>
        </div>

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
                                {p.name} · {p.rows.filter((r) => r.assignedAgentId).length} accounts
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

          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/20 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2.5 px-4 text-left font-medium">Agent</th>
                  <th className="py-2.5 px-3 text-left font-medium">Team</th>
                  <th className="py-2.5 px-3 text-center font-medium">Assigned</th>
                  <th className="py-2.5 px-3 text-center font-medium">Calls</th>
                  <th className="py-2.5 px-3 text-center font-medium">PTPs</th>
                  <th className="py-2.5 px-3 text-right font-medium">PTP Value</th>
                  <th className="py-2.5 px-3 text-center font-medium">Contact%</th>
                  <th className="py-2.5 px-3 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-xs text-muted-foreground">
                      No agents match
                    </td>
                  </tr>
                )}
                {filtered.map((a) => {
                  const open = expandedAgent === a.agentId;
                  return (
                    <>
                      <tr
                        key={a.agentId}
                        className="hover:bg-muted/20 cursor-pointer"
                        onClick={() => setExpandedAgent(open ? null : a.agentId)}
                      >
                        <td className="py-2.5 px-4">
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
                        <td className="py-2.5 px-3 text-muted-foreground text-xs">{a.teamName}</td>
                        <td className="py-2.5 px-3 text-center">{a.assignedCount}</td>
                        <td className="py-2.5 px-3 text-center">{a.stats.total}</td>
                        <td className="py-2.5 px-3 text-center text-blue-500 font-medium">
                          {a.stats.ptps}
                        </td>
                        <td className="py-2.5 px-3 text-right text-success text-xs">
                          {a.stats.ptpAmount > 0 ? formatINR(a.stats.ptpAmount) : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-center text-xs">
                          {a.stats.total > 0 ? `${a.stats.contactRate}%` : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <ChevronRight
                            className={cn(
                              "h-3.5 w-3.5 text-muted-foreground transition-transform",
                              open && "rotate-90",
                            )}
                          />
                        </td>
                      </tr>
                      {open && (
                        <tr key={`${a.agentId}-detail`}>
                          <td colSpan={8} className="px-4 py-3 bg-muted/10 border-b border-border">
                            <AgentCallLog disps={a.disps} agentName={a.name} />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
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
              value={`${overallRecoveryRate}%`}
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

          <Card>
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold">Recovery Rate by Portfolio</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {recoveryByPortfolio.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No portfolios with accounts yet.
                </p>
              ) : (
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/20 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 px-3 text-left font-medium">Portfolio</th>
                        <th className="py-2 px-3 text-right font-medium">Placed</th>
                        <th className="py-2 px-3 text-right font-medium">Collected</th>
                        <th className="py-2 px-3 text-left font-medium">Recovery Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {recoveryByPortfolio.map((p) => (
                        <tr key={p.id} className="hover:bg-muted/20">
                          <td className="py-2 px-3 font-medium text-foreground">{p.name}</td>
                          <td className="py-2 px-3 text-right">{formatINR(p.placed)}</td>
                          <td className="py-2 px-3 text-right text-success">
                            {formatINR(p.collected)}
                          </td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-1.5">
                              <Progress value={p.rate} className="h-1.5 w-24" />
                              <span className="w-9 text-right">{p.rate}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
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

          {disputes.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No disputes logged.</p>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b border-border bg-muted/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 px-3 text-left font-medium">Debtor</th>
                      <th className="py-2 px-3 text-left font-medium">Type</th>
                      <th className="py-2 px-3 text-left font-medium">Status</th>
                      <th className="py-2 px-3 text-left font-medium">Raised By</th>
                      <th className="py-2 px-3 text-left font-medium">Notes</th>
                      <th className="py-2 px-3 text-left font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {disputes.map((d) => (
                      <tr key={d.id} className="hover:bg-muted/20">
                        <td className="py-2 px-3">
                          <div className="font-medium text-foreground">{d.debtorName}</div>
                          <div className="text-muted-foreground">{d.portfolioName ?? "—"}</div>
                        </td>
                        <td className="py-2 px-3 text-muted-foreground">{d.disputeType ?? "—"}</td>
                        <td className="py-2 px-3">
                          <Badge
                            variant={d.status === "resolved" ? "secondary" : "outline"}
                            className="text-[10px] font-normal capitalize"
                          >
                            {d.status.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 text-foreground">{d.raisedByName}</td>
                        <td className="py-2 px-3 max-w-[240px] truncate text-muted-foreground">
                          {d.agentNotes || d.debtorReason || "—"}
                        </td>
                        <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                          {new Date(d.createdAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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

          {settlements.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No settlement requests yet.
            </p>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b border-border bg-muted/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 px-3 text-left font-medium">Debtor</th>
                      <th className="py-2 px-3 text-right font-medium">Original</th>
                      <th className="py-2 px-3 text-right font-medium">Proposed</th>
                      <th className="py-2 px-3 text-right font-medium">Waiver</th>
                      <th className="py-2 px-3 text-left font-medium">Status</th>
                      <th className="py-2 px-3 text-left font-medium">Requested By</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {settlements.map((s) => (
                      <tr key={s.id} className="hover:bg-muted/20">
                        <td className="py-2 px-3 font-medium text-foreground">{s.debtorName}</td>
                        <td className="py-2 px-3 text-right">{formatINR(s.originalAmount)}</td>
                        <td className="py-2 px-3 text-right">{formatINR(s.proposedAmount)}</td>
                        <td className="py-2 px-3 text-right text-amber-500">{s.waiverPct}%</td>
                        <td className="py-2 px-3">
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
                        </td>
                        <td className="py-2 px-3 text-muted-foreground">{s.requestedByName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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

          {complianceViolations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No calls logged outside the 07:00–19:00 IST window.
            </p>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b border-border bg-muted/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 px-3 text-left font-medium">Time (IST)</th>
                      <th className="py-2 px-3 text-left font-medium">Debtor</th>
                      <th className="py-2 px-3 text-left font-medium">Agent</th>
                      <th className="py-2 px-3 text-left font-medium">Team</th>
                      <th className="py-2 px-3 text-left font-medium">Outcome</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {complianceViolations.map((d) => (
                      <tr key={d.id} className="hover:bg-muted/20">
                        <td className="py-2 px-3 text-destructive font-medium whitespace-nowrap">
                          {formatIST(d.time)}
                        </td>
                        <td className="py-2 px-3 text-foreground">{d.debtorName}</td>
                        <td className="py-2 px-3 text-muted-foreground">{d.agentName || "—"}</td>
                        <td className="py-2 px-3 text-muted-foreground">{teamName(d.teamId)}</td>
                        <td className="py-2 px-3">
                          <span className={cn("font-medium", OUTCOME_COLOR[d.outcome])}>
                            {OUTCOME_LABELS[d.outcome] ?? d.outcome}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── CALL LOG TAB ── */}
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

          {disps.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No calls logged yet.</p>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <div className="overflow-x-auto max-h-[600px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="border-b border-border bg-muted/20 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 px-3 text-left font-medium">Time</th>
                      <th className="py-2 px-3 text-left font-medium">Debtor</th>
                      <th className="py-2 px-3 text-left font-medium">Agent</th>
                      <th className="py-2 px-3 text-left font-medium">Outcome</th>
                      <th className="py-2 px-3 text-right font-medium">PTP Amt</th>
                      <th className="py-2 px-3 text-left font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {disps.map((d) => (
                      <tr key={d.id} className="hover:bg-muted/20">
                        <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                          {new Date(d.time).toLocaleString("en-IN", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="py-2 px-3">
                          <div className="font-medium text-foreground">{d.debtorName}</div>
                          <div className="text-muted-foreground font-mono">{d.phone}</div>
                        </td>
                        <td className="py-2 px-3 text-foreground">{d.agentName}</td>
                        <td className="py-2 px-3">
                          <span className={cn("font-medium", OUTCOME_COLOR[d.outcome])}>
                            {OUTCOME_LABELS[d.outcome] ?? d.outcome}
                          </span>
                          {d.ptpDate && (
                            <div className="text-[10px] text-muted-foreground">PTP {d.ptpDate}</div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {d.ptpAmount ? (
                            <span className="text-success font-medium">
                              {formatINR(d.ptpAmount)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2 px-3 max-w-[200px] truncate text-muted-foreground">
                          {d.notes || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
