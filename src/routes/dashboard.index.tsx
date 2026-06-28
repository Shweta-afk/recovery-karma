import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useRef, useEffect } from "react";
import {
  PhoneCall,
  PhoneIncoming,
  HandCoins,
  IndianRupee,
  CheckCircle2,
  Phone,
  Clock,
  Coffee,
  FileText,
  Wifi,
  WifiOff,
  ZapOff,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Users,
  CalendarClock,
  BotMessageSquare,
  Radio,
  UserRound,
  Layers,
  Tractor,
  MessageSquare,
  PhoneOff,
  PhoneMissed,
  Activity,
  SkipForward,
  MessageCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { MOCK_DEBTORS, bucketOf, formatINR, type Debtor } from "@/lib/mock-debtors";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Agent Dashboard · RecoveryAI" },
      { name: "description", content: "Agent dashboard with KPIs, call queue, AI bot activity, and time tracking." },
    ],
  }),
  component: AgentDashboard,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type CallingMode = "agent" | "hybrid" | "field";
type CallOutcome = "paid" | "promised" | "refused" | "no_answer" | "callback" | "voicemail";
type SortKey = "time" | "debtorName" | "duration" | "outcome";
type SortDir = "asc" | "desc";

// ─── Mock data ────────────────────────────────────────────────────────────────

const KPI_DATA = {
  // Row 1 — performance
  totalCalling: 47,
  totalCallback: 8,
  todayPTP: 14,
  totalPTPAmount: 245000,
  todayPaid: 6,
  todayPaidAmount: 48500,
  // Row 2 — queue
  totalDebtors: 120,
  followupDebtors: 38,
  ptpDebtors: 22,
};

const CALL_INTENSITY: {
  hour: string; calls: number; connected: number; ptps: number; lastFollowup: string | null;
}[] = [
  { hour: "09:00", calls: 6, connected: 4, ptps: 2, lastFollowup: "22 Jun 09:48" },
  { hour: "10:00", calls: 9, connected: 7, ptps: 3, lastFollowup: "22 Jun 10:52" },
  { hour: "11:00", calls: 8, connected: 5, ptps: 2, lastFollowup: "22 Jun 11:41" },
  { hour: "12:00", calls: 3, connected: 2, ptps: 1, lastFollowup: "22 Jun 12:18" },
  { hour: "13:00", calls: 1, connected: 0, ptps: 0, lastFollowup: null },
  { hour: "14:00", calls: 8, connected: 6, ptps: 3, lastFollowup: "22 Jun 14:55" },
  { hour: "15:00", calls: 7, connected: 4, ptps: 2, lastFollowup: "22 Jun 15:47" },
  { hour: "16:00", calls: 5, connected: 3, ptps: 1, lastFollowup: "22 Jun 16:33" },
];

// AI queue — live bot activity
const AI_QUEUE = [
  { id: "AI-001", debtorName: "Rakesh Tiwari",  loanId: "L-10712", phone: "+91 90XXX XX311", status: "in_call",  duration: "2m 14s", outcome: null,       lastMsg: "Bot playing payment reminder script" },
  { id: "AI-002", debtorName: "Sunita Rao",      loanId: "L-10544", phone: "+91 98XXX XX901", status: "waiting", duration: "—",       outcome: null,       lastMsg: "Queued — ringing in 12s" },
  { id: "AI-003", debtorName: "Firoz Khan",      loanId: "L-10388", phone: "+91 91XXX XX220", status: "done",    duration: "1m 55s", outcome: "promised",  lastMsg: "PTP captured: ₹12,000 by 25 Jun" },
  { id: "AI-004", debtorName: "Lalitha Devi",    loanId: "L-10631", phone: "+91 97XXX XX540", status: "done",    duration: "0m 41s", outcome: "no_answer", lastMsg: "No answer — retrying in 2h" },
  { id: "AI-005", debtorName: "Hemant Sharma",   loanId: "L-10290", phone: "+91 99XXX XX174", status: "in_call",  duration: "0m 38s", outcome: null,       lastMsg: "Detecting language — switching to Hindi" },
  { id: "AI-006", debtorName: "Geetha Pillai",   loanId: "L-10457", phone: "+91 98XXX XX602", status: "escalated", duration: "3m 02s", outcome: null,     lastMsg: "Escalated to agent — debtor requested human" },
];

