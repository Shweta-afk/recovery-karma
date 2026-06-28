import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useEffect, useRef } from "react";
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
  ZapOff,
  ChevronDown,
  ChevronUp,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
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
import { formatINR } from "@/lib/mock-debtors";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Agent Dashboard · RecoveryAI" },
      { name: "description", content: "Agent performance dashboard with KPIs, call intensity, and time tracking." },
    ],
  }),
  component: AgentDashboard,
});

// ─── Mock data (replace with Supabase queries later) ──────────────────────────

const KPI_DATA = {
  totalCalling: 47,
  totalCallback: 8,
  todayPTP: 14,
  totalPTPAmount: 245000,
  todayPaid: 6,
  todayPaidAmount: 48500,
};

const CALL_INTENSITY: {
  hour: string;
  calls: number;
  connected: number;
  ptps: number;
  lastFollowup: string | null;
}[] = [
  { hour: "09:00", calls: 6,  connected: 4, ptps: 2, lastFollowup: "22 Jun 09:48" },
  { hour: "10:00", calls: 9,  connected: 7, ptps: 3, lastFollowup: "22 Jun 10:52" },
  { hour: "11:00", calls: 8,  connected: 5, ptps: 2, lastFollowup: "22 Jun 11:41" },
  { hour: "12:00", calls: 3,  connected: 2, ptps: 1, lastFollowup: "22 Jun 12:18" },
  { hour: "13:00", calls: 1,  connected: 0, ptps: 0, lastFollowup: null },          // lunch break
  { hour: "14:00", calls: 8,  connected: 6, ptps: 3, lastFollowup: "22 Jun 14:55" },
  { hour: "15:00", calls: 7,  connected: 4, ptps: 2, lastFollowup: "22 Jun 15:47" },
  { hour: "16:00", calls: 5,  connected: 3, ptps: 1, lastFollowup: "22 Jun 16:33" },
];

type CallOutcome = "paid" | "promised" | "refused" | "no_answer" | "callback" | "voicemail";

interface CallRecord {
  id: string;
  debtorName: string;
  loanId: string;
  phone: string;
  time: string;
  duration: string;
  durationSecs: number;
  outcome: CallOutcome;
  ptpAmount: number | null;
  ptpDate: string | null;
  notes: string;
}

