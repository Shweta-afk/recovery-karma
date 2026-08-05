import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Phone,
  Target,
  TrendingUp,
  TrendingDown,
  IndianRupee,
  PieChart as PieIcon,
  Users,
  Bell,
  Activity,
  CheckCircle2,
  Clock,
  XCircle,
  PhoneOff,
  MessageCircle,
  Send,
  FileDown,
  LayoutDashboard,
  UserCog,
  FileBarChart2,
  HandCoins,
} from "lucide-react";
import { toast } from "sonner";
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useManagerTeamAgents, type AgentRef } from "@/lib/team-store";
import { useAuth } from "@/lib/auth";
import {
  getAgentDispositions,
  getDispositions,
  refreshDispositions,
  calcStats,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { getPortfolios, getAgentDebtorIds, refreshPortfolios } from "@/lib/portfolio-store";
import { saveNotification } from "@/lib/notification-store";
import { getEscalations, refreshEscalations } from "@/lib/escalation-store";
import { useStorageSync } from "@/lib/storage-sync";
import { downloadCsv } from "@/lib/csv-export";
import { rankColor } from "@/lib/rank-color";
import { AgentDashboardContent } from "./dashboard.index";

export const Route = createFileRoute("/manager/")({
  head: () => ({
    meta: [
      { title: "Manager Dashboard · Axiora" },
      { name: "description", content: "Team analytics, live per-agent view, and reports." },
    ],
  }),
  component: ManagerDashboardPage,
});

/* ─── real-data helpers ──────────────────────────────────────────────────── */

const DEFAULT_DAILY_TARGET = 80; // matches the Supabase seed's agent daily_target

function isToday(iso: string): boolean {
  const d = new Date(iso),
    now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}
function sameCalendarDay(iso: string, d: Date): boolean {
  const a = new Date(iso);
  return (
    a.getFullYear() === d.getFullYear() &&
    a.getMonth() === d.getMonth() &&
    a.getDate() === d.getDate()
  );
}
function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
const OUTCOME_ICON: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  paid: { icon: CheckCircle2, color: "text-success" },
  promised: { icon: MessageCircle, color: "text-primary" },
  refused: { icon: XCircle, color: "text-destructive" },
  no_answer: { icon: PhoneOff, color: "text-muted-foreground" },
  callback: { icon: Clock, color: "text-muted-foreground" },
  voicemail: { icon: Phone, color: "text-muted-foreground" },
  dispute: { icon: XCircle, color: "text-destructive" },
  settlement: { icon: IndianRupee, color: "text-success" },
};
function outcomeText(d: DispositionRecord): string {
  switch (d.outcome) {
    case "paid":
      return `${d.agentName} collected ${formatINR(d.paidAmount ?? 0)} from ${d.debtorName}`;
    case "promised":
      return `${d.agentName} secured a PTP from ${d.debtorName} · ${formatINR(d.ptpAmount ?? 0)}`;
    case "refused":
      return `${d.debtorName} refused to pay — logged by ${d.agentName}`;
    case "no_answer":
      return `${d.agentName} called ${d.debtorName} — no answer`;
    case "callback":
      return `${d.agentName} scheduled a callback with ${d.debtorName}`;
    case "dispute":
      return `${d.debtorName} disputed the outstanding — flagged by ${d.agentName}`;
    case "settlement":
      return `${d.agentName} logged a settlement for ${d.debtorName}`;
    default:
      return `${d.agentName} logged a call with ${d.debtorName} — ${d.outcome}`;
  }
}

interface AgentComputedStat {
  id: string;
  name: string;
  assignedCount: number;
  assignedPOS: number;
  callsToday: number;
  ptpCountToday: number;
  ptpAmountToday: number;
  paidToday: number;
  totalPaid: number;
  contactRate: number;
  hasActivityToday: boolean;
  openEscalations: number;
}

