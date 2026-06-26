import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Download, Mail, BarChart2, Activity, Users, Radio, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard/reports")({
  head: () => ({ meta: [{ title: "Reports · RecoveryAI" }] }),
  component: ReportsPage,
});

type ReportType = "weekly" | "portfolio" | "agent" | "channel" | "dpd";

interface ReportDef {
  id: ReportType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  narrative: string;
  badge?: string;
}

const REPORTS: ReportDef[] = [
  {
    id: "weekly",
    label: "Weekly Summary",
    icon: BarChart2,
    description: "Collections performance across the past 7 days.",
    badge: "Popular",
    narrative: "This week saw a 14% uplift in total collections (₹28.4L vs ₹24.9L last week), driven primarily by the MSME Working Capital portfolio. Contact rate improved to 68% (+3 pts), and PTP-to-payment conversion hit a new high of 41%. Monday and Wednesday remain peak collection days. Recommend increasing agent availability on those days.",
  },
  {
    id: "portfolio",
    label: "Portfolio Health",
    icon: Activity,
    description: "DPD distribution and recovery rates by portfolio.",
    narrative: "Credit Card NPA portfolio shows the highest risk concentration with 38% of accounts above DPD-60. Personal Loan Q1 is tracking well — 72% of accounts below DPD-30. MSME Working Capital has the highest average outstanding (₹6.2L per account) and should be prioritised for senior agent assignment. Recommend escalating Tarun Desai (L-10366) to legal track.",
  },
  {
    id: "agent",
    label: "Agent Performance",
    icon: Users,
    description: "Calls made, PTPs secured, and collections by agent.",
    narrative: "Priya Singh leads with 94 calls and ₹4.8L collected this week, achieving 118% of daily target. Ravi Mehta shows a high call volume but low PTP conversion (12%) — recommend call quality coaching. Three agents are below 60% of their daily target; manager review is advised. Average handle time improved to 4m 22s across the team.",
  },
  {
    id: "channel",
    label: "Channel Effectiveness",
    icon: Radio,
    description: "Response rates across Call, WhatsApp, SMS, and Email.",
    narrative: "WhatsApp is the highest-performing channel with a 54% response rate, followed by direct calls at 38%. SMS response has dropped 6 pts to 11% — possibly due to DLT template delays. Email remains low at 4%. For high-score (8+) debtors, WhatsApp outreach 2 hours before the call improves pick-up rate by 22%. Recommend leading with WhatsApp for all fresh contacts.",
  },
  {
    id: "dpd",
    label: "DPD Bucket Movement",
    icon: TrendingUp,
    description: "How accounts move between DPD bands month on month.",
    narrative: "Net migration into DPD-60+ reduced by 18% this month, indicating improved early intervention. 43 accounts rolled back from DPD-31-60 to DPD-0-30 following targeted outreach campaigns. However, 12 accounts migrated from DPD-60-90 to 90+ — legal notices are recommended. The early-stage (0-30 DPD) bucket grew 8%, suggesting new disbursement inflows from lender partners.",
  },
];

const CHART_COLORS = { primary: "oklch(0.58 0.18 258)", success: "oklch(0.65 0.16 152)", warning: "oklch(0.72 0.18 75)", destructive: "oklch(0.58 0.22 27)", muted: "oklch(0.25 0.03 258)" };

const WEEKLY_DATA = [
  { day: "Mon", collected: 420000, calls: 92, ptps: 18 },
  { day: "Tue", collected: 310000, calls: 78, ptps: 12 },
  { day: "Wed", collected: 540000, calls: 105, ptps: 24 },
  { day: "Thu", collected: 280000, calls: 70, ptps: 9 },
  { day: "Fri", collected: 490000, calls: 98, ptps: 21 },
  { day: "Sat", collected: 190000, calls: 45, ptps: 7 },
  { day: "Sun", collected: 110000, calls: 22, ptps: 3 },
];

const PORTFOLIO_DATA = [
  { name: "Personal Loan Q1", dpdBelow30: 72, dpd3160: 18, dpdAbove60: 10 },
  { name: "Two-Wheeler Auto", dpdBelow30: 65, dpd3160: 22, dpdAbove60: 13 },
  { name: "Credit Card NPA", dpdBelow30: 28, dpd3160: 34, dpdAbove60: 38 },
  { name: "MSME Working Cap", dpdBelow30: 48, dpd3160: 28, dpdAbove60: 24 },
];

const AGENT_DATA = [
  { name: "Priya Singh", calls: 94, ptps: 31, collected: 480000 },
  { name: "Ravi Mehta", calls: 88, ptps: 11, collected: 220000 },
  { name: "Sonal Desai", calls: 76, ptps: 22, collected: 310000 },
  { name: "Mohit Rao", calls: 65, ptps: 19, collected: 275000 },
  { name: "Leena K.", calls: 58, ptps: 14, collected: 190000 },
];

const CHANNEL_DATA = [
  { channel: "WhatsApp", rate: 54 },
  { channel: "Call", rate: 38 },
  { channel: "SMS", rate: 11 },
  { channel: "Email", rate: 4 },
];

const DPD_DATA = [
  { month: "Mar", "0-30": 380, "31-60": 120, "61-90": 65, "90+": 40 },
  { month: "Apr", "0-30": 360, "31-60": 135, "61-90": 70, "90+": 45 },
  { month: "May", "0-30": 390, "31-60": 110, "61-90": 58, "90+": 42 },
  { month: "Jun", "0-30": 421, "31-60": 98, "61-90": 51, "90+": 35 },
];