const CALL_RECORDS: CallRecord[] = [
  { id: "C-001", debtorName: "Rahul Sharma",    loanId: "L-10042", phone: "+91 98XXX XX789", time: "09:02", duration: "4m 22s", durationSecs: 262, outcome: "promised",  ptpAmount: 8200,   ptpDate: "25 Jun",  notes: "Will pay by EOD Friday via UPI" },
  { id: "C-002", debtorName: "Priya Iyer",       loanId: "L-10018", phone: "+91 90XXX XX221", time: "09:18", duration: "6m 10s", durationSecs: 370, outcome: "paid",      ptpAmount: null,   ptpDate: null,      notes: "Payment received ₹8,200 during call" },
  { id: "C-003", debtorName: "Amit Verma",       loanId: "L-10211", phone: "+91 99XXX XX104", time: "09:35", duration: "0m 45s", durationSecs: 45,  outcome: "no_answer", ptpAmount: null,   ptpDate: null,      notes: "Phone rang, no pickup" },
  { id: "C-004", debtorName: "Sneha Reddy",      loanId: "L-10087", phone: "+91 97XXX XX556", time: "09:51", duration: "3m 05s", durationSecs: 185, outcome: "callback",  ptpAmount: null,   ptpDate: "22 Jun",  notes: "Asked to call after 6 PM" },
  { id: "C-005", debtorName: "Vikram Singh",     loanId: "L-10309", phone: "+91 98XXX XX012", time: "10:08", duration: "8m 41s", durationSecs: 521, outcome: "refused",   ptpAmount: null,   ptpDate: null,      notes: "Says payment already made, need to verify" },
  { id: "C-006", debtorName: "Ananya Bose",      loanId: "L-10455", phone: "+91 91XXX XX334", time: "10:22", duration: "5m 18s", durationSecs: 318, outcome: "promised",  ptpAmount: 15000,  ptpDate: "24 Jun",  notes: "Salary on 24th, will pay immediately" },
  { id: "C-007", debtorName: "Karthik Nair",     loanId: "L-10122", phone: "+91 99XXX XX901", time: "10:39", duration: "2m 30s", durationSecs: 150, outcome: "voicemail", ptpAmount: null,   ptpDate: null,      notes: "Left voicemail with payment link" },
  { id: "C-008", debtorName: "Meera Joshi",      loanId: "L-10277", phone: "+91 98XXX XX670", time: "10:52", duration: "7m 15s", durationSecs: 435, outcome: "paid",      ptpAmount: null,   ptpDate: null,      notes: "Full EMI settled via Razorpay link" },
  { id: "C-009", debtorName: "Divya Krishnan",   loanId: "L-10333", phone: "+91 97XXX XX115", time: "11:14", duration: "4m 50s", durationSecs: 290, outcome: "promised",  ptpAmount: 27500,  ptpDate: "23 Jun",  notes: "Has cash in hand, will transfer tonight" },
  { id: "C-010", debtorName: "Sandeep Yadav",    loanId: "L-10199", phone: "+91 99XXX XX782", time: "11:41", duration: "11m 02s", durationSecs: 662, outcome: "refused",  ptpAmount: null,   ptpDate: null,      notes: "Disputing interest amount, raised ticket" },
  { id: "C-011", debtorName: "Manish Gupta",     loanId: "L-10145", phone: "+91 97XXX XX461", time: "12:05", duration: "3m 47s", durationSecs: 227, outcome: "promised",  ptpAmount: 9500,   ptpDate: "25 Jun",  notes: "Extension approved, new date set" },
  { id: "C-012", debtorName: "Sara Khan",        loanId: "L-10612", phone: "+91 90XXX XX174", time: "12:18", duration: "1m 22s", durationSecs: 82,  outcome: "no_answer", ptpAmount: null,   ptpDate: null,      notes: "" },
  { id: "C-013", debtorName: "Arjun Kapoor",     loanId: "L-10068", phone: "+91 91XXX XX833", time: "14:03", duration: "5m 55s", durationSecs: 355, outcome: "paid",      ptpAmount: null,   ptpDate: null,      notes: "Paid 2 EMIs together via NEFT" },
  { id: "C-014", debtorName: "Lakshmi Pillai",   loanId: "L-10094", phone: "+91 98XXX XX317", time: "14:22", duration: "6m 30s", durationSecs: 390, outcome: "promised",  ptpAmount: 21000,  ptpDate: "24 Jun",  notes: "Partial payment possible by end of month" },
  { id: "C-015", debtorName: "Imran Sheikh",     loanId: "L-10478", phone: "+91 91XXX XX642", time: "14:44", duration: "4m 08s", durationSecs: 248, outcome: "paid",      ptpAmount: null,   ptpDate: null,      notes: "UPI transfer confirmed during call" },
];

// Agent time tracking (minutes)
const TIME_TRACKING = {
  ringing:   72,   // dialing + ringing before connect
  talking:   165,  // actual connected call time
  breakTime: 45,   // logged break
  feedback:  38,   // writing call notes/outcome
  idle:      82,   // no activity
  online:    78,   // predictive dialer running
};

