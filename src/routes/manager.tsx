import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Phone,
  Target,
  TrendingUp,
  TrendingDown,
  IndianRupee,
  PieChart as PieIcon,
  Users,
  Bell,
  FileBarChart,
  Activity,
  CheckCircle2,
  Clock,
  XCircle,
  PhoneOff,
  CreditCard,
  MessageCircle,
  Zap,
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
  defs,
  linearGradient,
  stop,
  AreaChart,
  Area,
} from "recharts";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/manager")({
  head: () => ({
    meta: [
      { title: "Analytics · RecoveryAI" },
      { name: "description", content: "Manager analytics dashboard for RecoveryAI collections platform." },
    ],
  }),
  component: ManagerPage,
});

/* ─── mock data ─────────────────────────────────────────────────────────── */

const STATS = [
  { label: "Calls Today", value: "847", hint: "+12% vs yesterday", icon: Phone, tone: "primary" },
  { label: "Daily Target", value: "1,000", hint: "847 / 1,000 completed", icon: Target, tone: "muted" },
  { label: "Recovery Rate", value: "38.4%", hint: "+2.1 pts this week", icon: TrendingUp, tone: "success", trend: "up" },
  { label: "Amount Recovered", value: "₹28.4L", hint: "Today across all agents", icon: IndianRupee, tone: "success" },
  { label: "Portfolio Coverage", value: "61.2%", hint: "Accounts contacted", icon: PieIcon, tone: "primary" },
  { label: "Pending Follow-ups", value: "214", hint: "Due before EOD", icon: Bell, tone: "warning" },
];

// 30-day recovery rate trend
const buildTrend = () =>
  Array.from({ length: 30 }, (_, i) => ({
    day: i + 1,
    thisMonth: +(32 + Math.sin(i / 3) * 4 + i * 0.22 + Math.random() * 2).toFixed(1),
    lastMonth: +(28 + Math.sin(i / 3.5) * 3 + i * 0.12 + Math.random() * 2).toFixed(1),
  }));

const TREND_DATA = buildTrend();

const OUTCOMES = [
  { name: "Paid", value: 124, color: "oklch(0.65 0.16 152)" },
  { name: "Promised", value: 213, color: "oklch(0.58 0.18 258)" },
  { name: "Refused", value: 87, color: "oklch(0.58 0.22 27)" },
  { name: "No Answer", value: 318, color: "oklch(0.25 0.03 258)" },
  { name: "Other", value: 105, color: "oklch(0.22 0.04 258)" },
];
const OUTCOMES_TOTAL = OUTCOMES.reduce((s, o) => s + o.value, 0);

const AGENTS = [
  { name: "Priya Singh", calls: 112, target: 100, contactRate: 74, recovered: 520000 },
  { name: "Ravi Mehta", calls: 98, target: 100, contactRate: 61, recovered: 310000 },
  { name: "Sonal Desai", calls: 91, target: 100, contactRate: 68, recovered: 290000 },
  { name: "Mohit Rao", calls: 84, target: 100, contactRate: 55, recovered: 240000 },
  { name: "Leena Krishnan", calls: 76, target: 100, contactRate: 52, recovered: 195000 },
  { name: "Tarun Bose", calls: 68, target: 100, contactRate: 48, recovered: 160000 },
];

const ACTIVITY: { icon: typeof CheckCircle2; color: string; text: string; ago: string }[] = [
  { icon: CheckCircle2, color: "text-success", text: "Rahul Sharma paid ₹45,000 via UPI link", ago: "2m ago" },
  { icon: MessageCircle, color: "text-primary", text: "Priya Bot secured PTP from Amit Verma · ₹1.25L by Fri", ago: "5m ago" },
  { icon: CreditCard, color: "text-success", text: "eNACH auto-collected ₹8,200 from Divya Krishnan", ago: "9m ago" },
  { icon: Phone, color: "text-primary", text: "Ravi Mehta connected with Sandeep Yadav after 4 attempts", ago: "14m ago" },
  { icon: XCircle, color: "text-destructive", text: "Tarun Desai dispute escalated to legal track", ago: "18m ago" },
  { icon: Zap, color: "text-warning-foreground", text: "AI scored 210 new accounts in Personal Loan Q1", ago: "22m ago" },
  { icon: CheckCircle2, color: "text-success", text: "Ananya Bose settled ₹1,78,000 — full & final", ago: "31m ago" },
  { icon: Clock, color: "text-muted-foreground", text: "Mohit Rao PTP callback scheduled for Pooja Bhatt 4 PM", ago: "38m ago" },
  { icon: MessageCircle, color: "text-primary", text: "WhatsApp campaign sent to 84 DPD-31-60 debtors", ago: "45m ago" },
  { icon: PhoneOff, color: "text-muted-foreground", text: "12 accounts marked unreachable — re-queue tomorrow", ago: "52m ago" },
  { icon: IndianRupee, color: "text-success", text: "Vikram Singh partial payment ₹15,000 received", ago: "1h ago" },
  { icon: Activity, color: "text-primary", text: "Daily target reached for Credit Card NPA portfolio", ago: "1h 10m ago" },
];