const AI_STATS = {
  callsHandled: 28,
  inCall: 2,
  ptpsCaptured: 9,
  ptpAmount: 148000,
  escalated: 3,
  noAnswer: 11,
};

interface CallRecord {
  id: string; debtorName: string; loanId: string; phone: string;
  time: string; duration: string; durationSecs: number;
  outcome: CallOutcome; ptpAmount: number | null; ptpDate: string | null; notes: string;
}

const CALL_RECORDS: CallRecord[] = [
  { id: "C-001", debtorName: "Rahul Sharma",  loanId: "L-10042", phone: "+91 98XXX XX789", time: "09:02", duration: "4m 22s", durationSecs: 262, outcome: "promised",  ptpAmount: 8200,  ptpDate: "25 Jun", notes: "Will pay by EOD Friday via UPI" },
  { id: "C-002", debtorName: "Priya Iyer",    loanId: "L-10018", phone: "+91 90XXX XX221", time: "09:18", duration: "6m 10s", durationSecs: 370, outcome: "paid",      ptpAmount: null,  ptpDate: null,     notes: "Payment received ₹8,200 during call" },
  { id: "C-003", debtorName: "Amit Verma",    loanId: "L-10211", phone: "+91 99XXX XX104", time: "09:35", duration: "0m 45s", durationSecs: 45,  outcome: "no_answer", ptpAmount: null,  ptpDate: null,     notes: "Phone rang, no pickup" },
  { id: "C-004", debtorName: "Sneha Reddy",   loanId: "L-10087", phone: "+91 97XXX XX556", time: "09:51", duration: "3m 05s", durationSecs: 185, outcome: "callback",  ptpAmount: null,  ptpDate: "22 Jun", notes: "Asked to call after 6 PM" },
  { id: "C-005", debtorName: "Vikram Singh",  loanId: "L-10309", phone: "+91 98XXX XX012", time: "10:08", duration: "8m 41s", durationSecs: 521, outcome: "refused",   ptpAmount: null,  ptpDate: null,     notes: "Says payment already made, verify" },
  { id: "C-006", debtorName: "Ananya Bose",   loanId: "L-10455", phone: "+91 91XXX XX334", time: "10:22", duration: "5m 18s", durationSecs: 318, outcome: "promised",  ptpAmount: 15000, ptpDate: "24 Jun", notes: "Salary on 24th, will pay immediately" },
  { id: "C-007", debtorName: "Meera Joshi",   loanId: "L-10277", phone: "+91 98XXX XX670", time: "10:52", duration: "7m 15s", durationSecs: 435, outcome: "paid",      ptpAmount: null,  ptpDate: null,     notes: "Full EMI settled via Razorpay link" },
  { id: "C-008", debtorName: "Divya Krishnan",loanId: "L-10333", phone: "+91 97XXX XX115", time: "11:14", duration: "4m 50s", durationSecs: 290, outcome: "promised",  ptpAmount: 27500, ptpDate: "23 Jun", notes: "Has cash in hand, will transfer tonight" },
  { id: "C-009", debtorName: "Manish Gupta",  loanId: "L-10145", phone: "+91 97XXX XX461", time: "12:05", duration: "3m 47s", durationSecs: 227, outcome: "promised",  ptpAmount: 9500,  ptpDate: "25 Jun", notes: "Extension approved, new date set" },
  { id: "C-010", debtorName: "Arjun Kapoor",  loanId: "L-10068", phone: "+91 91XXX XX833", time: "14:03", duration: "5m 55s", durationSecs: 355, outcome: "paid",      ptpAmount: null,  ptpDate: null,     notes: "Paid 2 EMIs together via NEFT" },
];

