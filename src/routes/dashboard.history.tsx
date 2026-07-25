import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Phone,
  BotMessageSquare,
  MessageSquare,
  MessageCircle,
  Radio,
  Search,
  FileDown,
  ArrowUpRight,
  ArrowDownLeft,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export const Route = createFileRoute("/dashboard/history")({
  head: () => ({
    meta: [
      { title: "Activity History · RecoveryAI" },
      {
        name: "description",
        content: "Full contact history across calls, IVR, SMS and WhatsApp with filters.",
      },
    ],
  }),
  component: ActivityHistoryPage,
});

// ─── Types & metadata ─────────────────────────────────────────────────────────

type Channel = "call_agent" | "call_ai" | "ivr" | "sms" | "whatsapp";
type Tone = "positive" | "neutral" | "negative";

interface ActivityEvent {
  id: string;
  date: string; // "30 Jun 2026"
  day: "today" | "yesterday";
  time: string; // "09:02"
  debtorName: string;
  loanId: string;
  contact: string; // phone number
  channel: Channel;
  direction: "outbound" | "inbound";
  actor: string; // "Ravi M." | "AI Bot" | "System"
  result: string; // outcome / delivery status label
  tone: Tone;
  detail: string;
  amount?: number | null;
}

const CHANNEL_META: Record<
  Channel,
  { label: string; short: string; icon: typeof Phone; cls: string; dot: string }
> = {
  call_agent: {
    label: "Agent Call",
    short: "Call",
    icon: Phone,
    cls: "bg-slate-500/8 text-foreground/80 border-border",
    dot: "bg-foreground",
  },
  call_ai: {
    label: "AI Call",
    short: "AI Call",
    icon: BotMessageSquare,
    cls: "bg-violet-500/8 text-violet-600/80 border-violet-400/20",
    dot: "bg-violet-500",
  },
  ivr: {
    label: "IVR",
    short: "IVR",
    icon: Radio,
    cls: "bg-teal-500/8 text-teal-600/80 border-teal-400/20",
    dot: "bg-teal-500",
  },
  sms: {
    label: "SMS",
    short: "SMS",
    icon: MessageSquare,
    cls: "bg-blue-500/8 text-blue-600/80 border-blue-400/20",
    dot: "bg-blue-500",
  },
  whatsapp: {
    label: "WhatsApp",
    short: "WhatsApp",
    icon: MessageCircle,
    cls: "bg-success/8 text-success/80 border-success/20",
    dot: "bg-success",
  },
};

const TONE_CLS: Record<Tone, string> = {
  positive: "bg-success/8 text-success/80 border-success/20",
  neutral: "bg-muted text-muted-foreground border-border",
  negative: "bg-destructive/8 text-destructive/70 border-destructive/20",
};

// ─── Mock unified activity feed ───────────────────────────────────────────────