const REPORT_CARDS = [
  { label: "Weekly Summary", desc: "7-day collections, calls and PTP stats.", icon: FileBarChart },
  { label: "Portfolio Health", desc: "DPD bucket distribution by portfolio.", icon: Activity },
  { label: "Agent Performance", desc: "Calls, conversions and recovery by agent.", icon: Users },
  { label: "Channel Effectiveness", desc: "Response rates across all contact channels.", icon: MessageCircle },
];

const RANK_STYLE: Record<number, string> = {
  0: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40 shadow-sm shadow-yellow-500/20",
  1: "bg-slate-400/20 text-slate-300 border-slate-400/40",
  2: "bg-orange-700/20 text-orange-400 border-orange-700/40",
};

const RANK_LABEL: Record<number, string> = { 0: "1st", 1: "2nd", 2: "3rd" };

/* ─── tooltip styles ─────────────────────────────────────────────────────── */
const TOOLTIP = {
  contentStyle: {
    background: "oklch(0.15 0.025 258)",
    border: "1px solid oklch(0.25 0.03 258)",
    borderRadius: 6,
    fontSize: 11,
  },
  labelStyle: { color: "oklch(0.96 0.005 250)" },
  itemStyle: { color: "oklch(0.85 0.01 250)" },
};

/* ─── helpers ────────────────────────────────────────────────────────────── */
function formatINR(n: number) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

/* ─── sub-components ─────────────────────────────────────────────────────── */

