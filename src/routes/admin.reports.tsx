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

function sanitize(v: string | number) {
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `\t${s}` : s;
}
function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => `"${sanitize(v).replace(/"/g, '""')}"`;
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const OUTCOME_LABELS: Record<string, string> = {
  paid: "Paid",
  promised: "PTP",
  refused: "Refused",
  no_answer: "No Answer",
  callback: "Callback",
  voicemail: "Voicemail",
  dispute: "Dispute",
  settlement: "Settlement",
};
const OUTCOME_COLOR: Record<string, string> = {
  paid: "text-success",
  promised: "text-blue-500",
  refused: "text-destructive",
  no_answer: "text-muted-foreground",
  callback: "text-amber-500",
  voicemail: "text-muted-foreground",
  dispute: "text-orange-500",
  settlement: "text-purple-500",
};

// ─── stat card ────────────────────────────────────────────────────────────────

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  green,
}: {
  icon: typeof BarChart2;
  label: string;
  value: string;
  sub?: string;
  green?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 pt-4 pb-4">
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
            green ? "bg-success/10" : "bg-primary/8",
          )}
        >
          <Icon className={cn("h-4 w-4", green ? "text-success" : "text-primary/70")} />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold text-foreground leading-tight">{value}</div>
          {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
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
        const todayDisps = teamDisps.filter(
          (d) => d.agentId === aid && isSameDay(d.time, now),
        );
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
        <TabsList>
          <TabsTrigger value="teams">By Team</TabsTrigger>
          <TabsTrigger value="agents">By Agent</TabsTrigger>
          <TabsTrigger value="outcomes">Outcome Breakdown</TabsTrigger>
          <TabsTrigger value="detail">Call Log</TabsTrigger>
        </TabsList>

        {/* ── TEAMS TAB ── */}
        <TabsContent value="teams" className="mt-4 space-y-3">
          {teamStats.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No teams created yet. Go to Admin → Teams to create one.
            </p>
          )}
          {teamStats.map(({ team, stats, assignedCount, disps: td, portfolios: tp, avgIdlePct }) => {
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
                        exportCSV(
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
                                      <Progress value={as_.contactRate} className="h-1.5 flex-1" />
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
                            <Badge key={p.id} variant="outline" className="text-[10px] font-normal">
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
          })}
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
                exportCSV(
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

        {/* ── CALL LOG TAB ── */}
        <TabsContent value="detail" className="mt-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">{disps.length} calls total</span>
            <button
              type="button"
              onClick={() =>
                exportCSV(
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

// ─── Outcome breakdown bar chart ──────────────────────────────────────────────

function OutcomeBreakdown({ disps }: { disps: DispositionRecord[] }) {
  const counts = disps.reduce<Record<string, number>>((acc, d) => {
    acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const total = disps.length;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-2.5">
      {sorted.map(([outcome, count]) => {
        const pct = Math.round((count / total) * 100);
        return (
          <div key={outcome} className="flex items-center gap-3 text-xs">
            <span className={cn("font-medium w-24 shrink-0", OUTCOME_COLOR[outcome])}>
              {OUTCOME_LABELS[outcome] ?? outcome}
            </span>
            <Progress value={pct} className="flex-1 h-2" />
            <span className="text-muted-foreground w-12 text-right">
              {count} ({pct}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Per-agent call log (inline) ──────────────────────────────────────────────

function AgentCallLog({ disps, agentName }: { disps: DispositionRecord[]; agentName: string }) {
  if (disps.length === 0)
    return <p className="text-xs text-muted-foreground">No calls logged for {agentName} yet.</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
          {agentName} · {disps.length} calls
        </span>
        <button
          type="button"
          onClick={() =>
            exportCSV(
              `${agentName}-calls.csv`,
              ["Time", "Debtor", "Phone", "Outcome", "PTP Amount", "Notes"],
              disps.map((d) => [
                new Date(d.time).toLocaleString("en-IN"),
                d.debtorName,
                d.phone,
                d.outcome,
                d.ptpAmount ?? "",
                d.notes,
              ]),
            )
          }
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors"
        >
          <FileDown className="h-2.5 w-2.5" />
          Export
        </button>
      </div>
      {disps.slice(0, 10).map((d) => (
        <div key={d.id} className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground w-32 shrink-0">
            {new Date(d.time).toLocaleString("en-IN", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="font-medium text-foreground min-w-0 truncate flex-1">
            {d.debtorName}
          </span>
          <span className={cn("font-medium shrink-0", OUTCOME_COLOR[d.outcome])}>
            {OUTCOME_LABELS[d.outcome] ?? d.outcome}
          </span>
          {d.ptpAmount ? (
            <span className="text-success shrink-0">{formatINR(d.ptpAmount)}</span>
          ) : null}
        </div>
      ))}
      {disps.length > 10 && (
        <p className="text-[10px] text-muted-foreground">+{disps.length - 10} more calls</p>
      )}
    </div>
  );
}