function renderChart(id: ReportType) {
  const tProps = {
    contentStyle: { background: "oklch(0.15 0.025 258)", border: "1px solid oklch(0.25 0.03 258)", borderRadius: 6, fontSize: 11 },
    labelStyle: { color: "oklch(0.96 0.005 250)" },
    itemStyle: { color: "oklch(0.85 0.01 250)" },
  };
  if (id === "weekly") return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={WEEKLY_DATA} barGap={4}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} />
        <XAxis dataKey="day" tick={{ fontSize: 11, fill: "oklch(0.55 0.02 257)" }} />
        <YAxis tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }} tickFormatter={(v) => `₹${(v / 100000).toFixed(1)}L`} />
        <Tooltip {...tProps} formatter={(v: number) => [`₹${(v / 100000).toFixed(2)}L`, "Collected"]} />
        <Bar dataKey="collected" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
  if (id === "portfolio") return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={PORTFOLIO_DATA} layout="vertical" barSize={14} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }} tickFormatter={(v) => `${v}%`} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }} width={120} />
        <Tooltip {...tProps} formatter={(v: number) => [`${v}%`]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="dpdBelow30" name="0-30 DPD" stackId="a" fill={CHART_COLORS.success} />
        <Bar dataKey="dpd3160" name="31-60 DPD" stackId="a" fill={CHART_COLORS.warning} />
        <Bar dataKey="dpdAbove60" name="60+ DPD" stackId="a" fill={CHART_COLORS.destructive} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
  if (id === "agent") return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={AGENT_DATA} barGap={4}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} />
        <XAxis dataKey="name" tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }} />
        <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }} tickFormatter={(v) => `₹${(v / 100000).toFixed(1)}L`} />
        <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }} />
        <Tooltip {...tProps} />
        <Bar yAxisId="left" dataKey="collected" name="Collected" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} />
        <Bar yAxisId="right" dataKey="calls" name="Calls" fill={CHART_COLORS.success} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
  if (id === "channel") return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={CHANNEL_DATA} dataKey="rate" nameKey="channel" cx="50%" cy="50%" outerRadius={100} label={({ channel, rate }) => `${channel} ${rate}%`} labelLine={false}>
          {CHANNEL_DATA.map((_, i) => (
            <Cell key={i} fill={[CHART_COLORS.success, CHART_COLORS.primary, CHART_COLORS.warning, CHART_COLORS.muted][i]} />
          ))}
        </Pie>
        <Tooltip {...tProps} formatter={(v: number) => [`${v}%`, "Response Rate"]} />
      </PieChart>
    </ResponsiveContainer>
  );
  if (id === "dpd") return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={DPD_DATA}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.muted} />
        <XAxis dataKey="month" tick={{ fontSize: 11, fill: "oklch(0.55 0.02 257)" }} />
        <YAxis tick={{ fontSize: 10, fill: "oklch(0.55 0.02 257)" }} />
        <Tooltip {...tProps} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Area type="monotone" dataKey="0-30" stackId="1" stroke={CHART_COLORS.success} fill={`${CHART_COLORS.success}40`} />
        <Area type="monotone" dataKey="31-60" stackId="1" stroke={CHART_COLORS.warning} fill={`${CHART_COLORS.warning}40`} />
        <Area type="monotone" dataKey="61-90" stackId="1" stroke={CHART_COLORS.destructive} fill={`${CHART_COLORS.destructive}30`} />
        <Area type="monotone" dataKey="90+" stackId="1" stroke="oklch(0.45 0.2 27)" fill="oklch(0.45 0.2 27 / 20%)" />
      </AreaChart>
    </ResponsiveContainer>
  );
  return null;
}

function ReportsPage() {
  const [active, setActive] = useState<ReportType>("weekly");
  const [fromDate, setFromDate] = useState("2026-06-16");
  const [toDate, setToDate] = useState("2026-06-22");

  const report = REPORTS.find((r) => r.id === active)!;

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Reports</h1>
        <p className="text-sm text-muted-foreground">AI-generated summaries and operational insights.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
        {/* Report list */}
        <div className="space-y-2">
          {REPORTS.map((r, i) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setActive(r.id)}
              className={cn(
                "animate-in fade-in slide-in-from-left-4 duration-500 fill-mode-both",
                "w-full text-left rounded-lg border p-3 transition-all duration-150",
                active === r.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-foreground hover:border-primary/40 hover:bg-accent",
              )}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center gap-2">
                <r.icon className="h-4 w-4 flex-shrink-0" />
                <span className="text-sm font-medium">{r.label}</span>
                {r.badge && <Badge variant="secondary" className="ml-auto text-[10px] py-0">{r.badge}</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground leading-snug">{r.description}</p>
            </button>
          ))}
        </div>

        {/* Preview panel */}
        <Card className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <CardHeader className="border-b border-border">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <report.icon className="h-4 w-4 text-primary" />
                  {report.label}
                </CardTitle>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="from" className="text-xs text-muted-foreground">From</Label>
                  <Input id="from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 w-36 text-xs" />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor="to" className="text-xs text-muted-foreground">To</Label>
                  <Input id="to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-8 w-36 text-xs" />
                </div>
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs transition-all active:scale-95" onClick={() => toast.success("Report exported as Excel")}>
                  <Download className="h-3.5 w-3.5" />Excel
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs transition-all active:scale-95" onClick={() => toast.success("Report emailed to your registered address")}>
                  <Mail className="h-3.5 w-3.5" />Email
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4 space-y-4">
            {/* AI narrative */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
              <p className="text-xs font-medium text-primary mb-1">AI Summary</p>
              <p className="text-sm text-foreground/90 leading-relaxed">{report.narrative}</p>
            </div>
            {/* Chart */}
            <div className="pt-2">
              {renderChart(active)}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
