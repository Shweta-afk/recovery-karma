import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
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
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useActiveTeam } from "@/lib/active-team-store";
import { useTeamAgents } from "@/lib/team-store";
import {
  getTeamDispositions,
  refreshDispositions,
  getTeamPtpFollowups,
  calcStats,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { getPortfolios, refreshPortfolios } from "@/lib/portfolio-store";
import { formatINR } from "@/lib/mock-debtors";
import { downloadCsv } from "@/lib/csv-export";
import {
  OUTCOME_LABELS,
  OUTCOME_COLOR,
  OutcomeBreakdown,
} from "@/components/reports/outcome-breakdown";
import { Stat } from "@/components/reports/stat-card";
import { AgentCallLog } from "@/components/reports/agent-call-log";

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

  useEffect(() => {
    const load = () => setDisps(activeTeam ? getTeamDispositions(activeTeam.id) : []);
    load();
    window.addEventListener("dispositions-updated", load);
    refreshDispositions();
    return () => window.removeEventListener("dispositions-updated", load);
    // Only the active team's id should retrigger this, not every re-render of the team object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam?.id]);

  const [portfolioVersion, setPortfolioVersion] = useState(0);
  useEffect(() => {
    const bump = () => setPortfolioVersion((n) => n + 1);
    window.addEventListener("portfolios-updated", bump);
    refreshPortfolios();
    return () => window.removeEventListener("portfolios-updated", bump);
  }, []);

  const portfolios = useMemo(
    () => getPortfolios().filter((p) => p.teamId === activeTeam?.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTeam?.id, portfolioVersion],
  );
  const assignedCount = useMemo(
    () => portfolios.reduce((s, p) => s + p.rows.filter((r) => r.assignedAgentId).length, 0),
    [portfolios],
  );

  const globalStats = useMemo(() => calcStats(disps), [disps]);

  const agentStats = useMemo(
    () =>
      teamAgents
        .map((agent) => {
          const agentDisps = disps.filter((d) => d.agentId === agent.id);
          const assigned = portfolios.reduce(
            (s, p) => s + p.rows.filter((r) => r.assignedAgentId === agent.id).length,
            0,
          );
          return {
            agentId: agent.id,
            name: agent.name,
            stats: calcStats(agentDisps),
            assignedCount: assigned,
            disps: agentDisps,
          };
        })
        .sort((a, b) => b.stats.total - a.stats.total),
    [teamAgents, disps, portfolios],
  );

  const filtered = search.trim()
    ? agentStats.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))
    : agentStats;

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
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
        <p className="text-sm text-muted-foreground">
          {activeTeam.name} — agent performance, call outcomes, and open promises.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          icon={IndianRupee}
          label="PTP Amount"
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
          label="Calls Logged"
          value={globalStats.total.toLocaleString()}
          sub={`${globalStats.contactRate}% contact rate`}
        />
        <Stat
          icon={Users}
          label="Team Accounts"
          value={assignedCount.toLocaleString()}
          sub={`${teamAgents.length} agent${teamAgents.length !== 1 ? "s" : ""}`}
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

      <Tabs defaultValue="agents">
        <TabsList>
          <TabsTrigger value="agents">By Agent</TabsTrigger>
          <TabsTrigger value="outcomes">Outcome Breakdown</TabsTrigger>
          <TabsTrigger value="followups">
            PTP Follow-ups
            {overdueFollowups.length > 0 && (
              <Badge variant="destructive" className="ml-1.5 text-[10px] py-0">
                {overdueFollowups.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="detail">Call Log</TabsTrigger>
        </TabsList>

        {/* ── AGENTS TAB ── */}
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

          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/20 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2.5 px-4 text-left font-medium">Agent</th>
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
                    <td colSpan={7} className="py-8 text-center text-xs text-muted-foreground">
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
                          <td colSpan={7} className="px-4 py-3 bg-muted/10 border-b border-border">
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
                Outcome Distribution — {activeTeam.name}
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
        </TabsContent>

        {/* ── PTP FOLLOW-UPS TAB ── */}
        <TabsContent value="followups" className="mt-4">
          <Card>
            <CardHeader className="border-b border-border pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">
                Open Promises — {activeTeam.name}
              </CardTitle>
              {followups.length > 0 && (
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
                  className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  Export
                </button>
              )}
            </CardHeader>
            <CardContent className="pt-4">
              {followups.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No open promises-to-pay across this team right now.
                </p>
              ) : (
                <div className="rounded-md border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/20 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="py-2 px-3 text-left font-medium">Debtor</th>
                        <th className="py-2 px-3 text-left font-medium">Phone</th>
                        <th className="py-2 px-3 text-right font-medium">Amount</th>
                        <th className="py-2 px-3 text-left font-medium">Due</th>
                        <th className="py-2 px-3 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {followups.map((f) => (
                        <tr key={f.id} className="hover:bg-muted/20">
                          <td className="py-2 px-3 font-medium text-foreground">{f.debtorName}</td>
                          <td className="py-2 px-3 text-muted-foreground font-mono">{f.phone}</td>
                          <td className="py-2 px-3 text-right text-success font-medium">
                            {formatINR(f.ptpAmount)}
                          </td>
                          <td className="py-2 px-3 text-muted-foreground">{f.ptpDateIso}</td>
                          <td className="py-2 px-3">
                            {f.daysLeft < 0 ? (
                              <span className="inline-flex items-center gap-1 text-destructive font-medium">
                                <AlertTriangle className="h-3 w-3" />
                                {-f.daysLeft}d overdue
                              </span>
                            ) : f.daysLeft === 0 ? (
                              <span className="text-amber-500 font-medium">Due today</span>
                            ) : (
                              <span className="text-muted-foreground">in {f.daysLeft}d</span>
                            )}
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

        {/* ── CALL LOG TAB ── */}
        <TabsContent value="detail" className="mt-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-muted-foreground">{disps.length} calls total</span>
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
                  disps.map((d) => [
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
