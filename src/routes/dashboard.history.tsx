import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";

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
  day: DayBucket;
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
  /** ISO timestamp, kept for sorting — `date`/`time` are display-only. */
  rawTime: string;
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

// ─── Real activity feed ───────────────────────────────────────────────────────
// Built from call_logs (via the disposition store) rather than a fixture. SMS/WhatsApp
// rows will appear here once messaging is wired — the messages table is not read anywhere
// yet, so those channels are legitimately empty rather than hidden.

export type DayBucket = "today" | "yesterday" | "older";

function dayBucket(d: Date, now: Date): DayBucket {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : "older";
}

/** Outcome -> the colour-coded tone the table already renders. */
const OUTCOME_TONE: Record<string, Tone> = {
  paid: "positive",
  promised: "positive",
  settlement: "positive",
  callback: "neutral",
  no_answer: "neutral",
  voicemail: "neutral",
  refused: "negative",
  dispute: "negative",
};

const OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  promised: "PTP",
  refused: "Refused",
  no_answer: "No Answer",
  voicemail: "Voicemail",
  dispute: "Dispute",
  callback: "Callback",
  settlement: "Settlement",
};

function channelFor(callType: DispositionRecord["callType"]): Channel {
  if (callType === "ai" || callType === "bot") return "call_ai";
  if (callType === "ivr") return "ivr";
  return "call_agent";
}

export function toActivityEvents(disps: DispositionRecord[], now = new Date()): ActivityEvent[] {
  return disps
    .map((d): ActivityEvent => {
      const at = new Date(d.time);
      const amount = d.paidAmount ?? d.ptpAmount ?? null;
      return {
        id: d.id,
        date: at.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
        day: dayBucket(at, now),
        time: at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }),
        debtorName: d.debtorName || d.phone || "Unknown",
        // call_logs has no loan reference; the portfolio is the closest grouping we hold.
        loanId: d.portfolioName ?? "",
        contact: d.phone,
        channel: channelFor(d.callType),
        direction: "outbound",
        actor: d.agentName || d.agentId || "System",
        result: OUTCOME_LABEL[d.outcome] ?? d.outcome,
        tone: OUTCOME_TONE[d.outcome] ?? "neutral",
        detail: d.notes,
        amount,
        rawTime: d.time,
      };
    })
    .sort((a, b) => +new Date(b.rawTime) - +new Date(a.rawTime));
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const CHANNEL_ORDER: Channel[] = ["call_agent", "call_ai", "ivr", "sms", "whatsapp"];

function ActivityHistoryPage() {
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [result, setResult] = useState<string>("all");
  const [day, setDay] = useState<"all" | DayBucket>("all");
  const [search, setSearch] = useState("");

  // Render the cached dispositions immediately, then refresh from call_logs. The store
  // broadcasts `dispositions-updated` after each write, so a call dispositioned elsewhere
  // in the app shows up here without a reload.
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  useEffect(() => {
    const load = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", load);
    refreshDispositions().finally(load);
    return () => window.removeEventListener("dispositions-updated", load);
  }, []);

  const events = useMemo(() => toActivityEvents(disps), [disps]);

  const channelCounts = useMemo(() => {
    const counts: Record<string, number> = { all: events.length };
    for (const c of CHANNEL_ORDER) counts[c] = events.filter((e) => e.channel === c).length;
    return counts;
  }, [events]);

  const resultOptions = useMemo(
    () => Array.from(new Set(events.map((e) => e.result))).sort(),
    [events],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
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
  }, [events, channel, result, day, search]);

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
                {/* Real data goes back further than the two days the fixture covered. */}
                <SelectItem value="older">Older</SelectItem>
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
              {filtered.length} of {events.length} events
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
                            {e.day === "today" ? "Today" : e.day === "yesterday" ? "Yest." : e.date}
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