const TOTAL_SHIFT_MINS = Object.values(TIME_TRACKING).reduce((a, b) => a + b, 0);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMins(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

const OUTCOME_META: Record<CallOutcome, { label: string; cls: string }> = {
  paid:      { label: "Paid",      cls: "bg-success/15 text-success border-success/30" },
  promised:  { label: "PTP",       cls: "bg-blue-500/15 text-blue-600 border-blue-400/30" },
  refused:   { label: "Refused",   cls: "bg-destructive/15 text-destructive border-destructive/30" },
  no_answer: { label: "No Answer", cls: "bg-muted text-muted-foreground border-border" },
  callback:  { label: "Callback",  cls: "bg-warning/20 text-warning-foreground border-warning/40" },
  voicemail: { label: "Voicemail", cls: "bg-purple-500/15 text-purple-600 border-purple-400/30" },
};

type SortKey = "time" | "debtorName" | "duration" | "outcome";
type SortDir = "asc" | "desc";

// ─── Main page ────────────────────────────────────────────────────────────────

function AgentDashboard() {
  const [callSearch, setCallSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filteredCalls = useMemo(() => {
    const q = callSearch.trim().toLowerCase();
    let rows = CALL_RECORDS.filter((c) => {
      if (!q) return true;
      return (
        c.debtorName.toLowerCase().includes(q) ||
        c.loanId.toLowerCase().includes(q) ||
        c.outcome.includes(q)
      );
    });
    rows = [...rows].sort((a, b) => {
      let av: string | number = a.time;
      let bv: string | number = b.time;
      if (sortKey === "debtorName") { av = a.debtorName; bv = b.debtorName; }
      if (sortKey === "duration")   { av = a.durationSecs; bv = b.durationSecs; }
      if (sortKey === "outcome")    { av = a.outcome; bv = b.outcome; }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
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

      {/* ── Section 1: KPI Cards ── */}
      <section>
        <SectionLabel>Key Performance Indicators</SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <KPICard
            label="Total Calling"
            value={KPI_DATA.totalCalling.toString()}
            hint="Dials today"
            icon={PhoneCall}
            tone="neutral"
            index={0}
          />
          <KPICard
            label="Total Callback"
            value={KPI_DATA.totalCallback.toString()}
            hint="Scheduled callbacks"
            icon={PhoneIncoming}
            tone="warning"
            index={1}
          />
          <KPICard
            label="Today PTP"
            value={KPI_DATA.todayPTP.toString()}
            hint="Promises to pay"
            icon={HandCoins}
            tone="info"
            index={2}
          />
          <KPICard
            label="Total PTP Amount"
            value={formatINR(KPI_DATA.totalPTPAmount)}
            hint="Committed today"
            icon={IndianRupee}
            tone="info"
            index={3}
          />
          <KPICard
            label="Today Paid"
            value={`${KPI_DATA.todayPaid} calls`}
            hint={formatINR(KPI_DATA.todayPaidAmount) + " collected"}
            icon={CheckCircle2}
            tone="success"
            index={4}
          />
        </div>
      </section>

      {/* ── Section 2: Call Intensity ── */}
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
                    <TableHead className="text-center w-24">Total Calls</TableHead>
                    <TableHead className="text-center w-24">Connected</TableHead>
                    <TableHead className="text-center w-20">PTPs</TableHead>
                    <TableHead className="w-44">Last Followup</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {CALL_INTENSITY.map((row) => {
                    const pct = Math.round((row.calls / 9) * 100); // 9 = max in range
                    const connected = Math.round((row.connected / Math.max(row.calls, 1)) * 100);
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
                        <TableCell className="text-center">
                          <span className="font-semibold text-foreground">{row.calls}</span>
                        </TableCell>
                        <TableCell className="text-center">
                          <span className={cn(
                            "text-sm font-medium",
                            connected >= 70 ? "text-success" : connected >= 40 ? "text-warning-foreground" : "text-muted-foreground"
                          )}>
                            {row.connected}
                            <span className="text-[10px] text-muted-foreground ml-1">({connected}%)</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          {row.ptps > 0 ? (
                            <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-300/40 text-xs">
                              {row.ptps}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.lastFollowup ? (
                            <span className="text-sm text-foreground">{row.lastFollowup}</span>
                          ) : (
                            <span className="text-xs italic text-muted-foreground">
                              {isLunch ? "Lunch break" : "No followup"}
                            </span>
                          )}
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

      {/* ── Section 3: Detailed Calls Report ── */}
      <section>
        <div className="flex items-center justify-between">
          <SectionLabel>Detailed Calls Report</SectionLabel>
          <span className="text-xs text-muted-foreground">{filteredCalls.length} of {CALL_RECORDS.length} calls</span>
        </div>
        <Card className="mt-3 animate-in fade-in duration-500 delay-300">
          <CardHeader className="pb-3 border-b border-border">
            <div className="relative max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, loan ID, or outcome…"
                value={callSearch}
                onChange={(e) => setCallSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Time"    k="time"       active={sortKey} dir={sortDir} toggle={toggleSort} />
                    <SortHead label="Debtor"  k="debtorName" active={sortKey} dir={sortDir} toggle={toggleSort} />
                    <TableHead>Phone</TableHead>
                    <SortHead label="Duration" k="duration"  active={sortKey} dir={sortDir} toggle={toggleSort} className="text-right" />
                    <SortHead label="Outcome"  k="outcome"   active={sortKey} dir={sortDir} toggle={toggleSort} />
                    <TableHead>PTP</TableHead>
                    <TableHead className="min-w-[220px]">Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCalls.map((c, i) => {
                    const meta = OUTCOME_META[c.outcome];
                    return (
                      <TableRow
                        key={c.id}
                        className="animate-in fade-in duration-300 hover:bg-primary/5 align-top"
                        style={{ animationDelay: `${Math.min(i * 30, 400)}ms` }}
                      >
                        <TableCell className="font-mono text-sm text-muted-foreground whitespace-nowrap">{c.time}</TableCell>
                        <TableCell>
                          <div className="font-medium text-sm text-foreground">{c.debtorName}</div>
                          <div className="text-[11px] text-muted-foreground">{c.loanId}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{c.phone}</TableCell>
                        <TableCell className="text-right">
                          <span className="text-sm font-medium text-foreground">{c.duration}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn("text-xs", meta.cls)}>
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {c.ptpAmount ? (
                            <div>
                              <div className="text-sm font-semibold text-blue-600">{formatINR(c.ptpAmount)}</div>
                              <div className="text-[11px] text-muted-foreground">by {c.ptpDate}</div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <p className="text-xs text-foreground/80 leading-relaxed">
                            {c.notes || <span className="italic text-muted-foreground">No notes</span>}
                          </p>
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

      {/* ── Section 4: Two-column time breakdown (left) + right TBD ── */}
      <section>
        <SectionLabel>Agent Activity Breakdown</SectionLabel>
        <div className="mt-3 grid grid-cols-1 gap-6 lg:grid-cols-2">

          {/* ── LEFT: Time tracking ── */}
          <Card className="animate-in fade-in slide-in-from-left-4 duration-500 delay-400">
            <CardHeader className="pb-3 border-b border-border">
              <CardTitle className="text-sm font-semibold">Time Distribution · Today</CardTitle>
              <p className="text-xs text-muted-foreground">{fmtMins(TOTAL_SHIFT_MINS)} total shift time</p>
            </CardHeader>
            <CardContent className="pt-4 space-y-4">

              {/* Stacked visual bar */}
              <div className="flex h-4 w-full overflow-hidden rounded-full gap-0.5">
                {TIME_SEGMENTS.map((seg) => (
                  <div
                    key={seg.key}
                    className={cn("h-full rounded-sm first:rounded-l-full last:rounded-r-full", seg.barCls)}
                    style={{ width: `${(TIME_TRACKING[seg.key] / TOTAL_SHIFT_MINS) * 100}%` }}
                    title={`${seg.label}: ${fmtMins(TIME_TRACKING[seg.key])}`}
                  />
                ))}
              </div>

              {/* Legend rows */}
              <div className="space-y-3">
                {TIME_SEGMENTS.map((seg) => {
                  const mins = TIME_TRACKING[seg.key];
                  const pct = Math.round((mins / TOTAL_SHIFT_MINS) * 100);
                  return (
                    <TimeRow
                      key={seg.key}
                      icon={seg.icon}
                      label={seg.label}
                      desc={seg.desc}
                      mins={mins}
                      pct={pct}
                      barCls={seg.barCls}
                      textCls={seg.textCls}
                    />
                  );
                })}
              </div>

              {/* Summary */}
              <div className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Productive time</span>
                  <span className="font-semibold text-success">
                    {fmtMins(TIME_TRACKING.ringing + TIME_TRACKING.talking + TIME_TRACKING.feedback + TIME_TRACKING.online)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs mt-1">
                  <span className="text-muted-foreground">Non-productive</span>
                  <span className="font-semibold text-muted-foreground">
                    {fmtMins(TIME_TRACKING.breakTime + TIME_TRACKING.idle)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── RIGHT: Coming later ── */}
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
  key: keyof typeof TIME_TRACKING;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  barCls: string;
  textCls: string;
}[] = [
  {
    key: "talking",
    label: "Talking Time",
    desc: "Duration of connected calls",
    icon: Phone,
    barCls: "bg-success",
    textCls: "text-success",
  },
  {
    key: "ringing",
    label: "Ringing Time",
    desc: "Dialing + waiting for pickup",
    icon: PhoneCall,
    barCls: "bg-blue-400",
    textCls: "text-blue-500",
  },
  {
    key: "online",
    label: "Online / Predictive",
    desc: "Predictive dialer was running",
    icon: Wifi,
    barCls: "bg-violet-400",
    textCls: "text-violet-500",
  },
  {
    key: "feedback",
    label: "Feedback Time",
    desc: "Logging outcomes & notes",
    icon: FileText,
    barCls: "bg-amber-400",
    textCls: "text-amber-500",
  },
  {
    key: "breakTime",
    label: "Break Time",
    desc: "Agent on break",
    icon: Coffee,
    barCls: "bg-orange-300",
    textCls: "text-orange-400",
  },
  {
    key: "idle",
    label: "Idle Time",
    desc: "No activity detected",
    icon: ZapOff,
    barCls: "bg-muted-foreground/30",
    textCls: "text-muted-foreground",
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {children}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

function KPICard({
  label, value, hint, icon: Icon, tone, index,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "success" | "warning" | "info" | "neutral";
  index: number;
}) {
  const iconCls =
    tone === "success" ? "text-success"
    : tone === "warning" ? "text-warning-foreground"
    : tone === "info" ? "text-blue-500"
    : "text-muted-foreground";

  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both transition-all duration-200 hover:scale-[1.02] hover:shadow-md hover:shadow-primary/10"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground leading-tight">
          {label}
        </CardTitle>
        <Icon className={cn("h-4 w-4 flex-shrink-0", iconCls)} />
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold text-foreground leading-tight">{value}</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function SortHead({
  label, k, active, dir, toggle, className,
}: {
  label: string;
  k: SortKey;
  active: SortKey;
  dir: SortDir;
  toggle: (k: SortKey) => void;
  className?: string;
}) {
  const isActive = active === k;
  const Icon = !isActive ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => toggle(k)}
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider transition-colors hover:text-foreground",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}

function TimeRow({
  icon: Icon, label, desc, mins, pct, barCls, textCls,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  desc: string;
  mins: number;
  pct: number;
  barCls: string;
  textCls: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn("h-3.5 w-3.5", textCls)} />
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· {desc}</span>
        </div>
        <div className="flex items-center gap-2 text-right">
          <span className={cn("text-sm font-semibold tabular-nums", textCls)}>{fmtMins(mins)}</span>
          <span className="text-[11px] text-muted-foreground w-8">{pct}%</span>
        </div>
      </div>
      <Progress value={pct} className={cn("h-1.5")} indicatorClassName={barCls} />
    </div>
  );
}