const TIME_TRACKING = {
  ringing: 72, talking: 165, breakTime: 45, feedback: 38, idle: 82, online: 78,
};
const TOTAL_SHIFT_MINS = Object.values(TIME_TRACKING).reduce((a, b) => a + b, 0);

// ─── Calling mode config ──────────────────────────────────────────────────────

const MODES: { id: CallingMode; label: string; desc: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "agent",  label: "Agent Mode",         desc: "Human agents only",               icon: UserRound },
  { id: "hybrid", label: "Hybrid (AI + Agent)", desc: "AI bot + human agents together", icon: Layers },
  { id: "field",  label: "Agent + AI + Field",  desc: "Agents, AI bot & field team",    icon: Tractor },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMins(mins: number) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

const OUTCOME_META: Record<CallOutcome, { label: string; cls: string }> = {
  paid:      { label: "Paid",      cls: "bg-success/15 text-success border-success/30" },
  promised:  { label: "PTP",       cls: "bg-blue-500/15 text-blue-600 border-blue-400/30" },
  refused:   { label: "Refused",   cls: "bg-destructive/15 text-destructive border-destructive/30" },
  no_answer: { label: "No Answer", cls: "bg-muted text-muted-foreground border-border" },
  callback:  { label: "Callback",  cls: "bg-warning/20 text-warning-foreground border-warning/40" },
  voicemail: { label: "Voicemail", cls: "bg-purple-500/15 text-purple-600 border-purple-400/30" },
};

const AI_STATUS_META: Record<string, { label: string; dot: string; cls: string }> = {
  in_call:   { label: "In Call",   dot: "bg-success animate-pulse", cls: "text-success" },
  waiting:   { label: "Queued",    dot: "bg-warning",               cls: "text-warning-foreground" },
  done:      { label: "Done",      dot: "bg-muted-foreground",      cls: "text-muted-foreground" },
  escalated: { label: "Escalated", dot: "bg-destructive",           cls: "text-destructive" },
};

// ─── Main page ────────────────────────────────────────────────────────────────

