import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Send,
  CheckCheck,
  Check,
  Plus,
  Phone,
  MessageSquare,
  Radio,
  ChevronDown,
  FileDown,
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
import { MOCK_DEBTORS, bucketOf, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";

export const Route = createFileRoute("/dashboard/messages")({
  head: () => ({ meta: [{ title: "Messages · RecoveryAI" }] }),
  component: MessagesPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "whatsapp" | "ivr" | "sms";

// ─── WhatsApp data ─────────────────────────────────────────────────────────────

interface Conversation {
  id: string;
  name: string;
  phone: string;
  lastMessage: string;
  time: string;
  unread: number;
  messages: {
    id: string;
    out: boolean;
    text: string;
    time: string;
    status: "sent" | "delivered" | "read";
  }[];
}

const CONVERSATIONS: Conversation[] = [
  {
    id: "L-10042",
    name: "Rahul Sharma",
    phone: "+91 98XXX XX789",
    lastMessage: "Haan sir, kal tak kar dunga UPI se.",
    time: "10:18 AM",
    unread: 0,
    messages: [
      {
        id: "1",
        out: true,
        text: "Namaste Rahul ji, aapka EMI ₹8,200 abhi due hai. Kripya aaj payment karein.",
        time: "10:15 AM",
        status: "read",
      },
      {
        id: "2",
        out: false,
        text: "Haan sir, kal tak kar dunga UPI se.",
        time: "10:18 AM",
        status: "read",
      },
      {
        id: "3",
        out: true,
        text: "Bilkul, aapka payment reference hai: TXN-L10042. Aaj hi clear karein.",
        time: "10:19 AM",
        status: "delivered",
      },
    ],
  },
  {
    id: "L-10018",
    name: "Priya Iyer",
    phone: "+91 90XXX XX221",
    lastMessage: "Sure, I will transfer by EOD today.",
    time: "9:55 AM",
    unread: 2,
    messages: [
      {
        id: "1",
        out: true,
        text: "Hi Priya, your credit card outstanding of ₹87,500 is overdue. Can we resolve this today?",
        time: "9:50 AM",
        status: "read",
      },
      {
        id: "2",
        out: false,
        text: "My salary got credited yesterday. Sure, I will transfer by EOD today.",
        time: "9:55 AM",
        status: "read",
      },
      {
        id: "3",
        out: false,
        text: "What is the account number to transfer to?",
        time: "9:56 AM",
        status: "read",
      },
    ],
  },
  {
    id: "L-10211",
    name: "Amit Verma",
    phone: "+91 99XXX XX104",
    lastMessage: "Partial payment done. Rest by Friday.",
    time: "Yesterday",
    unread: 0,
    messages: [
      {
        id: "1",
        out: true,
        text: "Amit ji, ₹1,25,000 outstanding hai. PTP confirm karna chahenge?",
        time: "Yesterday 3:00 PM",
        status: "read",
      },
      {
        id: "2",
        out: false,
        text: "Partial payment done. Rest by Friday.",
        time: "Yesterday 3:20 PM",
        status: "read",
      },
    ],
  },
  {
    id: "L-10455",
    name: "Ananya Bose",
    phone: "+91 91XXX XX334",
    lastMessage: "Ok noted, I'll check with my bank.",
    time: "Yesterday",
    unread: 1,
    messages: [
      {
        id: "1",
        out: true,
        text: "Dear Ananya, your EMI is overdue. Please clear at earliest.",
        time: "Yesterday 11:00 AM",
        status: "read",
      },
      {
        id: "2",
        out: false,
        text: "Ok noted, I'll check with my bank.",
        time: "Yesterday 11:45 AM",
        status: "read",
      },
    ],
  },
  {
    id: "L-10087",
    name: "Sneha Reddy",
    phone: "+91 97XXX XX556",
    lastMessage: "Ok will check and revert.",
    time: "Mon",
    unread: 0,
    messages: [
      {
        id: "1",
        out: true,
        text: "Hi Sneha, gentle reminder for your EMI of ₹64,000.",
        time: "Mon 2:00 PM",
        status: "read",
      },
      {
        id: "2",
        out: false,
        text: "Ok will check and revert.",
        time: "Mon 2:30 PM",
        status: "read",
      },
    ],
  },
];

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

// ─── IVR data ──────────────────────────────────────────────────────────────────

interface IVRRecord {
  id: string;
  debtorName: string;
  loanId: string;
  phone: string;
  time: string;
  duration: string;
  script: string;
  status: "completed" | "no_answer" | "dropped" | "escalated" | "opted_out";
  keypress: string | null;
  outcome: string | null;
}

const IVR_RECORDS: IVRRecord[] = [
  {
    id: "IVR-001",
    debtorName: "Rakesh Tiwari",
    loanId: "L-10712",
    phone: "+91 90XXX XX311",
    time: "09:05 AM",
    duration: "2m 14s",
    script: "Hindi Payment Reminder v3",
    status: "completed",
    keypress: "1 – Confirm PTP",
    outcome: "PTP captured: ₹8,500 by 25 Jun",
  },
  {
    id: "IVR-002",
    debtorName: "Sunita Rao",
    loanId: "L-10544",
    phone: "+91 98XXX XX901",
    time: "09:12 AM",
    duration: "—",
    script: "English Overdue Notice",
    status: "no_answer",
    keypress: null,
    outcome: "Retry scheduled 2h",
  },
  {
    id: "IVR-003",
    debtorName: "Firoz Khan",
    loanId: "L-10388",
    phone: "+91 91XXX XX220",
    time: "09:48 AM",
    duration: "1m 55s",
    script: "Urdu Gentle Reminder v2",
    status: "completed",
    keypress: "2 – Request Callback",
    outcome: "Callback queued for agent",
  },
  {
    id: "IVR-004",
    debtorName: "Lalitha Devi",
    loanId: "L-10631",
    phone: "+91 97XXX XX540",
    time: "10:02 AM",
    duration: "0m 18s",
    script: "Telugu EMI Due Notice",
    status: "dropped",
    keypress: null,
    outcome: "Call dropped after intro",
  },
  {
    id: "IVR-005",
    debtorName: "Hemant Sharma",
    loanId: "L-10290",
    phone: "+91 99XXX XX174",
    time: "10:21 AM",
    duration: "0m 52s",
    script: "Hindi Payment Reminder v3",
    status: "escalated",
    keypress: "0 – Speak to Agent",
    outcome: "Transferred to agent queue",
  },
  {
    id: "IVR-006",
    debtorName: "Geetha Pillai",
    loanId: "L-10457",
    phone: "+91 98XXX XX602",
    time: "10:55 AM",
    duration: "1m 30s",
    script: "Kannada Settlement Offer",
    status: "completed",
    keypress: "1 – Confirm interest",
    outcome: "Settlement interest noted",
  },
  {
    id: "IVR-007",
    debtorName: "Mohan Lal",
    loanId: "L-10711",
    phone: "+91 97XXX XX133",
    time: "11:10 AM",
    duration: "0m 08s",
    script: "Hindi Payment Reminder v3",
    status: "opted_out",
    keypress: "9 – DNC opt out",
    outcome: "Added to DNC list",
  },
  {
    id: "IVR-008",
    debtorName: "Rekha Patel",
    loanId: "L-10350",
    phone: "+91 91XXX XX804",
    time: "11:38 AM",
    duration: "1m 48s",
    script: "Gujarati Overdue v1",
    status: "completed",
    keypress: "1 – Confirm PTP",
    outcome: "PTP captured: ₹6,200 by 23 Jun",
  },
  {
    id: "IVR-009",
    debtorName: "Divya Krishnan",
    loanId: "L-10333",
    phone: "+91 97XXX XX115",
    time: "12:05 PM",
    duration: "—",
    script: "Tamil Gentle Reminder v2",
    status: "no_answer",
    keypress: null,
    outcome: "Max retries reached",
  },
  {
    id: "IVR-010",
    debtorName: "Karthik Nair",
    loanId: "L-10122",
    phone: "+91 99XXX XX901",
    time: "13:15 PM",
    duration: "2m 01s",
    script: "Malayalam Payment Reminder",
    status: "escalated",
    keypress: "0 – Speak to Agent",
    outcome: "Dispute raised — escalated",
  },
];

const IVR_STATUS_META: Record<IVRRecord["status"], { label: string; cls: string }> = {
  completed: { label: "Completed", cls: "bg-success/8 text-success/70 border-success/15" },
  no_answer: { label: "No Answer", cls: "bg-muted text-muted-foreground border-border" },
  dropped: { label: "Dropped", cls: "bg-warning/8 text-warning-foreground/70 border-warning/15" },
  escalated: { label: "Escalated", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
  opted_out: {
    label: "DNC Opt-out",
    cls: "bg-destructive/8 text-destructive/70 border-destructive/15",
  },
};

// ─── SMS data ──────────────────────────────────────────────────────────────────

interface SMSRecord {
  id: string;
  debtorName: string;
  loanId: string;
  phone: string;
  time: string;
  template: string;
  message: string;
  status: "delivered" | "failed" | "pending" | "read";
}

const SMS_RECORDS: SMSRecord[] = [
  {
    id: "SMS-001",
    debtorName: "Rahul Sharma",
    loanId: "L-10042",
    phone: "+91 98XXX XX789",
    time: "08:30 AM",
    template: "EMI Reminder",
    message:
      "Dear Rahul, your EMI of ₹8,200 is due today. Pl pay to avoid late charges. -RecoveryAI",
    status: "read",
  },
  {
    id: "SMS-002",
    debtorName: "Priya Iyer",
    loanId: "L-10018",
    phone: "+91 90XXX XX221",
    time: "08:31 AM",
    template: "EMI Reminder",
    message:
      "Dear Priya, your CC outstanding of ₹87,500 is overdue. Contact us at 1800-XXX-XXXX. -RecoveryAI",
    status: "delivered",
  },
  {
    id: "SMS-003",
    debtorName: "Amit Verma",
    loanId: "L-10211",
    phone: "+91 99XXX XX104",
    time: "08:31 AM",
    template: "PTP Confirmation",
    message:
      "Dear Amit, we confirm your PTP of ₹1,25,000 by 25 Jun. Please ensure funds are available. -RecoveryAI",
    status: "delivered",
  },
  {
    id: "SMS-004",
    debtorName: "Sneha Reddy",
    loanId: "L-10087",
    phone: "+91 97XXX XX556",
    time: "08:32 AM",
    template: "Callback Request",
    message:
      "Dear Sneha, our agent will call you at 6 PM today. Please keep your phone reachable. -RecoveryAI",
    status: "read",
  },
  {
    id: "SMS-005",
    debtorName: "Vikram Singh",
    loanId: "L-10309",
    phone: "+91 98XXX XX012",
    time: "08:32 AM",
    template: "Overdue Notice",
    message:
      "Dear Vikram, your loan account L-10309 has outstanding dues. Contact us immediately. -RecoveryAI",
    status: "failed",
  },
  {
    id: "SMS-006",
    debtorName: "Ananya Bose",
    loanId: "L-10455",
    phone: "+91 91XXX XX334",
    time: "08:33 AM",
    template: "EMI Reminder",
    message:
      "Dear Ananya, your EMI is due. Please transfer to A/C 1234567890, IFSC HDFC0001234. -RecoveryAI",
    status: "delivered",
  },
  {
    id: "SMS-007",
    debtorName: "Rohan Mehta",
    loanId: "L-10501",
    phone: "+91 90XXX XX448",
    time: "08:34 AM",
    template: "Legal Notice",
    message:
      "NOTICE: Loan L-10501 is 88 DPD. Legal proceedings may commence. Resolve immediately. -RecoveryAI",
    status: "pending",
  },
  {
    id: "SMS-008",
    debtorName: "Karthik Nair",
    loanId: "L-10122",
    phone: "+91 99XXX XX901",
    time: "09:00 AM",
    template: "Settlement Offer",
    message:
      "Dear Karthik, special settlement at 20% waiver. Valid till 30 Jun. Call 1800-XXX-XXXX. -RecoveryAI",
    status: "delivered",
  },
  {
    id: "SMS-009",
    debtorName: "Meera Joshi",
    loanId: "L-10277",
    phone: "+91 98XXX XX670",
    time: "09:01 AM",
    template: "PTP Confirmation",
    message:
      "Dear Meera, PTP of ₹95,000 confirmed for 22 Jun. Thank you for your cooperation. -RecoveryAI",
    status: "read",
  },
  {
    id: "SMS-010",
    debtorName: "Tarun Desai",
    loanId: "L-10366",
    phone: "+91 99XXX XX590",
    time: "09:05 AM",
    template: "Legal Notice",
    message:
      "FINAL NOTICE: Loan L-10366 is 105 DPD. Legal action initiated. Resolve within 7 days. -RecoveryAI",
    status: "delivered",
  },
];

const SMS_STATUS_META: Record<SMSRecord["status"], { label: string; cls: string }> = {
  delivered: { label: "Delivered", cls: "bg-success/8 text-success/70 border-success/15" },
  read: { label: "Read", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
  failed: { label: "Failed", cls: "bg-destructive/8 text-destructive/70 border-destructive/15" },
  pending: { label: "Pending", cls: "bg-muted text-muted-foreground border-border" },
};

// ─── Page ─────────────────────────────────────────────────────────────────────

function MessagesPage() {
  const [activeTab, setActiveTab] = useState<Tab>("whatsapp");
  const [activeId, setActiveId] = useState(CONVERSATIONS[0].id);
  const [template, setTemplate] = useState("");
  const [input, setInput] = useState("");
  const [bucketFilter, setBucketFilter] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);

  const active = CONVERSATIONS.find((c) => c.id === activeId)!;

  const filteredConversations =
    bucketFilter === "all"
      ? CONVERSATIONS
      : CONVERSATIONS.filter((c) => {
          const debtor = MOCK_DEBTORS.find((d) => d.id === c.id);
          return debtor ? bucketOf(debtor.dpd) === bucketFilter : false;
        });

  const handleTemplateChange = (val: string) => {
    setTemplate(val);
    const t = WA_TEMPLATES.find((t) => t.value === val);
    if (t) setInput(t.text.replace("{name}", active.name).replace("{id}", activeId));
  };

  const handleSend = () => {
    if (!input.trim()) return;
    toast.success("Message sent to " + active.name);
    setInput("");
    setTemplate("");
  };

  const TABS: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "whatsapp", label: "WhatsApp", icon: MessageSquare },
    { key: "ivr", label: "IVR Calls", icon: Radio },
    { key: "sms", label: "SMS", icon: Phone },
  ];

  return (
    <div className="animate-in fade-in duration-500 space-y-4 h-[calc(100vh-6rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Messages</h1>
          <p className="text-sm text-muted-foreground">
            WhatsApp conversations, IVR call logs, and SMS delivery status.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              exportCSV(
                "conversations.csv",
                ["Loan ID", "Name", "Phone", "Last Message", "Time", "Unread"],
                CONVERSATIONS.map((c) => [c.id, c.name, c.phone, c.lastMessage, c.time, c.unread]),
              )
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <FileDown className="h-3.5 w-3.5" />
            Export
          </button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => toast.info("Campaign builder coming soon")}
          >
            <Plus className="h-4 w-4" />
            New Campaign
          </Button>
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
                      <span className="opacity-50">{CONVERSATIONS.length}</span>
                    </button>
                    {(["X", "1", "2", "NPA", "WriteOff"] as DPDBucket[]).map((b) => {
                      const count = CONVERSATIONS.filter((c) => {
                        const d = MOCK_DEBTORS.find((dd) => dd.id === c.id);
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
            <ScrollArea className="flex-1">
              {filteredConversations.map((c) => {
                const initials = c.name
                  .split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase();
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setActiveId(c.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-accent",
                      activeId === c.id && "bg-primary/10 border-l-2 border-primary",
                    )}
                  >
                    <Avatar className="h-9 w-9 flex-shrink-0">
                      <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-foreground truncate">
                          {c.name}
                        </span>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0 ml-1">
                          {c.time}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs text-muted-foreground truncate">
                          {c.lastMessage}
                        </span>
                        {c.unread > 0 && (
                          <Badge className="h-4 w-4 p-0 text-[9px] flex items-center justify-center rounded-full bg-primary text-primary-foreground flex-shrink-0">
                            {c.unread}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </ScrollArea>
          </div>

          {/* Chat panel */}
          <div className="flex flex-1 flex-col min-w-0 bg-background">
            <div className="px-4 py-3 border-b border-border bg-card flex items-center gap-3">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">
                  {active.name
                    .split(" ")
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-sm font-semibold text-foreground">{active.name}</div>
                <div className="text-xs text-muted-foreground">
                  {active.phone} · {active.id}
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1 px-4 py-4">
              <div className="space-y-3">
                {active.messages.map((m) => (
                  <div key={m.id} className={cn("flex", m.out ? "justify-end" : "justify-start")}>
                    <div
                      className={cn(
                        "max-w-[70%] rounded-2xl px-3 py-2 text-sm",
                        m.out
                          ? "bg-primary text-primary-foreground rounded-br-sm"
                          : "bg-card border border-border text-foreground rounded-bl-sm",
                      )}
                    >
                      <p className="leading-relaxed">{m.text}</p>
                      <div
                        className={cn(
                          "flex items-center gap-1 mt-1 text-[10px]",
                          m.out
                            ? "justify-end text-primary-foreground/60"
                            : "text-muted-foreground",
                        )}
                      >
                        {m.time}
                        {m.out && m.status === "read" && (
                          <CheckCheck className="h-3 w-3 text-blue-400" />
                        )}
                        {m.out && m.status === "delivered" && (
                          <CheckCheck className="h-3 w-3 opacity-70" />
                        )}
                        {m.out && m.status === "sent" && <Check className="h-3 w-3 opacity-70" />}
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
                  className="bg-success text-success-foreground hover:bg-success/90 px-4 self-stretch transition-all active:scale-95"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* IVR */}
      {activeTab === "ivr" && (
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-4">
            {[
              { label: "Total IVR Calls", value: IVR_RECORDS.length },
              {
                label: "Completed",
                value: IVR_RECORDS.filter((r) => r.status === "completed").length,
              },
              {
                label: "No Answer",
                value: IVR_RECORDS.filter((r) => r.status === "no_answer").length,
              },
              {
                label: "Escalated",
                value: IVR_RECORDS.filter((r) => r.status === "escalated").length,
              },
              {
                label: "DNC Opt-out",
                value: IVR_RECORDS.filter((r) => r.status === "opted_out").length,
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
                      <TableHead>Script</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Keypress</TableHead>
                      <TableHead className="min-w-[200px]">Outcome</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {IVR_RECORDS.map((r, i) => {
                      const meta = IVR_STATUS_META[r.status];
                      return (
                        <TableRow
                          key={r.id}
                          className="hover:bg-primary/5 align-top"
                          style={{ animationDelay: `${i * 30}ms` }}
                        >
                          <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                            {r.time}
                          </TableCell>
                          <TableCell>
                            <div className="text-sm font-medium text-foreground">
                              {r.debtorName}
                            </div>
                            <div className="text-[11px] text-muted-foreground">{r.loanId}</div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.phone}
                          </TableCell>
                          <TableCell className="text-xs text-foreground/80 max-w-[140px]">
                            {r.script}
                          </TableCell>
                          <TableCell className="font-mono text-sm tabular-nums">
                            {r.duration}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn("text-xs", meta.cls)}>
                              {meta.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.keypress ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs text-foreground/80">
                            {r.outcome ?? "—"}
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

      {/* SMS */}
      {activeTab === "sms" && (
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
            {[
              { label: "Total Sent", value: SMS_RECORDS.length },
              {
                label: "Delivered",
                value: SMS_RECORDS.filter((r) => r.status === "delivered" || r.status === "read")
                  .length,
              },
              { label: "Read", value: SMS_RECORDS.filter((r) => r.status === "read").length },
              { label: "Failed", value: SMS_RECORDS.filter((r) => r.status === "failed").length },
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
                    {SMS_RECORDS.map((r, i) => {
                      const meta = SMS_STATUS_META[r.status];
                      return (
                        <TableRow
                          key={r.id}
                          className="hover:bg-primary/5 align-top"
                          style={{ animationDelay: `${i * 30}ms` }}
                        >
                          <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                            {r.time}
                          </TableCell>
                          <TableCell>
                            <div className="text-sm font-medium text-foreground">
                              {r.debtorName}
                            </div>
                            <div className="text-[11px] text-muted-foreground">{r.loanId}</div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.phone}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              {r.template}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <p className="text-xs text-foreground/80 leading-relaxed">
                              {r.message}
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