function StatCard({
  stat,
  index,
}: {
  stat: (typeof STATS)[number];
  index: number;
}) {
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
            <span className={cn("mb-0.5", stat.trend === "up" ? "text-success" : "text-destructive")}>
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

function RecoveryTrendChart() {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={TREND_DATA} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
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
        <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.25 0.03 258)" />
        <XAxis
          dataKey="day"
          tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }}
          tickFormatter={(v) => `D${v}`}
          interval={4}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }}
          tickFormatter={(v) => `${v}%`}
          domain={[20, 50]}
        />
        <Tooltip
          {...TOOLTIP}
          formatter={(v: number, name: string) => [
            `${v}%`,
            name === "thisMonth" ? "This Month" : "Last Month",
          ]}
          labelFormatter={(d) => `Day ${d}`}
        />
        <Legend
          formatter={(v) => (v === "thisMonth" ? "This Month" : "Last Month")}
          wrapperStyle={{ fontSize: 11, color: "oklch(0.85 0.01 250)" }}
        />
        <Area
          type="monotone"
          dataKey="lastMonth"
          stroke="oklch(0.40 0.02 258)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          fill="url(#lastMonthGrad)"
          dot={false}
          activeDot={{ r: 4 }}
        />
        <Area
          type="monotone"
          dataKey="thisMonth"
          stroke="oklch(0.58 0.18 258)"
          strokeWidth={2}
          fill="url(#thisMonthGrad)"
          dot={false}
          activeDot={{ r: 5, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function OutcomesDonut() {
  return (
    <div className="flex flex-col gap-3">
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie
            data={OUTCOMES}
            cx="50%"
            cy="50%"
            innerRadius={52}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
            strokeWidth={0}
          >
            {OUTCOMES.map((o, i) => (
              <Cell key={i} fill={o.color} />
            ))}
          </Pie>
          <Tooltip
            {...TOOLTIP}
            formatter={(v: number, name: string) => [
              `${v} (${((v / OUTCOMES_TOTAL) * 100).toFixed(1)}%)`,
              name,
            ]}
          />
        </PieChart>
      </ResponsiveContainer>
      {/* Legend */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-1">
        {OUTCOMES.map((o) => (
          <div key={o.name} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: o.color }} />
            <span className="text-xs text-muted-foreground">
              {o.name}{" "}
              <span className="text-foreground font-medium">
                {o.value}
              </span>{" "}
              <span className="text-[10px]">
                ({((o.value / OUTCOMES_TOTAL) * 100).toFixed(0)}%)
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentLeaderboard() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-2 pl-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground w-12">Rank</th>
            <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">Agent</th>
            <th className="pb-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground min-w-[140px]">Calls vs Target</th>
            <th className="pb-2 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">Contact %</th>
            <th className="pb-2 pr-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">Recovered</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {AGENTS.map((a, i) => (
            <tr
              key={a.name}
              className={cn(
                "animate-in fade-in duration-300 fill-mode-both transition-colors hover:bg-primary/5",
                i === 0 && "bg-yellow-500/5 hover:bg-yellow-500/10",
              )}
              style={{ animationDelay: `${400 + i * 60}ms` }}
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
                  className={cn(
                    "font-medium",
                    i === 0 ? "text-yellow-400" : "text-foreground",
                  )}
                >
                  {a.name}
                </span>
              </td>
              <td className="py-3 pr-4">
                <div className="flex items-center gap-2">
                  <Progress
                    value={Math.min((a.calls / a.target) * 100, 100)}
                    className="h-1.5 flex-1"
                  />
                  <span className="text-xs text-muted-foreground w-16 flex-shrink-0">
                    {a.calls}/{a.target}
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
                {formatINR(a.recovered)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityFeed() {
  return (
    <ScrollArea className="h-[320px] pr-1">
      <div className="space-y-0.5">
        {ACTIVITY.map((a, i) => (
          <div
            key={i}
            className="animate-in fade-in duration-300 fill-mode-both flex gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent/50"
            style={{ animationDelay: `${500 + i * 40}ms` }}
          >
            <a.icon className={cn("h-4 w-4 mt-0.5 flex-shrink-0", a.color)} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-foreground leading-snug">{a.text}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{a.ago}</p>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function ManagerPage() {
  const [tick, setTick] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => setTick((t) => t + 1), 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header + live bar */}
        <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Analytics</h1>
            <p className="text-sm text-muted-foreground">
              Live operations overview for your collections team.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-medium text-success">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Live · updates every 30s
            {tick > 0 && (
              <span className="ml-1 text-success/60">(refreshed {tick}×)</span>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {STATS.map((s, i) => (
            <StatCard key={s.label} stat={s} index={i} />
          ))}
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* Recovery rate trend — 60% */}
          <Card className="animate-in fade-in slide-in-from-bottom-4 duration-600 delay-200 lg:col-span-3">
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                Recovery Rate Trend — Last 30 Days
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <RecoveryTrendChart />
            </CardContent>
          </Card>

          {/* Today's outcomes donut — 40% */}
          <Card className="animate-in fade-in slide-in-from-bottom-4 duration-600 delay-300 lg:col-span-2">
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <PieIcon className="h-4 w-4 text-primary" />
                Today's Outcomes
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {OUTCOMES_TOTAL} calls
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <OutcomesDonut />
            </CardContent>
          </Card>
        </div>

        {/* Leaderboard + activity feed */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
          {/* Leaderboard */}
          <Card className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                Agent Leaderboard
                <Badge variant="secondary" className="ml-auto text-[10px]">
                  Today
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <AgentLeaderboard />
            </CardContent>
          </Card>

          {/* Activity feed */}
          <Card className="animate-in fade-in slide-in-from-right-4 duration-500 delay-300">
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
              <ActivityFeed />
            </CardContent>
          </Card>
        </div>

        {/* Report cards */}
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 delay-300">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Generate Reports</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {REPORT_CARDS.map((r, i) => (
              <Card
                key={r.label}
                className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both transition-all duration-200 hover:shadow-lg hover:shadow-primary/10 hover:-translate-y-0.5"
                style={{ animationDelay: `${600 + i * 60}ms` }}
              >
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <r.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{r.label}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.desc}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-auto h-8 text-xs transition-all active:scale-95"
                    onClick={() =>
                      toast.success(
                        `Report generation started · will email you in 2 minutes`,
                        { description: r.label },
                      )
                    }
                  >
                    Generate
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