function AgentDashboard() {
  const [predictiveOnline, setPredictiveOnline] = useState(true);
  const [activeMode, setActiveMode] = useState<CallingMode>("hybrid");
  const [callSearch, setCallSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filteredCalls = useMemo(() => {
    const q = callSearch.trim().toLowerCase();
    let rows = CALL_RECORDS.filter(c =>
      !q || c.debtorName.toLowerCase().includes(q) || c.loanId.toLowerCase().includes(q) || c.outcome.includes(q)
    );
    return [...rows].sort((a, b) => {
      let av: string | number = a.time, bv: string | number = b.time;
      if (sortKey === "debtorName") { av = a.debtorName; bv = b.debtorName; }
      if (sortKey === "duration")   { av = a.durationSecs; bv = b.durationSecs; }
      if (sortKey === "outcome")    { av = a.outcome; bv = b.outcome; }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [callSearch, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  return (
    <div className="space-y-8">

      {/* ── Header ── */}
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Agent Dashboard</h1>
        <p className="text-sm text-muted-foreground">Today's performance overview · 22 Jun 2026</p>
      </div>

      {/* ── Calling Mode + Predictive Status Banner ── */}
      <section className="animate-in fade-in duration-300">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-border bg-card p-4">

          {/* Mode selector */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Active Calling Mode</span>
            <div className="flex gap-2 flex-wrap">
              {MODES.map(m => {
                const Icon = m.icon;
                const isActive = activeMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setActiveMode(m.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium border transition-all duration-150",
                      isActive
                        ? "bg-primary text-primary-foreground border-primary shadow-sm shadow-primary/30"
                        : "bg-muted/50 text-muted-foreground border-border hover:border-primary/40 hover:text-foreground"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {m.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {MODES.find(m => m.id === activeMode)?.desc}
            </p>
          </div>

          {/* Predictive dialer status */}
          <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 self-start sm:self-auto">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Predictive Dialer</span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={cn(
                  "h-2.5 w-2.5 rounded-full flex-shrink-0",
                  predictiveOnline ? "bg-success animate-pulse" : "bg-destructive"
                )} />
                <span className={cn(
                  "text-sm font-semibold",
                  predictiveOnline ? "text-success" : "text-destructive"
                )}>
                  {predictiveOnline ? "Online" : "Offline"}
                </span>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs ml-2"
              onClick={() => setPredictiveOnline(v => !v)}
            >
              {predictiveOnline ? <WifiOff className="h-3.5 w-3.5 mr-1" /> : <Wifi className="h-3.5 w-3.5 mr-1" />}
              {predictiveOnline ? "Stop" : "Start"}
            </Button>
          </div>
        </div>
      </section>

      {/* ── KPI Row 1: Performance ── */}
      <section>
        <SectionLabel>Performance · Today</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KPICard label="Total Calling"    value={KPI_DATA.totalCalling.toString()}       hint="Dials today"           icon={PhoneCall}    tone="neutral" index={0} />
          <KPICard label="Total Callback"   value={KPI_DATA.totalCallback.toString()}      hint="Scheduled"            icon={PhoneIncoming} tone="warning" index={1} />
          <KPICard label="Today PTP"        value={KPI_DATA.todayPTP.toString()}           hint="Promises to pay"      icon={HandCoins}    tone="info"    index={2} />
          <KPICard label="Total PTP Amount" value={formatINR(KPI_DATA.totalPTPAmount)}     hint="Committed today"      icon={IndianRupee}  tone="info"    index={3} />
          <KPICard label="Today Paid"       value={`${KPI_DATA.todayPaid} calls`}          hint={formatINR(KPI_DATA.todayPaidAmount) + " collected"} icon={CheckCircle2} tone="success" index={4} />
        </div>
      </section>

      {/* ── KPI Row 2: Queue Overview ── */}
      <section>
        <SectionLabel>Queue Overview</SectionLabel>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <QueueCard
            label="Total Debtors"
            value={KPI_DATA.totalDebtors}
            sub="in today's queue"
            icon={Users}
            color="text-foreground"
            bg="bg-muted/40"
            index={0}
          />
          <QueueCard
            label="Follow-up Debtors"
            value={KPI_DATA.followupDebtors}
            sub="pending callbacks & retries"
            icon={CalendarClock}
            color="text-warning-foreground"
            bg="bg-warning/10"
            index={1}
          />
          <QueueCard
            label="PTP Debtors"
            value={KPI_DATA.ptpDebtors}
            sub="active promise-to-pay"
            icon={HandCoins}
            color="text-blue-600"
            bg="bg-blue-500/10"
            index={2}
          />
        </div>
      </section>

      {/* ── Call Intensity ── */}
      <section>
        <SectionLabel>Call Intensity · Hourly Breakdown</SectionLabel>
        <Card className="mt-3 animate-in fade-in duration-500 delay-200">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Hour</TableHead>
                    <TableHead>Intensity</TableHead>
                    <TableHead className="text-center w-24">Calls</TableHead>
                    <TableHead className="text-center w-24">Connected</TableHead>
                    <TableHead className="text-center w-20">PTPs</TableHead>
                    <TableHead className="w-44">Last Followup</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {CALL_INTENSITY.map(row => {
                    const pct = Math.round((row.calls / 9) * 100);
                    const connPct = Math.round((row.connected / Math.max(row.calls, 1)) * 100);
                    const isLunch = row.hour === "13:00";
                    return (
                      <TableRow key={row.hour} className={cn(isLunch && "opacity-50")}>
                        <TableCell className="font-mono text-sm font-medium">{row.hour}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-3 min-w-[180px]">
                            <Progress value={pct} className="h-2 flex-1" />
                            <span className="text-xs text-muted-foreground w-8 text-right">{pct}%</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-center font-semibold text-foreground">{row.calls}</TableCell>
                        <TableCell className="text-center">
                          <span className={cn("text-sm font-medium",
                            connPct >= 70 ? "text-success" : connPct >= 40 ? "text-warning-foreground" : "text-muted-foreground"
                          )}>
                            {row.connected}
                            <span className="text-[10px] text-muted-foreground ml-1">({connPct}%)</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          {row.ptps > 0
                            ? <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-300/40 text-xs">{row.ptps}</Badge>
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          {row.lastFollowup
                            ? <span className="text-sm text-foreground">{row.lastFollowup}</span>
                            : <span className="text-xs italic text-muted-foreground">{isLunch ? "Lunch break" : "No followup"}</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Call Queue (human agent) ── */}
      <section>
        {/* Headline row with predictive status inline */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <SectionLabel>Call Queue · Today</SectionLabel>
            <div className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
              predictiveOnline
                ? "border-success/40 bg-success/10 text-success"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            )}>
              <span className={cn("h-1.5 w-1.5 rounded-full", predictiveOnline ? "bg-success animate-pulse" : "bg-destructive")} />
              Predictive {predictiveOnline ? "Online" : "Offline"}
            </div>
          </div>
          <span className="text-xs text-muted-foreground">{MOCK_DEBTORS.length} debtors loaded</span>
        </div>

        <Card className="mt-3 animate-in fade-in duration-500 delay-200">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Debtor</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>DPD</TableHead>
                    <TableHead>AI Score</TableHead>
                    <TableHead className="min-w-[200px]">Reason</TableHead>
                    <TableHead>Last Contact</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MOCK_DEBTORS.slice(0, 8).map((d, i) => (
                    <QueueRow key={d.id} d={d} index={i} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── AI Queue ── */}
      <section>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <SectionLabel>AI Queue · Bot Activity</SectionLabel>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success animate-pulse" />{AI_STATS.inCall} in call</span>
            <span>{AI_STATS.callsHandled} handled</span>
            <span className="text-blue-600 font-medium">{AI_STATS.ptpsCaptured} PTPs · {formatINR(AI_STATS.ptpAmount)}</span>
            <span className="text-destructive">{AI_STATS.escalated} escalated</span>
          </div>
        </div>

        {/* AI stat mini cards */}
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
          {[
            { label: "Calls Handled",  value: AI_STATS.callsHandled,             icon: BotMessageSquare, cls: "text-violet-500" },
            { label: "PTPs Captured",  value: `${AI_STATS.ptpsCaptured} · ${formatINR(AI_STATS.ptpAmount)}`, icon: HandCoins, cls: "text-blue-500" },
            { label: "Escalated",      value: AI_STATS.escalated,                icon: PhoneIncoming,    cls: "text-destructive" },
            { label: "No Answer",      value: AI_STATS.noAnswer,                 icon: PhoneMissed,      cls: "text-muted-foreground" },
          ].map((s, i) => {
            const Icon = s.icon;
            return (
              <Card key={s.label} className="animate-in fade-in duration-400" style={{ animationDelay: `${i * 60}ms` }}>
                <CardHeader className="flex flex-row items-center justify-between pb-1 space-y-0">
                  <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</CardTitle>
                  <Icon className={cn("h-4 w-4", s.cls)} />
                </CardHeader>
                <CardContent>
                  <div className="text-xl font-bold text-foreground">{s.value}</div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* AI queue table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Debtor</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="w-24">Duration</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="min-w-[260px]">Bot Activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {AI_QUEUE.map((row, i) => {
                    const meta = AI_STATUS_META[row.status];
                    return (
                      <TableRow
                        key={row.id}
                        className="animate-in fade-in duration-300 hover:bg-primary/5 align-top"
                        style={{ animationDelay: `${i * 40}ms` }}
                      >
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span className={cn("h-2 w-2 rounded-full flex-shrink-0", meta.dot)} />
                            <span className={cn("text-xs font-semibold", meta.cls)}>{meta.label}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-sm text-foreground">{row.debtorName}</div>
                          <div className="text-[11px] text-muted-foreground">{row.loanId}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{row.phone}</TableCell>
                        <TableCell className="text-sm font-medium text-foreground tabular-nums">{row.duration}</TableCell>
                        <TableCell>
                          {row.outcome
                            ? <Badge variant="outline" className={cn("text-xs", OUTCOME_META[row.outcome as CallOutcome]?.cls)}>{OUTCOME_META[row.outcome as CallOutcome]?.label}</Badge>
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <p className="text-xs text-foreground/80 leading-relaxed">{row.lastMsg}</p>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Detailed Calls Report ── */}
      <section>
        <div className="flex items-center justify-between">
          <SectionLabel>Detailed Calls Report</SectionLabel>
          <span className="text-xs text-muted-foreground">{filteredCalls.length} of {CALL_RECORDS.length} calls</span>
        </div>
        <Card className="mt-3 animate-in fade-in duration-500 delay-300">
          <CardHeader className="pb-3 border-b border-border">
            <div className="relative max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search name, loan ID, outcome…" value={callSearch} onChange={e => setCallSearch(e.target.value)} className="pl-8 h-8 text-sm" />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Time"     k="time"       active={sortKey} dir={sortDir} toggle={toggleSort} />
                    <SortHead label="Debtor"   k="debtorName" active={sortKey} dir={sortDir} toggle={toggleSort} />
                    <TableHead>Phone</TableHead>
                    <SortHead label="Duration" k="duration"   active={sortKey} dir={sortDir} toggle={toggleSort} className="text-right" />
                    <SortHead label="Outcome"  k="outcome"    active={sortKey} dir={sortDir} toggle={toggleSort} />
                    <TableHead>PTP</TableHead>
                    <TableHead className="min-w-[200px]">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCalls.map((c, i) => {
                    const meta = OUTCOME_META[c.outcome];
                    return (
                      <TableRow key={c.id} className="animate-in fade-in duration-300 hover:bg-primary/5 align-top" style={{ animationDelay: `${Math.min(i * 30, 400)}ms` }}>
                        <TableCell className="font-mono text-sm text-muted-foreground">{c.time}</TableCell>
                        <TableCell>
                          <div className="font-medium text-sm text-foreground">{c.debtorName}</div>
                          <div className="text-[11px] text-muted-foreground">{c.loanId}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{c.phone}</TableCell>
                        <TableCell className="text-right text-sm font-medium text-foreground">{c.duration}</TableCell>
                        <TableCell><Badge variant="outline" className={cn("text-xs", meta.cls)}>{meta.label}</Badge></TableCell>
                        <TableCell>
                          {c.ptpAmount
                            ? <div><div className="text-sm font-semibold text-blue-600">{formatINR(c.ptpAmount)}</div><div className="text-[11px] text-muted-foreground">by {c.ptpDate}</div></div>
                            : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell><p className="text-xs text-foreground/80 leading-relaxed">{c.notes || <span className="italic text-muted-foreground">No notes</span>}</p></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Activity Breakdown ── */}
      <section>
        <SectionLabel>Agent Activity Breakdown</SectionLabel>
        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">

          {/* Left: Time tracking */}
          <Card className="animate-in fade-in slide-in-from-left-4 duration-500 delay-400">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold">Time Distribution · Today</CardTitle>
              <p className="text-xs text-muted-foreground">{fmtMins(TOTAL_SHIFT_MINS)} total shift</p>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">
              <div className="flex h-4 w-full overflow-hidden rounded-full gap-0.5">
                {TIME_SEGMENTS.map(seg => (
                  <div
                    key={seg.key}
                    className={cn("h-full rounded-sm first:rounded-l-full last:rounded-r-full", seg.barCls)}
                    style={{ width: `${(TIME_TRACKING[seg.key] / TOTAL_SHIFT_MINS) * 100}%` }}
                    title={`${seg.label}: ${fmtMins(TIME_TRACKING[seg.key])}`}
                  />
                ))}
              </div>
              <div className="space-y-3">
                {TIME_SEGMENTS.map(seg => {
                  const mins = TIME_TRACKING[seg.key];
                  const pct = Math.round((mins / TOTAL_SHIFT_MINS) * 100);
                  return <TimeRow key={seg.key} icon={seg.icon} label={seg.label} desc={seg.desc} mins={mins} pct={pct} barCls={seg.barCls} textCls={seg.textCls} />;
                })}
              </div>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Productive</span>
                  <span className="font-semibold text-success">{fmtMins(TIME_TRACKING.ringing + TIME_TRACKING.talking + TIME_TRACKING.feedback + TIME_TRACKING.online)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Non-productive</span>
                  <span className="font-semibold text-muted-foreground">{fmtMins(TIME_TRACKING.breakTime + TIME_TRACKING.idle)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Right: placeholder */}
          <Card className="animate-in fade-in slide-in-from-right-4 duration-500 delay-400 flex items-center justify-center min-h-[320px]">
            <div className="text-center text-muted-foreground px-8">
              <div className="mb-3 flex justify-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <Clock className="h-6 w-6" />
                </div>
              </div>
              <p className="text-sm font-medium text-foreground">Right panel coming soon</p>
              <p className="mt-1 text-xs text-muted-foreground">This section will be filled in the next step</p>
            </div>
          </Card>

        </div>
      </section>

    </div>
  );
}

// ─── Time segment config ───────────────────────────────────────────────────────

const TIME_SEGMENTS: {
  key: keyof typeof TIME_TRACKING; label: string; desc: string;
  icon: React.ComponentType<{ className?: string }>; barCls: string; textCls: string;
}[] = [
  { key: "talking",   label: "Talking Time",        desc: "Connected call time",          icon: Phone,     barCls: "bg-success",              textCls: "text-success" },
  { key: "ringing",   label: "Ringing Time",        desc: "Dialing + waiting for pickup", icon: PhoneCall, barCls: "bg-blue-400",             textCls: "text-blue-500" },
  { key: "online",    label: "Online / Predictive", desc: "Predictive dialer running",    icon: Wifi,      barCls: "bg-violet-400",           textCls: "text-violet-500" },
  { key: "feedback",  label: "Feedback Time",       desc: "Logging outcomes & notes",     icon: FileText,  barCls: "bg-amber-400",            textCls: "text-amber-500" },
  { key: "breakTime", label: "Break Time",          desc: "Agent on break",               icon: Coffee,    barCls: "bg-orange-300",           textCls: "text-orange-400" },
  { key: "idle",      label: "Idle Time",           desc: "No activity detected",         icon: ZapOff,    barCls: "bg-muted-foreground/30",  textCls: "text-muted-foreground" },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground whitespace-nowrap">{children}</span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

function KPICard({ label, value, hint, icon: Icon, tone, index }: {
  label: string; value: string; hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "success" | "warning" | "info" | "neutral"; index: number;
}) {
  const iconCls = tone === "success" ? "text-success" : tone === "warning" ? "text-warning-foreground" : tone === "info" ? "text-blue-500" : "text-muted-foreground";
  return (
    <Card className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both transition-all duration-200 hover:scale-[1.02] hover:shadow-md" style={{ animationDelay: `${index * 70}ms` }}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground leading-tight">{label}</CardTitle>
        <Icon className={cn("h-4 w-4 flex-shrink-0", iconCls)} />
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold text-foreground leading-tight">{value}</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function QueueCard({ label, value, sub, icon: Icon, color, bg, index }: {
  label: string; value: number | string; sub: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string; bg: string; index: number;
}) {
  return (
    <Card className={cn("animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both", bg)} style={{ animationDelay: `${index * 80}ms` }}>
      <CardContent className="flex items-center gap-4 p-4">
        <div className={cn("flex h-11 w-11 items-center justify-center rounded-xl bg-background/60 flex-shrink-0", color)}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className={cn("text-2xl font-bold", color)}>{value}</div>
          <div className="text-xs font-medium text-foreground leading-tight">{label}</div>
          <div className="text-[11px] text-muted-foreground">{sub}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function QueueRow({ d, index }: { d: Debtor; index: number }) {
  const b = bucketOf(d.dpd);
  const dpdCls = b === "0-30" ? "bg-success/15 text-success border-success/30"
    : b === "31-60" ? "bg-warning/20 text-warning-foreground border-warning/40"
    : "bg-destructive/15 text-destructive border-destructive/30";
  const scoreCls = d.aiScore >= 8 ? "bg-success text-success-foreground"
    : d.aiScore >= 5 ? "bg-warning text-warning-foreground"
    : "bg-destructive text-destructive-foreground";
  return (
    <TableRow className="animate-in fade-in duration-300 hover:bg-primary/5 cursor-pointer align-top" style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}>
      <TableCell>
        <div className="font-medium text-sm text-foreground">{d.name}</div>
        <div className="text-[11px] text-muted-foreground">{d.id} · {d.portfolio}</div>
      </TableCell>
      <TableCell className="font-mono text-xs text-foreground">{d.phone}</TableCell>
      <TableCell className="text-right font-medium text-sm text-foreground">{formatINR(d.loanAmount)}</TableCell>
      <TableCell><Badge variant="outline" className={cn("font-medium text-xs", dpdCls)}>{d.dpd}d</Badge></TableCell>
      <TableCell>
        <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold", scoreCls)}>{d.aiScore}</span>
      </TableCell>
      <TableCell><p className="text-xs text-foreground/80 max-w-[200px] leading-snug">{d.scoreReason}</p></TableCell>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {d.lastContacted ? new Date(d.lastContacted).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" className="h-7 px-2 text-xs gap-1 active:scale-95"><Phone className="h-3 w-3" />Call</Button>
          <Button size="sm" className="h-7 px-2 text-xs gap-1 bg-success text-success-foreground hover:bg-success/90 active:scale-95"><MessageCircle className="h-3 w-3" />WA</Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1 text-muted-foreground active:scale-95"><SkipForward className="h-3 w-3" /></Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function SortHead({ label, k, active, dir, toggle, className }: {
  label: string; k: SortKey; active: SortKey; dir: SortDir; toggle: (k: SortKey) => void; className?: string;
}) {
  const isActive = active === k;
  const Icon = !isActive ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <button type="button" onClick={() => toggle(k)} className={cn("inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider transition-colors hover:text-foreground", isActive ? "text-foreground" : "text-muted-foreground")}>
        {label}<Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}

function TimeRow({ icon: Icon, label, desc, mins, pct, barCls, textCls }: {
  icon: React.ComponentType<{ className?: string }>; label: string; desc: string;
  mins: number; pct: number; barCls: string; textCls: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn("h-3.5 w-3.5", textCls)} />
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· {desc}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("text-sm font-semibold tabular-nums", textCls)}>{fmtMins(mins)}</span>
          <span className="text-[11px] text-muted-foreground w-8">{pct}%</span>
        </div>
      </div>
      <Progress value={pct} className="h-1.5" indicatorClassName={barCls} />
    </div>
  );
}