const ACTIVITY: ActivityEvent[] = [
  // ── Today ──
  {
    id: "A-001",
    date: "30 Jun 2026",
    day: "today",
    time: "09:02",
    debtorName: "Rahul Sharma",
    loanId: "L-10042",
    contact: "+91 98XXX XX789",
    channel: "call_agent",
    direction: "outbound",
    actor: "Ravi M.",
    result: "PTP",
    tone: "positive",
    detail: "Will pay by EOD Friday via UPI",
    amount: 8200,
  },
  {
    id: "A-002",
    date: "30 Jun 2026",
    day: "today",
    time: "09:05",
    debtorName: "Amit Verma",
    loanId: "L-10211",
    contact: "+91 99XXX XX104",
    channel: "ivr",
    direction: "outbound",
    actor: "System",
    result: "No input",
    tone: "negative",
    detail: "IVR reminder played — call disconnected before keypress",
  },
  {
    id: "A-003",
    date: "30 Jun 2026",
    day: "today",
    time: "09:08",
    debtorName: "Sunita Rao",
    loanId: "L-10544",
    contact: "+91 98XXX XX901",
    channel: "sms",
    direction: "outbound",
    actor: "System",
    result: "Delivered",
    tone: "neutral",
    detail: "Payment reminder SMS delivered to handset",
  },
  {
    id: "A-004",
    date: "30 Jun 2026",
    day: "today",
    time: "09:12",
    debtorName: "Priya Iyer",
    loanId: "L-10018",
    contact: "+91 90XXX XX221",
    channel: "call_agent",
    direction: "outbound",
    actor: "Neha K.",
    result: "Paid",
    tone: "positive",
    detail: "Payment received ₹8,200 during call",
    amount: 8200,
  },
  {
    id: "A-005",
    date: "30 Jun 2026",
    day: "today",
    time: "09:20",
    debtorName: "Firoz Khan",
    loanId: "L-10388",
    contact: "+91 91XXX XX220",
    channel: "ivr",
    direction: "outbound",
    actor: "System",
    result: "Keypress 1",
    tone: "positive",
    detail: "Debtor pressed 1 — PTP captured automatically via IVR",
    amount: 12000,
  },
  {
    id: "A-006",
    date: "30 Jun 2026",
    day: "today",
    time: "09:34",
    debtorName: "Rakesh Tiwari",
    loanId: "L-10712",
    contact: "+91 90XXX XX311",
    channel: "call_ai",
    direction: "outbound",
    actor: "AI Bot",
    result: "Callback",
    tone: "neutral",
    detail: "Bot scheduled a callback for 4:30 PM",
  },
  {
    id: "A-007",
    date: "30 Jun 2026",
    day: "today",
    time: "09:41",
    debtorName: "Kavitha Menon",
    loanId: "L-09744",
    contact: "+91 98XXX XX903",
    channel: "whatsapp",
    direction: "outbound",
    actor: "System",
    result: "Seen",
    tone: "neutral",
    detail: "WhatsApp reminder seen — no reply yet",
  },
  {
    id: "A-008",
    date: "30 Jun 2026",
    day: "today",
    time: "09:52",
    debtorName: "Sneha Reddy",
    loanId: "L-10087",
    contact: "+91 97XXX XX556",
    channel: "call_agent",
    direction: "outbound",
    actor: "Ravi M.",
    result: "Callback",
    tone: "neutral",
    detail: "Asked to call after 6 PM",
  },
  {
    id: "A-009",
    date: "30 Jun 2026",
    day: "today",
    time: "10:03",
    debtorName: "Kavitha Menon",
    loanId: "L-09744",
    contact: "+91 98XXX XX903",
    channel: "whatsapp",
    direction: "inbound",
    actor: "Debtor",
    result: "Replied",
    tone: "positive",
    detail: '"Will pay ₹5,000 tomorrow" — reply received',
  },
  {
    id: "A-010",
    date: "30 Jun 2026",
    day: "today",
    time: "10:08",
    debtorName: "Vikram Singh",
    loanId: "L-10309",
    contact: "+91 98XXX XX012",
    channel: "call_agent",
    direction: "outbound",
    actor: "Neha K.",
    result: "Refused",
    tone: "negative",
    detail: "Says payment already made — needs verification",
  },
  {
    id: "A-011",
    date: "30 Jun 2026",
    day: "today",
    time: "10:22",
    debtorName: "Ananya Bose",
    loanId: "L-10455",
    contact: "+91 91XXX XX334",
    channel: "call_agent",
    direction: "outbound",
    actor: "Ravi M.",
    result: "PTP",
    tone: "positive",
    detail: "Salary on 24th — will pay immediately",
    amount: 15000,
  },
  {
    id: "A-012",
    date: "30 Jun 2026",
    day: "today",
    time: "10:41",
    debtorName: "Hemant Sharma",
    loanId: "L-10290",
    contact: "+91 99XXX XX174",
    channel: "call_ai",
    direction: "outbound",
    actor: "AI Bot",
    result: "No Answer",
    tone: "negative",
    detail: "Rang out — max retries scheduled",
  },
  {
    id: "A-013",
    date: "30 Jun 2026",
    day: "today",
    time: "10:55",
    debtorName: "Geetha Pillai",
    loanId: "L-10457",
    contact: "+91 98XXX XX602",
    channel: "call_ai",
    direction: "outbound",
    actor: "AI Bot",
    result: "Escalated",
    tone: "neutral",
    detail: "Debtor requested a human agent — escalated to queue",
  },
  {
    id: "A-014",
    date: "30 Jun 2026",
    day: "today",
    time: "11:03",
    debtorName: "Meera Joshi",
    loanId: "L-10277",
    contact: "+91 98XXX XX670",
    channel: "call_agent",
    direction: "outbound",
    actor: "Neha K.",
    result: "Paid",
    tone: "positive",
    detail: "Full EMI settled — confirmed via bank transfer",
    amount: 22000,
  },
  {
    id: "A-015",
    date: "30 Jun 2026",
    day: "today",
    time: "11:14",
    debtorName: "Divya Krishnan",
    loanId: "L-10333",
    contact: "+91 97XXX XX115",
    channel: "sms",
    direction: "outbound",
    actor: "System",
    result: "Failed",
    tone: "negative",
    detail: "SMS failed — number unreachable / DND",
  },
  {
    id: "A-016",
    date: "30 Jun 2026",
    day: "today",
    time: "11:28",
    debtorName: "Lalitha Devi",
    loanId: "L-10631",
    contact: "+91 97XXX XX540",
    channel: "ivr",
    direction: "outbound",
    actor: "System",
    result: "Hung up",
    tone: "negative",
    detail: "IVR answered then hung up before script finished",
  },
  {
    id: "A-017",
    date: "30 Jun 2026",
    day: "today",
    time: "11:45",
    debtorName: "Geeta Menon",
    loanId: "L-10523",
    contact: "+91 97XXX XX058",
    channel: "call_ai",
    direction: "outbound",
    actor: "AI Bot",
    result: "Refused",
    tone: "negative",
    detail: "Hostile response detected — escalated to senior agent",
  },
  {
    id: "A-018",
    date: "30 Jun 2026",
    day: "today",
    time: "12:05",
    debtorName: "Manish Gupta",
    loanId: "L-10145",
    contact: "+91 97XXX XX461",
    channel: "call_agent",
    direction: "outbound",
    actor: "Ravi M.",
    result: "PTP",
    tone: "positive",
    detail: "Extension approved — new date set",
    amount: 9500,
  },
  {
    id: "A-019",
    date: "30 Jun 2026",
    day: "today",
    time: "12:30",
    debtorName: "Rekha Patel",
    loanId: "L-10350",
    contact: "+91 91XXX XX804",
    channel: "call_ai",
    direction: "outbound",
    actor: "AI Bot",
    result: "Paid",
    tone: "positive",
    detail: "Debtor confirmed bank transfer during bot call",
    amount: 6400,
  },
  {
    id: "A-020",
    date: "30 Jun 2026",
    day: "today",
    time: "13:12",
    debtorName: "Sara Khan",
    loanId: "L-10612",
    contact: "+91 90XXX XX174",
    channel: "whatsapp",
    direction: "outbound",
    actor: "System",
    result: "Delivered",
    tone: "neutral",
    detail: "Payment link sent on WhatsApp",
  },
  {
    id: "A-021",
    date: "30 Jun 2026",
    day: "today",
    time: "14:03",
    debtorName: "Arjun Kapoor",
    loanId: "L-10068",
    contact: "+91 91XXX XX833",
    channel: "call_agent",
    direction: "outbound",
    actor: "Neha K.",
    result: "Paid",
    tone: "positive",
    detail: "Paid 2 EMIs together via NEFT",
    amount: 31000,
  },
  {
    id: "A-022",
    date: "30 Jun 2026",
    day: "today",
    time: "14:20",
    debtorName: "Sara Khan",
    loanId: "L-10612",
    contact: "+91 90XXX XX174",
    channel: "whatsapp",
    direction: "inbound",
    actor: "Debtor",
    result: "Replied",
    tone: "positive",
    detail: '"Paid via the link, sharing screenshot"',
  },
  {
    id: "A-023",
    date: "30 Jun 2026",
    day: "today",
    time: "15:02",
    debtorName: "Imran Sheikh",
    loanId: "L-10478",
    contact: "+91 91XXX XX642",
    channel: "call_agent",
    direction: "outbound",
    actor: "Ravi M.",
    result: "PTP",
    tone: "positive",
    detail: "Reliable track record — PTP confirmed",
    amount: 11000,
  },
  {
    id: "A-024",
    date: "30 Jun 2026",
    day: "today",
    time: "15:40",
    debtorName: "Pooja Bhatt",
    loanId: "L-10421",
    contact: "+91 98XXX XX209",
    channel: "sms",
    direction: "inbound",
    actor: "Debtor",
    result: "Replied",
    tone: "positive",
    detail: 'Replied "PAID" — auto-flagged for verification',
  },
  // ── Yesterday ──
  {
    id: "A-025",
    date: "29 Jun 2026",
    day: "yesterday",
    time: "16:10",
    debtorName: "Mohan Lal",
    loanId: "L-10711",
    contact: "+91 97XXX XX133",
    channel: "ivr",
    direction: "outbound",
    actor: "System",
    result: "Keypress 2",
    tone: "neutral",
    detail: "Pressed 2 — requested callback via IVR",
  },
  {
    id: "A-026",
    date: "29 Jun 2026",
    day: "yesterday",
    time: "16:35",
    debtorName: "Tarun Desai",
    loanId: "L-10366",
    contact: "+91 99XXX XX590",
    channel: "sms",
    direction: "outbound",
    actor: "System",
    result: "Delivered",
    tone: "neutral",
    detail: "Legal-notice pre-intimation SMS delivered",
  },
  {
    id: "A-027",
    date: "29 Jun 2026",
    day: "yesterday",
    time: "17:02",
    debtorName: "Deepak Rawat",
    loanId: "L-09655",
    contact: "+91 91XXX XX771",
    channel: "call_agent",
    direction: "inbound",
    actor: "Deepak Rawat",
    result: "Callback",
    tone: "neutral",
    detail: "Debtor called back — dispute discussion, escalated",
  },
  {
    id: "A-028",
    date: "29 Jun 2026",
    day: "yesterday",
    time: "17:44",
    debtorName: "Bhavna Shah",
    loanId: "L-09512",
    contact: "+91 99XXX XX308",
    channel: "whatsapp",
    direction: "inbound",
    actor: "Debtor",
    result: "Replied",
    tone: "positive",
    detail: "Shared payment screenshot on WhatsApp",
    amount: 9000,
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

const CHANNEL_ORDER: Channel[] = ["call_agent", "call_ai", "ivr", "sms", "whatsapp"];

function ActivityHistoryPage() {
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [result, setResult] = useState<string>("all");
  const [day, setDay] = useState<"all" | "today" | "yesterday">("all");
  const [search, setSearch] = useState("");

  const channelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: ACTIVITY.length };
    for (const c of CHANNEL_ORDER) counts[c] = ACTIVITY.filter((e) => e.channel === c).length;
    return counts;
  }, []);

  const resultOptions = useMemo(
    () => Array.from(new Set(ACTIVITY.map((e) => e.result))).sort(),
    [],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ACTIVITY.filter((e) => {
      if (channel !== "all" && e.channel !== channel) return false;
      if (result !== "all" && e.result !== result) return false;
      if (day !== "all" && e.day !== day) return false;
      if (
        q &&
        !(
          e.debtorName.toLowerCase().includes(q) ||
          e.loanId.toLowerCase().includes(q) ||
          e.detail.toLowerCase().includes(q) ||
          e.result.toLowerCase().includes(q) ||
          e.actor.toLowerCase().includes(q)
        )
      )
        return false;
      return true;
    });
  }, [channel, result, day, search]);

  const resetFilters = () => {
    setChannel("all");
    setResult("all");
    setDay("all");
    setSearch("");
  };

  const exportCSV = () => {
    const headers = [
      "Date",
      "Time",
      "Channel",
      "Direction",
      "Debtor",
      "Loan ID",
      "Contact",
      "Result",
      "By",
      "Detail",
      "Amount",
    ];
    const sanitize = (v: string | number) => {
      const s = String(v);
      return /^[=+\-@]/.test(s) ? `\t${s}` : s;
    };
    const esc = (v: string | number) => `"${sanitize(v).replace(/"/g, '""')}"`;
    const rows = filtered.map((e) => [
      e.date,
      e.time,
      CHANNEL_META[e.channel].label,
      e.direction,
      e.debtorName,
      e.loanId,
      e.contact,
      e.result,
      e.actor,
      e.detail,
      e.amount ?? "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "activity-history.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Activity History</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every contact across calls, IVR, SMS and WhatsApp — inbound and outbound.
          </p>
        </div>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={exportCSV}>
          <FileDown className="h-3.5 w-3.5" />
          Export ({filtered.length})
        </Button>
      </div>

      {/* Channel summary chips */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <button
          type="button"
          onClick={() => setChannel("all")}
          className={cn(
            "rounded-xl border p-3 text-left transition-all hover:border-foreground/30",
            channel === "all"
              ? "border-foreground/40 bg-muted/40 ring-1 ring-foreground/10"
              : "border-border bg-card",
          )}
        >
          <div className="text-lg font-bold tabular-nums text-foreground">{channelCounts.all}</div>
          <div className="text-[11px] font-medium text-muted-foreground">All Activity</div>
        </button>
        {CHANNEL_ORDER.map((c) => {
          const m = CHANNEL_META[c];
          return (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={cn(
                "rounded-xl border p-3 text-left transition-all hover:border-foreground/30",
                channel === c
                  ? "border-foreground/40 bg-muted/40 ring-1 ring-foreground/10"
                  : "border-border bg-card",
              )}
            >
              <div className="flex items-center gap-1.5">
                <m.icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-lg font-bold tabular-nums text-foreground">
                  {channelCounts[c]}
                </span>
              </div>
              <div className="text-[11px] font-medium text-muted-foreground">{m.label}</div>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <Card>
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search debtor, loan ID, note, agent…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-sm"
              />
            </div>
            <Select value={result} onValueChange={setResult}>
              <SelectTrigger className="h-9 w-[150px] text-sm">
                <SelectValue placeholder="Result" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All results</SelectItem>
                {resultOptions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={day} onValueChange={(v) => setDay(v as typeof day)}>
              <SelectTrigger className="h-9 w-[130px] text-sm">
                <SelectValue placeholder="Date" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All dates</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="yesterday">Yesterday</SelectItem>
              </SelectContent>
            </Select>
            {(channel !== "all" || result !== "all" || day !== "all" || search) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-9 text-xs text-muted-foreground"
                onClick={resetFilters}
              >
                Clear
              </Button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {filtered.length} of {ACTIVITY.length} events
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[560px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead className="w-[64px]">Time</TableHead>
                  <TableHead className="w-[120px]">Channel</TableHead>
                  <TableHead>Debtor</TableHead>
                  <TableHead className="w-[70px]">Dir.</TableHead>
                  <TableHead className="w-[120px]">Result</TableHead>
                  <TableHead className="min-w-[240px]">Detail</TableHead>
                  <TableHead className="w-[110px]">By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="text-center text-sm text-muted-foreground py-10"
                    >
                      No activity matches these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((e) => {
                    const m = CHANNEL_META[e.channel];
                    return (
                      <TableRow key={e.id} className="hover:bg-muted/20 align-top">
                        <TableCell className="align-top">
                          <div className="font-mono text-xs text-foreground">{e.time}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {e.day === "today" ? "Today" : "Yest."}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn("gap-1 text-[10px] font-medium", m.cls)}
                          >
                            <m.icon className="h-3 w-3" />
                            {m.short}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-sm text-foreground">{e.debtorName}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {e.loanId} · {e.contact}
                          </div>
                        </TableCell>
                        <TableCell>
                          {e.direction === "outbound" ? (
                            <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
                              <ArrowUpRight className="h-3 w-3" />
                              Out
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-0.5 text-[11px] text-blue-500">
                              <ArrowDownLeft className="h-3 w-3" />
                              In
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn("text-[10px]", TONE_CLS[e.tone])}>
                            {e.result}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <p className="text-xs text-foreground/80 leading-relaxed">{e.detail}</p>
                          {e.amount ? (
                            <span className="text-[11px] font-semibold text-blue-600">
                              {formatINR(e.amount)}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{e.actor}</TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
