import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import {
  Send,
  CheckCheck,
  Check,
  Phone,
  MessageSquare,
  Radio,
  ChevronDown,
  FileDown,
  Clock,
} from "lucide-react";

function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const sanitize = (v: string | number) => {
    const s = String(v);
    return /^[=+\-@]/.test(s) ? `\t${s}` : s;
  };
  const escape = (v: string | number) => `"${sanitize(v).replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DateRangeFilter } from "@/components/date-range-filter";
import { EMPTY_RANGE, inDateRange, type DateRange } from "@/lib/date-filter";
import { bucketOf, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";
import {
  getPortfolios,
  getAgentDebtorIds,
  refreshPortfolios,
  type UploadedDebtor,
} from "@/lib/portfolio-store";
import { useAuth } from "@/lib/auth";
import {
  getMessages,
  refreshMessages,
  sendMessage,
  type MessageRecord,
} from "@/lib/messages-store";
import {
  getDispositions,
  refreshDispositions,
  type DispositionRecord,
} from "@/lib/disposition-store";

export const Route = createFileRoute("/dashboard/messages")({
  head: () => ({ meta: [{ title: "Messages · SamvadX" }] }),
  component: MessagesPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "whatsapp" | "ivr" | "sms";

const WA_TEMPLATES = [
  {
    value: "ptp",
    label: "PTP Confirmation",
    text: "We've noted your commitment to pay by {date}. We will follow up accordingly. Thank you.",
  },
  {
    value: "reminder",
    label: "EMI Reminder",
    text: "Dear {name}, your EMI of {amount} is due today. Kindly clear at the earliest to avoid penalties.",
  },
  {
    value: "settlement",
    label: "Settlement Offer",
    text: "Special offer: Settle your outstanding at a 20% waiver. Valid till {date}. Contact us to confirm.",
  },
  {
    value: "callback",
    label: "Callback Request",
    text: "Hi {name}, our agent will call you at your preferred time. Please confirm a suitable slot.",
  },
];

const IVR_OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  promised: "PTP Captured",
  refused: "Refused",
  no_answer: "No Answer",
  voicemail: "Voicemail",
  dispute: "Dispute",
  callback: "Callback Requested",
  settlement: "Settlement",
};

const MSG_STATUS_META: Record<MessageRecord["status"], { label: string; cls: string }> = {
  sent: { label: "Sent", cls: "bg-muted text-muted-foreground border-border" },
  delivered: { label: "Delivered", cls: "bg-success/8 text-success/70 border-success/15" },
  read: { label: "Read", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
  failed: { label: "Failed", cls: "bg-destructive/8 text-destructive/70 border-destructive/15" },
  replied: { label: "Replied", cls: "bg-success/8 text-success/70 border-success/15" },
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function initialsFor(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function MessagesPage() {
  const { user } = useAuth();
  const agentEmail = user?.email ?? "";
  const isSupervisor = user?.role === "manager" || user?.role === "admin";

  const [activeTab, setActiveTab] = useState<Tab>("whatsapp");
  const [activeDebtorId, setActiveDebtorId] = useState<string | null>(null);
  const [template, setTemplate] = useState("");
  const [input, setInput] = useState("");
  const [bucketFilter, setBucketFilter] = useState<DPDBucket | "all">("all");
  // Applies to the IVR and SMS logs, which are flat per-event lists. Deliberately NOT
  // applied to the WhatsApp thread list: a conversation spans days, so date-filtering it
  // would hide live threads rather than narrow a log.
  const [dateRange, setDateRange] = useState<DateRange>(EMPTY_RANGE);
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [composeDropOpen, setComposeDropOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const [messages, setMessages] = useState<MessageRecord[]>(() => getMessages());
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  const [allDebtors, setAllDebtors] = useState<UploadedDebtor[]>([]);

  useEffect(() => {
    const loadMessages = () => setMessages(getMessages());
    const loadDisps = () => setDisps(getDispositions());
    // Scoped to this agent's own accounts. This used to flatten every portfolio in the cache,
    // which handed an agent the name and number of debtors booked to someone else through the
    // "new message" picker — the same accounts the Debtors page and call queue correctly hide.
    // Supervisors keep the whole book they can already see.
    const loadDebtors = () => {
      const portfolios = getPortfolios();
      if (isSupervisor) {
        setAllDebtors(portfolios.flatMap((p) => p.rows));
        return;
      }
      const assigned = new Set(getAgentDebtorIds(agentEmail).flatMap((slice) => slice.debtorIds));
      setAllDebtors(portfolios.flatMap((p) => p.rows).filter((r) => assigned.has(r.id)));
    };

    window.addEventListener("messages-updated", loadMessages);
    window.addEventListener("dispositions-updated", loadDisps);
    window.addEventListener("portfolios-updated", loadDebtors);

    refreshMessages()
      .then(loadMessages)
      .catch((e) => console.warn("[messages] refresh failed:", e));
    refreshDispositions()
      .then(loadDisps)
      .catch((e) => console.warn("[messages] disposition refresh failed:", e));
    refreshPortfolios()
      .then(loadDebtors)
      .catch((e) => console.warn("[messages] portfolio refresh failed:", e));
    loadDebtors();

    return () => {
      window.removeEventListener("messages-updated", loadMessages);
      window.removeEventListener("dispositions-updated", loadDisps);
      window.removeEventListener("portfolios-updated", loadDebtors);
    };
    // agentEmail/isSupervisor decide which debtors loadDebtors keeps, and both start empty
    // while auth resolves — without them here an agent's picker would stay empty for good.
  }, [agentEmail, isSupervisor]);

  const debtorById = useMemo(() => new Map(allDebtors.map((d) => [d.id, d])), [allDebtors]);

  // ── WhatsApp: group real messages into per-debtor conversations ──
  const conversations = useMemo(() => {
    const byDebtor = new Map<string, MessageRecord[]>();
    for (const m of messages) {
      if (m.channel !== "whatsapp" || !m.debtorId) continue;
      const list = byDebtor.get(m.debtorId) ?? [];
      list.push(m);
      byDebtor.set(m.debtorId, list);
    }
    return Array.from(byDebtor.entries())
      .map(([debtorId, msgs]) => {
        const sorted = [...msgs].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
        const last = sorted[sorted.length - 1];
        return {
          debtorId,
          name: last.debtorName || debtorById.get(debtorId)?.name || "Unknown",
          phone: last.phone || debtorById.get(debtorId)?.phone || "—",
          lastMessage: last.content,
          time: formatTime(last.sentAt),
          messages: sorted,
        };
      })
      .sort((a, b) =>
        b.messages[b.messages.length - 1].sentAt.localeCompare(
          a.messages[a.messages.length - 1].sentAt,
        ),
      );
  }, [messages, debtorById]);

  const filteredConversations = useMemo(() => {
    if (bucketFilter === "all") return conversations;
    return conversations.filter((c) => {
      const d = debtorById.get(c.debtorId);
      return d ? bucketOf(d.dpd) === bucketFilter : false;
    });
  }, [conversations, bucketFilter, debtorById]);

  // Auto-select the first conversation once data loads, if nothing is selected yet.
  useEffect(() => {
    if (!activeDebtorId && filteredConversations.length > 0) {
      setActiveDebtorId(filteredConversations[0].debtorId);
    }
  }, [filteredConversations, activeDebtorId]);

  const active = filteredConversations.find((c) => c.debtorId === activeDebtorId) ?? null;
  const activeDebtor = activeDebtorId ? debtorById.get(activeDebtorId) : undefined;

  // Debtors with no WhatsApp thread yet, for starting a new conversation.
  const composeCandidates = useMemo(
    () => allDebtors.filter((d) => !conversations.some((c) => c.debtorId === d.id)),
    [allDebtors, conversations],
  );

  const handleTemplateChange = (val: string) => {
    setTemplate(val);
    const t = WA_TEMPLATES.find((t) => t.value === val);
    const name = active?.name ?? activeDebtor?.name ?? "";
    if (t) setInput(t.text.replace("{name}", name));
  };

  const handleSend = async () => {
    if (!input.trim() || !activeDebtorId) return;
    setSending(true);
    try {
      await sendMessage({
        debtorId: activeDebtorId,
        agentEmail,
        channel: "whatsapp",
        content: input.trim(),
        templateName: WA_TEMPLATES.find((t) => t.value === template)?.label,
      });
      toast.success("Message logged for " + (active?.name ?? activeDebtor?.name ?? "debtor"));
      setInput("");
      setTemplate("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "whatsapp", label: "WhatsApp", icon: MessageSquare },
    { key: "ivr", label: "IVR Calls", icon: Radio },
    { key: "sms", label: "SMS", icon: Phone },
  ];

  // ── IVR: real call_logs where call_type = 'ivr' ──
  const ivrRecords = useMemo(
    () =>
      disps
        .filter((d) => d.callType === "ivr")
        .filter((d) => inDateRange(d.time, dateRange))
        .sort((a, b) => b.time.localeCompare(a.time)),
    [disps, dateRange],
  );

  // ── SMS: real messages where channel = 'sms' ──
  const smsRecords = useMemo(
    () =>
      messages
        .filter((m) => m.channel === "sms")
        .filter((m) => inDateRange(m.sentAt, dateRange))
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt)),
    [messages, dateRange],
  );

  return (
    <div className="animate-in fade-in duration-500 space-y-4 h-[calc(100vh-6rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Messages</h1>
          <p className="text-sm text-muted-foreground">
            WhatsApp conversations, IVR call logs, and SMS delivery status.{" "}
            {/* This used to say there was no gateway and that nothing reached the debtor. That
                stopped being true: messages-store.sendMessage now calls Exotel through
                telephony/server.ts before writing the row. Telling an agent a send goes nowhere
                when it may actually deliver is the more dangerous of the two errors. */}
            <span className="font-medium text-foreground">
              Sending attempts a real delivery via Exotel
            </span>{" "}
            — the row's status reflects whether the provider accepted it, and shows{" "}
            <span className="font-medium text-foreground">Failed</span> when credentials are missing
            or the WhatsApp template is not yet approved.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              exportCSV(
                "conversations.csv",
                ["Debtor", "Phone", "Last Message", "Time"],
                conversations.map((c) => [c.name, c.phone, c.lastMessage, c.time]),
              )
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <FileDown className="h-3.5 w-3.5" />
            Export
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg border border-border bg-muted/40 p-1 w-fit flex-shrink-0">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                "flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-all duration-150",
                activeTab === t.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* WhatsApp */}
      {activeTab === "whatsapp" && (
        <div className="flex flex-1 rounded-xl border border-border overflow-hidden min-h-0">
          {/* Sidebar */}
          <div className="w-72 border-r border-border flex flex-col flex-shrink-0 bg-card">
            <div className="p-3 border-b border-border flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Conversations
              </div>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBucketDropOpen((o) => !o)}
                  className={cn(
                    "flex items-center gap-1 h-6 rounded-md border px-2 text-[10px] transition-all",
                    bucketFilter !== "all"
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  {bucketFilter === "all" ? "All Buckets" : BUCKET_META[bucketFilter].label}
                  <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                </button>
                {bucketDropOpen && (
                  <div className="absolute right-0 top-full mt-1 z-30 w-40 rounded-lg border border-border bg-card shadow-lg py-1">
                    <button
                      type="button"
                      onClick={() => {
                        setBucketFilter("all");
                        setBucketDropOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                        bucketFilter === "all"
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      <span>All Buckets</span>
                      <span className="opacity-50">{conversations.length}</span>
                    </button>
                    {(["X", "1", "2", "NPA", "WriteOff"] as DPDBucket[]).map((b) => {
                      const count = conversations.filter((c) => {
                        const d = debtorById.get(c.debtorId);
                        return d ? bucketOf(d.dpd) === b : false;
                      }).length;
                      if (count === 0) return null;
                      return (
                        <button
                          key={b}
                          type="button"
                          onClick={() => {
                            setBucketFilter(b);
                            setBucketDropOpen(false);
                          }}
                          className={cn(
                            "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 flex items-center justify-between",
                            bucketFilter === b
                              ? "font-medium text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          <span>{BUCKET_META[b].label}</span>
                          <span className="opacity-50">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* New message picker */}
            <div className="p-2 border-b border-border relative">
              <button
                type="button"
                onClick={() => setComposeDropOpen((o) => !o)}
                disabled={composeCandidates.length === 0}
                className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <MessageSquare className="h-3 w-3" />
                New message
              </button>
              {composeDropOpen && composeCandidates.length > 0 && (
                <div className="absolute left-2 right-2 top-full mt-1 z-30 max-h-64 overflow-y-auto rounded-lg border border-border bg-card shadow-lg py-1">
                  {composeCandidates.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => {
                        setActiveDebtorId(d.id);
                        setComposeDropOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 text-foreground"
                    >
                      {d.name || "(unnamed)"}{" "}
                      <span className="text-muted-foreground">{d.phone}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <ScrollArea className="flex-1">
              {filteredConversations.length === 0 && (
                <p className="p-4 text-xs text-muted-foreground text-center">
                  No conversations yet. Use "New message" to start one.
                </p>
              )}
              {filteredConversations.map((c) => (
                <button
                  key={c.debtorId}
                  type="button"
                  onClick={() => setActiveDebtorId(c.debtorId)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent",
                    activeDebtorId === c.debtorId && "bg-primary/10 border-l-2 border-primary",
                  )}
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">
                      {initialsFor(c.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground truncate">{c.name}</span>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0 ml-1">
                        {c.time}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{c.lastMessage}</div>
                  </div>
                </button>
              ))}
            </ScrollArea>
          </div>

          {/* Chat panel */}
          <div className="flex flex-1 flex-col min-w-0 bg-background">
            {!activeDebtorId ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                {allDebtors.length === 0
                  ? "No accounts assigned yet."
                  : "Pick a conversation or start a new message."}
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b border-border bg-card flex items-center gap-3">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">
                      {initialsFor(active?.name ?? activeDebtor?.name ?? "?")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {active?.name ?? activeDebtor?.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {active?.phone ?? activeDebtor?.phone}
                    </div>
                  </div>
                </div>

                <ScrollArea className="flex-1 px-4 py-4">
                  <div className="space-y-3">
                    {(active?.messages ?? []).length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-8">
                        No messages yet — send the first one below.
                      </p>
                    )}
                    {(active?.messages ?? []).map((m) => (
                      <div
                        key={m.id}
                        className={cn(
                          "flex",
                          m.direction === "outbound" ? "justify-end" : "justify-start",
                        )}
                      >
                        <div
                          className={cn(
                            "max-w-[70%] rounded-2xl px-3 py-2 text-sm",
                            m.direction === "outbound"
                              ? "bg-primary text-primary-foreground rounded-br-sm"
                              : "bg-card border border-border text-foreground rounded-bl-sm",
                          )}
                        >
                          <p className="leading-relaxed">{m.content}</p>
                          <div
                            className={cn(
                              "flex items-center gap-1 mt-1 text-[10px]",
                              m.direction === "outbound"
                                ? "justify-end text-primary-foreground/60"
                                : "text-muted-foreground",
                            )}
                          >
                            {formatTime(m.sentAt)}
                            {m.direction === "outbound" && m.status === "read" && (
                              <CheckCheck className="h-3 w-3 text-blue-400" />
                            )}
                            {m.direction === "outbound" && m.status === "delivered" && (
                              <CheckCheck className="h-3 w-3 opacity-70" />
                            )}
                            {m.direction === "outbound" && m.status === "sent" && (
                              <Check className="h-3 w-3 opacity-70" />
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>

                <div className="border-t border-border bg-card p-3 space-y-2">
                  <Select value={template} onValueChange={handleTemplateChange}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select template…" />
                    </SelectTrigger>
                    <SelectContent>
                      {WA_TEMPLATES.map((t) => (
                        <SelectItem key={t.value} value={t.value} className="text-xs">
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2">
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="Type a message…"
                      rows={2}
                      className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
                      }}
                    />
                    <Button
                      onClick={handleSend}
                      disabled={sending || !input.trim()}
                      className="bg-success text-success-foreground hover:bg-success/90 px-4 self-stretch transition-all active:scale-95"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* IVR */}
      {activeTab === "ivr" && (
        <div className="flex-1 overflow-auto">
          <div className="mb-3 flex justify-end">
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-4">
            {[
              { label: "Total IVR Calls", value: ivrRecords.length },
              {
                label: "PTP Captured",
                value: ivrRecords.filter((r) => r.outcome === "promised").length,
              },
              {
                label: "No Answer",
                value: ivrRecords.filter((r) => r.outcome === "no_answer").length,
              },
              {
                label: "Callback Requested",
                value: ivrRecords.filter((r) => r.outcome === "callback").length,
              },
              {
                label: "Disputes",
                value: ivrRecords.filter((r) => r.outcome === "dispute").length,
              },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-foreground">{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Debtor</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead className="min-w-[200px]">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ivrRecords.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No IVR calls logged yet.
                        </TableCell>
                      </TableRow>
                    )}
                    {ivrRecords.map((r) => (
                      <TableRow key={r.id} className="hover:bg-primary/5 align-top">
                        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                          <Clock className="inline h-3 w-3 mr-1 opacity-60" />
                          {formatDateTime(r.time)}
                        </TableCell>
                        <TableCell>
                          <div className="text-sm font-medium text-foreground">
                            {r.debtorName || "—"}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {r.phone || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-sm tabular-nums">
                          {formatDuration(r.durationSeconds)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            {IVR_OUTCOME_LABEL[r.outcome] ?? r.outcome}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-foreground/80">
                          {r.notes || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* SMS */}
      {activeTab === "sms" && (
        <div className="flex-1 overflow-auto">
          <div className="mb-3 flex justify-end">
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
            {[
              { label: "Total Sent", value: smsRecords.length },
              {
                label: "Delivered",
                value: smsRecords.filter((r) => r.status === "delivered" || r.status === "read")
                  .length,
              },
              { label: "Read", value: smsRecords.filter((r) => r.status === "read").length },
              { label: "Failed", value: smsRecords.filter((r) => r.status === "failed").length },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <div className="text-2xl font-bold text-foreground">{s.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Debtor</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Template</TableHead>
                      <TableHead className="min-w-[300px]">Message</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {smsRecords.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No SMS sent yet.
                        </TableCell>
                      </TableRow>
                    )}
                    {smsRecords.map((r) => {
                      const meta = MSG_STATUS_META[r.status];
                      return (
                        <TableRow key={r.id} className="hover:bg-primary/5 align-top">
                          <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                            {formatDateTime(r.sentAt)}
                          </TableCell>
                          <TableCell>
                            <div className="text-sm font-medium text-foreground">
                              {r.debtorName || "—"}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.phone || "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              {r.templateName ?? "—"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <p className="text-xs text-foreground/80 leading-relaxed">
                              {r.content}
                            </p>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn("text-xs", meta.cls)}>
                              {meta.label}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