function computeAgentStats(agent: AgentRef): AgentComputedStat {
  const disps = getAgentDispositions(agent.id);
  const today = calcStats(disps.filter((d) => isToday(d.time)));
  const all = calcStats(disps);

  const slices = getAgentDebtorIds(agent.id);
  const portfolios = getPortfolios();
  let assignedCount = 0,
    assignedPOS = 0;
  for (const { portfolioId, debtorIds } of slices) {
    const p = portfolios.find((p) => p.id === portfolioId);
    if (!p) continue;
    const idSet = new Set(debtorIds);
    for (const row of p.rows)
      if (idSet.has(row.id)) {
        assignedCount++;
        assignedPOS += row.loanAmount;
      }
  }

  return {
    id: agent.id,
    name: agent.name,
    assignedCount,
    assignedPOS,
    callsToday: today.total,
    ptpCountToday: today.ptps,
    ptpAmountToday: today.ptpAmount,
    paidToday: today.paidAmount,
    totalPaid: all.paidAmount,
    contactRate: all.contactRate,
    hasActivityToday: today.total > 0,
    openEscalations: getEscalations().filter((e) => e.agentId === agent.id && !e.resolved).length,
  };
}

function useTeamStats(agents: AgentRef[]) {
  const [stats, setStats] = useState<AgentComputedStat[]>(() => agents.map(computeAgentStats));
  const reload = () => setStats(agents.map(computeAgentStats));
  useEffect(() => {
    reload();
    window.addEventListener("dispositions-updated", reload);
    window.addEventListener("portfolios-updated", reload);
    window.addEventListener("escalations-updated", reload);
    refreshPortfolios();
    refreshDispositions();
    refreshEscalations();
    return () => {
      window.removeEventListener("dispositions-updated", reload);
      window.removeEventListener("portfolios-updated", reload);
      window.removeEventListener("escalations-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  useStorageSync(reload);
  return stats;
}

function formatINR(n: number) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

const RANK_STYLE: Record<number, string> = {
  0: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40 shadow-sm shadow-yellow-500/20",
  1: "bg-slate-400/20 text-slate-300 border-slate-400/40",
  2: "bg-orange-700/20 text-orange-400 border-orange-700/40",
};
const RANK_LABEL: Record<number, string> = { 0: "1st", 1: "2nd", 2: "3rd" };

const TOOLTIP = {
  contentStyle: {
    background: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    fontSize: 11,
  },
  labelStyle: { color: "var(--color-foreground)" },
  itemStyle: { color: "var(--color-muted-foreground)" },
};

/* ─── sub-components — Team Analytics ────────────────────────────────────── */

interface StatDef {
  label: string;
  value: string;
  hint: string;
  icon: typeof Phone;
  tone: "primary" | "muted" | "success" | "warning";
  trend?: "up" | "down";
}

function StatCard({ stat, index }: { stat: StatDef; index: number }) {
  const iconColor =
    stat.tone === "success"
      ? "text-success"
      : stat.tone === "warning"
        ? "text-warning-foreground"
        : stat.tone === "primary"
          ? "text-primary"
          : "text-muted-foreground";
  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-primary/10"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {stat.label}
        </CardTitle>
        <stat.icon className={cn("h-4 w-4", iconColor)} />
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-1.5">
          <span className="text-2xl font-semibold text-foreground">{stat.value}</span>
          {"trend" in stat && (
            <span
              className={cn("mb-0.5", stat.trend === "up" ? "text-success" : "text-destructive")}
            >
              {stat.trend === "up" ? (
                <TrendingUp className="h-4 w-4" />
              ) : (
                <TrendingDown className="h-4 w-4" />
              )}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{stat.hint}</p>
      </CardContent>
    </Card>
  );
}

interface TrendPoint {
  day: number;
  thisMonth: number;
  lastMonth: number;
}

function RecoveryTrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="thisMonthGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="oklch(0.58 0.18 258)" stopOpacity={0.25} />
            <stop offset="95%" stopColor="oklch(0.58 0.18 258)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="lastMonthGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="oklch(0.45 0.02 258)" stopOpacity={0.15} />
            <stop offset="95%" stopColor="oklch(0.45 0.02 258)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="day"
          tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
          tickFormatter={(v) => `${v}`}
          interval={4}
          label={{
            value: "Day of month",
            position: "insideBottom",
            offset: -2,
            fontSize: 10,
            fill: "var(--color-muted-foreground)",
          }}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
          tickFormatter={(v) => `${v}%`}
          domain={[20, 50]}
          label={{
            value: "Recovery rate",
            angle: -90,
            position: "insideLeft",
            offset: 12,
            fontSize: 10,
            fill: "var(--color-muted-foreground)",
            style: { textAnchor: "middle" },
          }}
        />
        <Tooltip
          {...TOOLTIP}
          formatter={(v: number, name: string) => [
            `${v}%`,
            name === "thisMonth" ? "This month" : "Last month (same day)",
          ]}
          labelFormatter={(d) => `Day ${d} of month`}
        />
        <Legend
          formatter={(v) => (v === "thisMonth" ? "This month" : "Last month (same days)")}
          wrapperStyle={{ fontSize: 11 }}
        />
        <Area
          type="monotone"
          name="lastMonth"
          dataKey="lastMonth"
          stroke="oklch(0.55 0.03 258)"
          strokeWidth={1.5}
          strokeDasharray="5 3"
          fill="url(#lastMonthGrad)"
          dot={false}
          activeDot={{ r: 4 }}
        />
        <Area
          type="monotone"
          name="thisMonth"
          dataKey="thisMonth"
          stroke="oklch(0.58 0.18 258)"
          strokeWidth={2.5}
          fill="url(#thisMonthGrad)"
          dot={false}
          activeDot={{ r: 5, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

interface OutcomeSlice {
  name: string;
  value: number;
  color: string;
}

function OutcomesDonut({ outcomes, total }: { outcomes: OutcomeSlice[]; total: number }) {
  if (total === 0) {
    return (
      <p className="py-14 text-center text-xs text-muted-foreground">
        No dispositions logged today yet — this fills in as the team logs calls.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie
            data={outcomes}
            cx="50%"
            cy="50%"
            innerRadius={52}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
            strokeWidth={0}
          >
            {outcomes.map((o, i) => (
              <Cell key={i} fill={o.color} />
            ))}
          </Pie>
          <Tooltip
            {...TOOLTIP}
            formatter={(v: number) => [`${v} (${((v / total) * 100).toFixed(1)}%)`]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-1">
        {outcomes.map((o) => (
          <div key={o.name} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full flex-shrink-0"
              style={{ background: o.color }}
            />
            <span className="text-xs text-muted-foreground">
              {o.name} <span className="text-foreground font-medium">{o.value}</span>{" "}
              <span className="text-[10px]">({((o.value / total) * 100).toFixed(0)}%)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityFeed({ recent }: { recent: DispositionRecord[] }) {
  if (recent.length === 0) {
    return (
      <p className="py-14 text-center text-xs text-muted-foreground">
        No calls logged yet — real dispositions from your team will show up here as they happen.
      </p>
    );
  }
  return (
    <ScrollArea className="h-[320px] pr-1">
      <div className="space-y-0.5">
        {recent.map((d) => {
          const cfg = OUTCOME_ICON[d.outcome] ?? { icon: Activity, color: "text-muted-foreground" };
          return (
            <div
              key={d.id}
              className="flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent/50"
            >
              <cfg.icon className={cn("h-4 w-4 mt-0.5 flex-shrink-0", cfg.color)} />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground leading-snug">{outcomeText(d)}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{timeAgo(d.time)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

/* ─── sub-components — real per-agent leaderboard + availability ─────────── */

function AgentLeaderboard({ agents }: { agents: AgentComputedStat[] }) {
  const sorted = [...agents].sort((a, b) => b.totalPaid - a.totalPaid);
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              "agent-leaderboard.csv",
              ["Rank", "Agent", "Calls Today", "Target", "Contact %", "Total Paid (₹)"],
              sorted.map((a, i) => [
                i + 1,
                a.name,
                a.callsToday,
                DEFAULT_DAILY_TARGET,
                a.contactRate,
                a.totalPaid,
              ]),
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <FileDown className="h-3 w-3" />
          Export
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="pb-2 pl-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground w-12">
                Rank
              </th>
              <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Agent
              </th>
              <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground min-w-[140px]">
                Calls Today vs Target
              </th>
              <th className="pb-2 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Contact %
              </th>
              <th className="pb-2 pr-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Total Paid
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((a, i) => (
              <tr
                key={a.id}
                className={cn(
                  "transition-colors hover:bg-primary/5",
                  i === 0 && "bg-yellow-500/5 hover:bg-yellow-500/10",
                )}
              >
                <td className="py-3 pl-3">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[11px] font-semibold px-1.5 py-0.5",
                      RANK_STYLE[i] ?? "bg-muted/30 text-muted-foreground border-border",
                    )}
                  >
                    {RANK_LABEL[i] ?? `${i + 1}th`}
                  </Badge>
                </td>
                <td className="py-3">
                  <span
                    className={cn("font-medium", i === 0 ? "text-yellow-400" : "text-foreground")}
                  >
                    {a.name}
                  </span>
                </td>
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2">
                    <Progress
                      value={Math.min((a.callsToday / DEFAULT_DAILY_TARGET) * 100, 100)}
                      className="h-1.5 flex-1"
                    />
                    <span className="text-xs text-muted-foreground w-16 flex-shrink-0">
                      {a.callsToday}/{DEFAULT_DAILY_TARGET}
                    </span>
                  </div>
                </td>
                <td className="py-3 text-center">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      a.contactRate >= 70
                        ? "text-success"
                        : a.contactRate >= 55
                          ? "text-warning-foreground"
                          : "text-destructive",
                    )}
                  >
                    {a.contactRate}%
                  </span>
                </td>
                <td className="py-3 pr-3 text-right font-medium text-foreground">
                  {formatINR(a.totalPaid)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentAvailabilityGrid({ agents }: { agents: AgentComputedStat[] }) {
  const activeCount = agents.filter((a) => a.hasActivityToday).length;

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Agent Activity · Today
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium bg-success/8 text-success/80 border-success/15">
              <span className="h-1.5 w-1.5 rounded-full bg-success flex-shrink-0" />
              Active {activeCount}
            </span>
            {agents.length - activeCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium bg-muted/50 text-muted-foreground border-border">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground flex-shrink-0" />
                No activity {agents.length - activeCount}
              </span>
            )}
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  "agent-activity.csv",
                  [
                    "Agent",
                    "Active Today",
                    "Calls Today",
                    "PTPs Today",
                    "Collected Today (₹)",
                    "Open Escalations",
                  ],
                  agents.map((a) => [
                    a.name,
                    a.hasActivityToday ? "Yes" : "No",
                    a.callsToday,
                    a.ptpCountToday,
                    a.paidToday,
                    a.openEscalations,
                  ]),
                )
              }
              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors ml-auto"
            >
              <FileDown className="h-3 w-3" />
              Export
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="py-2 pl-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-44">
                  Agent
                </th>
                <th className="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-32">
                  Status
                </th>
                <th className="py-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-28">
                  Calls Today
                </th>
                <th className="py-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-32">
                  PTPs Today
                </th>
                <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-36 pr-4">
                  Collected Today
                </th>
                <th className="py-2 pr-4 w-24" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agents.map((a) => (
                <tr key={a.id} className="hover:bg-muted/20 transition-colors">
                  <td className="py-3 pl-4">
                    <div className="flex items-center gap-2.5">
                      <div className="relative">
                        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-[11px] font-semibold text-muted-foreground flex-shrink-0">
                          {a.name
                            .split(" ")
                            .map((n) => n[0])
                            .slice(0, 2)
                            .join("")}
                        </div>
                        <span
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card",
                            a.hasActivityToday ? "bg-success" : "bg-muted-foreground",
                          )}
                        />
                      </div>
                      <div>
                        <div className="text-xs font-medium text-foreground leading-tight">
                          {a.name}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {a.assignedCount} accounts assigned
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                        a.hasActivityToday
                          ? "bg-success/8 text-success/80 border-success/15"
                          : "bg-muted/50 text-muted-foreground border-border",
                      )}
                    >
                      {a.hasActivityToday ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <Clock className="h-3 w-3" />
                      )}
                      {a.hasActivityToday ? "Active" : "No activity"}
                    </span>
                    {a.openEscalations > 0 && (
                      <div className="mt-1 text-[10px] text-destructive">
                        {a.openEscalations} open escalation{a.openEscalations > 1 ? "s" : ""}
                      </div>
                    )}
                  </td>
                  <td className="py-3 text-center text-xs text-foreground">{a.callsToday}</td>
                  <td className="py-3 text-center text-xs text-foreground">
                    {a.ptpCountToday}{" "}
                    <span className="text-muted-foreground">· {formatINR(a.ptpAmountToday)}</span>
                  </td>
                  <td className="py-3 pr-4 text-right text-xs font-medium text-foreground">
                    {formatINR(a.paidToday)}
                  </td>
                  <td className="py-3 pr-4">
                    {!a.hasActivityToday && (
                      <button
                        type="button"
                        onClick={() => {
                          saveNotification({
                            toAgentId: a.id,
                            fromName: "Your manager",
                            message: "Your manager nudged you — please check your queue.",
                          })
                            .then(() => toast.success(`Nudge sent to ${a.name}`))
                            .catch((e) =>
                              toast.error(e instanceof Error ? e.message : "Failed to send nudge"),
                            );
                        }}
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-all"
                      >
                        <Send className="h-3 w-3" />
                        Nudge
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Agent Live View tab ─────────────────────────────────────────────────── */

function AgentDashboardView({ stat }: { stat: AgentComputedStat }) {
  return (
    <div className="space-y-4">
      {/* Live figures the manager tracks per-agent, above the mirrored dashboard */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          {
            label: "Calls Today",
            value: stat.callsToday.toString(),
            hint: "logged dispositions",
            icon: Phone,
          },
          {
            label: "PTPs Today",
            value: stat.ptpCountToday.toString(),
            hint: formatINR(stat.ptpAmountToday),
            icon: HandCoins,
          },
          {
            label: "Collected Today",
            value: formatINR(stat.paidToday),
            hint: "paid today",
            icon: IndianRupee,
          },
          {
            label: "Total Paid",
            value: formatINR(stat.totalPaid),
            hint: "all-time",
            icon: TrendingUp,
          },
          {
            label: "Contact Rate",
            value: `${stat.contactRate}%`,
            hint: "all-time",
            icon: Activity,
          },
          {
            label: "Assigned",
            value: stat.assignedCount.toString(),
            hint: formatINR(stat.assignedPOS) + " POS",
            icon: Users,
          },
        ].map((c, i) => (
          <Card
            key={c.label}
            className="animate-in fade-in duration-300"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {c.label}
                </span>
                <c.icon className="h-3.5 w-3.5 text-muted-foreground/50" />
              </div>
              <div className="text-lg font-bold text-foreground tabular-nums">{c.value}</div>
              <div className="text-[10px] text-muted-foreground">{c.hint}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {stat.openEscalations > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {stat.openEscalations} open escalation{stat.openEscalations > 1 ? "s" : ""} from{" "}
          {stat.name} — see Call Queue → My Queue.
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        Read-only mirror of {stat.name}'s agent dashboard — the same view they see. Quick-links are
        disabled here.
      </div>

      {/* Faithful mirror of the agent's own dashboard (interactive={false} = no navigation) */}
      <AgentDashboardContent interactive={false} />
    </div>
  );
}

/* ─── Reports tab ─────────────────────────────────────────────────────────── */

function ReportsTab({ agents }: { agents: AgentComputedStat[] }) {
  const todayLabel = new Date()
    .toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    .replace(" ", "-");
  const sorted = [...agents].sort((a, b) => b.totalPaid - a.totalPaid);

  const teamPTPToday = agents.reduce((s, a) => s + a.ptpAmountToday, 0);
  const teamPaidToday = agents.reduce((s, a) => s + a.paidToday, 0);
  const teamProjection = teamPTPToday + teamPaidToday;
  const teamTotalPaid = agents.reduce((s, a) => s + a.totalPaid, 0);
  const teamPOS = agents.reduce((s, a) => s + a.assignedPOS, 0);
  const teamCount = agents.reduce((s, a) => s + a.assignedCount, 0);

  // month label + one paid-total column per agent name (dynamic keys)
  type MonthlyTrendRow = { month: string; [agentName: string]: string | number };
  const monthlyTrend = useMemo<MonthlyTrendRow[]>(() => {
    const roster = new Set(agents.map((a) => a.id));
    const paidDisps = getDispositions().filter(
      (d) => roster.has(d.agentId) && d.outcome === "paid",
    );
    const byMonth = new Map<string, Record<string, number>>();
    for (const d of paidDisps) {
      const key = monthKey(d.time);
      if (!byMonth.has(key)) byMonth.set(key, {});
      const row = byMonth.get(key)!;
      row[d.agentName] = (row[d.agentName] ?? 0) + (d.paidAmount ?? 0);
    }
    return Array.from(byMonth.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, row]) => ({ month: monthLabel(key), ...row }));
  }, [agents]);

  const exportEmployeeReport = () => {
    downloadCsv(
      "employee-performance-report.csv",
      [
        "Employee",
        "Count of Loan ID",
        "Sum of POS",
        `Sum of ${todayLabel}`,
        "Sum of Total Paid",
        "Rank",
      ],
      sorted.map((a, i) => [
        a.name,
        a.assignedCount,
        a.assignedPOS,
        a.paidToday,
        a.totalPaid,
        i + 1,
      ]),
    );
  };
  const exportTeamReport = () => {
    downloadCsv(
      "team-performance-report.csv",
      ["Team", "Count of Loan ID", "Sum of POS", `Sum of ${todayLabel}`, "Sum of Total Paid"],
      [["Collections Team A", teamCount, teamPOS, teamPaidToday, teamTotalPaid]],
    );
  };
  const exportMonthlyTrend = () => {
    const agentNames = agents.map((a) => a.name);
    downloadCsv(
      "monthly-trend.csv",
      ["Month", ...agentNames, "Team Total"],
      monthlyTrend.map((row) => [
        row.month,
        ...agentNames.map((n) => row[n] ?? 0),
        agentNames.reduce((s, n) => s + Number(row[n] ?? 0), 0),
      ]),
    );
  };

  return (
    <div className="space-y-5">
      {/* Team strip: generation + projection */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          {
            label: "Today's Generation",
            value: formatINR(teamPTPToday),
            hint: "team PTP committed today",
            icon: HandCoins,
            cls: "text-blue-500",
          },
          {
            label: "Projected Recovery",
            value: formatINR(teamProjection),
            hint: "PTP + collected today",
            icon: TrendingUp,
            cls: "text-success",
          },
          {
            label: "Collected Today",
            value: formatINR(teamPaidToday),
            hint: "across the team",
            icon: IndianRupee,
            cls: "text-foreground",
          },
          {
            label: "Total Paid (all-time)",
            value: formatINR(teamTotalPaid),
            hint: "since go-live",
            icon: FileBarChart2,
            cls: "text-foreground",
          },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {s.label}
                </span>
                <s.icon className="h-3.5 w-3.5 text-muted-foreground/50" />
              </div>
              <div className={cn("text-lg font-bold tabular-nums", s.cls)}>{s.value}</div>
              <div className="text-[10px] text-muted-foreground">{s.hint}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Employee performance report */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Employee Performance Report
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={exportEmployeeReport}
            >
              <FileDown className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="py-2 pl-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Employee
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Count of Loan ID
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Sum of POS
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Sum of {todayLabel}
                  </th>
                  <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Sum of Total Paid
                  </th>
                  <th className="py-2 pr-4 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-20">
                    Rank
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((a, i) => {
                  const { bg, fg } = rankColor(i + 1, sorted.length);
                  return (
                    <tr key={a.id} className="hover:bg-muted/20 transition-colors">
                      <td className="py-3 pl-4 font-medium text-foreground">{a.name}</td>
                      <td className="py-3 text-right tabular-nums">{a.assignedCount}</td>
                      <td className="py-3 text-right tabular-nums">{formatINR(a.assignedPOS)}</td>
                      <td className="py-3 text-right tabular-nums">{formatINR(a.paidToday)}</td>
                      <td className="py-3 text-right tabular-nums font-semibold">
                        {formatINR(a.totalPaid)}
                      </td>
                      <td className="py-3 pr-4 text-center">
                        <span
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold"
                          style={{ background: bg, color: fg }}
                        >
                          {i + 1}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/10 font-semibold">
                  <td className="py-2.5 pl-4 text-foreground">Team Total</td>
                  <td className="py-2.5 text-right tabular-nums">{teamCount}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatINR(teamPOS)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatINR(teamPaidToday)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatINR(teamTotalPaid)}</td>
                  <td className="py-2.5 pr-4" />
                </tr>
              </tfoot>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Team report (single-row rollup, separately exportable) */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Team roll-up above · exported separately for management reporting
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          onClick={exportTeamReport}
        >
          <FileDown className="h-3.5 w-3.5" />
          Export Team Report
        </Button>
      </div>

      {/* Monthly trend */}
      <Card>
        <CardHeader className="border-b border-border pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Monthly Trend — Total Paid per Employee
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={exportMonthlyTrend}
            >
              <FileDown className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {monthlyTrend.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              No paid dispositions logged yet — this chart fills in as agents log real collections
              across months.
            </p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={monthlyTrend} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                    tickFormatter={(v) => formatINR(v)}
                  />
                  <Tooltip {...TOOLTIP} formatter={(v: number) => formatINR(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {agents.map((a, i) => (
                    <Line
                      key={a.id}
                      type="monotone"
                      dataKey={a.name}
                      stroke={
                        ["oklch(0.58 0.18 258)", "oklch(0.65 0.16 152)", "oklch(0.65 0.2 40)"][
                          i % 3
                        ]
                      }
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Trend is built from real logged dispositions — it will be sparse until more months
                of usage accumulate.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function ManagerDashboardPage() {
  const [tick, setTick] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    intervalRef.current = setInterval(() => setTick((t) => t + 1), 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const agents = useManagerTeamAgents(managerId);
  const agentStats = useTeamStats(agents);

  // Real, team-scoped dispositions — replaces the old hardcoded STATS/TREND_DATA/OUTCOMES/
  // ACTIVITY constants. `tick` (30s poll) is in the deps so this recomputes on the same
  // cadence the "Live" badge advertises.
  const teamAgentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const teamDisps = useMemo(
    () => getDispositions().filter((d) => teamAgentIds.has(d.agentId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamAgentIds, tick],
  );
  const todayDisps = useMemo(() => teamDisps.filter((d) => isToday(d.time)), [teamDisps]);
  const todayTeamStats = useMemo(() => calcStats(todayDisps), [todayDisps]);

  const OUTCOME_LABEL: Record<string, string> = {
    paid: "Paid",
    promised: "Promised",
    refused: "Refused",
    no_answer: "No Answer",
    callback: "Callback",
    voicemail: "Voicemail",
    dispute: "Dispute",
    settlement: "Settlement",
  };
  const OUTCOME_COLOR: Record<string, string> = {
    paid: "oklch(0.65 0.16 152)",
    promised: "oklch(0.58 0.18 258)",
    refused: "oklch(0.58 0.22 27)",
    no_answer: "oklch(0.25 0.03 258)",
  };
  const FALLBACK_COLORS = ["oklch(0.6 0.15 300)", "oklch(0.55 0.15 80)", "oklch(0.5 0.1 200)"];
  const outcomeSlices: OutcomeSlice[] = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of todayDisps) counts[d.outcome] = (counts[d.outcome] ?? 0) + 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([outcome, value], i) => ({
        name: OUTCOME_LABEL[outcome] ?? outcome,
        value,
        color: OUTCOME_COLOR[outcome] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length],
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayDisps]);

  const recentActivity = useMemo(
    () => [...teamDisps].sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 12),
    [teamDisps],
  );

  const trendData: TrendPoint[] = useMemo(() => {
    const now = new Date();
    const rows: TrendPoint[] = [];
    for (let day = 1; day <= now.getDate(); day++) {
      const thisD = new Date(now.getFullYear(), now.getMonth(), day);
      const lastD = new Date(now.getFullYear(), now.getMonth() - 1, day);
      rows.push({
        day,
        thisMonth: calcStats(teamDisps.filter((d) => sameCalendarDay(d.time, thisD))).contactRate,
        lastMonth: calcStats(teamDisps.filter((d) => sameCalendarDay(d.time, lastD))).contactRate,
      });
    }
    return rows;
  }, [teamDisps]);

  const teamCallsToday = agentStats.reduce((s, a) => s + a.callsToday, 0);
  const teamTarget = DEFAULT_DAILY_TARGET * Math.max(agents.length, 1);
  const teamPaidToday = agentStats.reduce((s, a) => s + a.paidToday, 0);
  const teamPtpAmountToday = agentStats.reduce((s, a) => s + a.ptpAmountToday, 0);
  const teamOpenEscalations = agentStats.reduce((s, a) => s + a.openEscalations, 0);

  const stats: StatDef[] = [
    {
      label: "Calls Today",
      value: teamCallsToday.toLocaleString("en-IN"),
      hint: `of ${teamTarget.toLocaleString("en-IN")} target`,
      icon: Phone,
      tone: "primary",
    },
    {
      label: "Daily Target",
      value: teamTarget.toLocaleString("en-IN"),
      hint: `${teamCallsToday} / ${teamTarget} completed`,
      icon: Target,
      tone: "muted",
    },
    {
      label: "Contact Rate",
      value: `${todayTeamStats.contactRate}%`,
      hint: "of today's calls connected",
      icon: TrendingUp,
      tone: "success",
    },
    {
      label: "Amount Recovered",
      value: formatINR(teamPaidToday),
      hint: "Today across the team",
      icon: IndianRupee,
      tone: "success",
    },
    {
      label: "PTP Value Today",
      value: formatINR(teamPtpAmountToday),
      hint: `${todayTeamStats.ptps} promise${todayTeamStats.ptps === 1 ? "" : "s"} today`,
      icon: HandCoins,
      tone: "primary",
    },
    {
      label: "Open Escalations",
      value: teamOpenEscalations.toString(),
      hint: "need manager attention",
      icon: Bell,
      tone: teamOpenEscalations > 0 ? "warning" : "muted",
    },
  ];

  const [selectedAgentId, setSelectedAgentId] = useState<string>(agents[0]?.id ?? "");
  useEffect(() => {
    if (!agents.some((a) => a.id === selectedAgentId)) setSelectedAgentId(agents[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  const selectedStat = agentStats.find((a) => a.id === selectedAgentId) ?? agentStats[0];

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Manager Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Team analytics, live per-agent view, and reports.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-medium text-success">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          Live · updates every 30s
          {tick > 0 && <span className="ml-1 text-success/60">(refreshed {tick}×)</span>}
        </div>
      </div>

      <Tabs defaultValue="team" className="w-full">
        <TabsList>
          <TabsTrigger value="team" className="gap-1.5">
            <LayoutDashboard className="h-3.5 w-3.5" />
            Team Analytics
          </TabsTrigger>
          <TabsTrigger value="live" className="gap-1.5">
            <UserCog className="h-3.5 w-3.5" />
            Agent Live View
          </TabsTrigger>
          <TabsTrigger value="reports" className="gap-1.5">
            <FileBarChart2 className="h-3.5 w-3.5" />
            Reports
          </TabsTrigger>
        </TabsList>

        {/* ── Team Analytics ── */}
        <TabsContent value="team" className="space-y-6 mt-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            {stats.map((s, i) => (
              <StatCard key={s.label} stat={s} index={i} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary flex-shrink-0" />
                  Recovery Rate — This Month vs Last Month
                </CardTitle>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Daily recovery rate through this month (solid), overlaid on the same days last
                  month (dashed) for a like-for-like comparison.
                </p>
              </CardHeader>
              <CardContent className="pt-4">
                <RecoveryTrendChart data={trendData} />
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <PieIcon className="h-4 w-4 text-primary" />
                  Today's Outcomes
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {todayDisps.length} calls
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <OutcomesDonut outcomes={outcomeSlices} total={todayDisps.length} />
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-primary" />
                  Agent Leaderboard
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    Real · Total Paid
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <AgentLeaderboard agents={agentStats} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                  </span>
                  Live Activity
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-3 px-3">
                <ActivityFeed recent={recentActivity} />
              </CardContent>
            </Card>
          </div>

          <div>
            <h2 className="mb-3 text-sm font-semibold text-foreground">Agent Activity</h2>
            <AgentAvailabilityGrid agents={agentStats} />
          </div>
        </TabsContent>

        {/* ── Agent Live View ── */}
        <TabsContent value="live" className="space-y-4 mt-4">
          {agents.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              You don't have a team yet — ask an admin to add you to a team in Admin → Teams.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-foreground">Viewing:</span>
                <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                  <SelectTrigger className="h-9 w-64 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {selectedStat && <AgentDashboardView stat={selectedStat} />}
            </>
          )}
        </TabsContent>

        {/* ── Reports ── */}
        <TabsContent value="reports" className="mt-4">
          <ReportsTab agents={agentStats} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
