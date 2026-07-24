import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import {
  IndianRupee,
  CheckCircle2,
  Clock,
  TrendingUp,
  Search,
  X,
  FileDown,
  Filter,
  CreditCard,
  Banknote,
  Smartphone,
  RefreshCcw,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatINR, bucketOf, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";

export const Route = createFileRoute("/dashboard/payments")({
  head: () => ({ meta: [{ title: "Payments · RecoveryAI" }] }),
  component: PaymentsPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type PaymentMethod = "UPI" | "NEFT" | "RTGS" | "eNACH" | "Cash" | "Cheque";
type PaymentStatus = "confirmed" | "pending_verification" | "bounced" | "partial";
type SettlementStatus = "approved" | "pending_approval" | "rejected";

interface PaymentRecord {
  id: string;
  debtorName: string;
  loanId: string;
  phone: string;
  portfolio: string;
  amount: number;
  method: PaymentMethod;
  ref: string;
  date: string;
  time: string;
  status: PaymentStatus;
  collectedBy: "agent" | "ai" | "self";
  agentName: string;
  lender: string;
  product: string;
  dpd: number;
  verifiedAt?: string;
}

interface SettlementRecord {
  id: string;
  debtorName: string;
  loanId: string;
  outstanding: number;
  settlementAmount: number;
  waiver: number;
  date: string;
  status: SettlementStatus;
  approvedBy?: string;
  agentName: string;
  reason: string;
}

// ─── Mock data — represents confirmed collections from uploaded Excel ─────────

const PAYMENTS: PaymentRecord[] = [
  {
    id: "RX-001",
    debtorName: "Amit Verma",
    loanId: "L-10211",
    phone: "+91 99XXX XX104",
    portfolio: "Personal Loan Q2",
    amount: 50000,
    method: "UPI",
    ref: "UPI20260622AMTV1234",
    date: "22 Jun 2026",
    time: "09:45 AM",
    status: "confirmed",
    collectedBy: "agent",
    agentName: "Ravi M.",
    lender: "HDFC Bank",
    product: "Personal Loan",
    dpd: 14,
    verifiedAt: "22 Jun 09:47 AM",
  },
  {
    id: "RX-002",
    debtorName: "Priya Iyer",
    loanId: "L-10018",
    phone: "+91 90XXX XX221",
    portfolio: "Credit Card NPA",
    amount: 87500,
    method: "NEFT",
    ref: "NEFT20260621PIY10018",
    date: "21 Jun 2026",
    time: "04:12 PM",
    status: "confirmed",
    collectedBy: "agent",
    agentName: "You",
    lender: "Bajaj Finance",
    product: "Credit Card NPA",
    dpd: 45,
    verifiedAt: "21 Jun 04:20 PM",
  },
  {
    id: "RX-003",
    debtorName: "Divya Krishnan",
    loanId: "L-10333",
    phone: "+91 97XXX XX115",
    portfolio: "Personal Loan Q2",
    amount: 27500,
    method: "UPI",
    ref: "UPI20260622DIVK0333",
    date: "22 Jun 2026",
    time: "11:30 AM",
    status: "confirmed",
    collectedBy: "agent",
    agentName: "You",
    lender: "Axis Bank",
    product: "Personal Loan",
    dpd: 22,
    verifiedAt: "22 Jun 11:31 AM",
  },
  {
    id: "RX-004",
    debtorName: "Rahul Sharma",
    loanId: "L-10042",
    phone: "+91 98XXX XX789",
    portfolio: "Personal Loan Q2",
    amount: 8200,
    method: "eNACH",
    ref: "NACH20260515RHS10042",
    date: "15 May 2026",
    time: "12:00 AM",
    status: "confirmed",
    collectedBy: "self",
    agentName: "—",
    lender: "HDFC Bank",
    product: "Personal Loan",
    dpd: 30,
    verifiedAt: "15 May 12:02 AM",
  },
  {
    id: "RX-005",
    debtorName: "Meera Joshi",
    loanId: "L-10277",
    phone: "+91 98XXX XX670",
    portfolio: "MSME Working Cap",
    amount: 42000,
    method: "RTGS",
    ref: "RTGS20260620MJO10277",
    date: "20 Jun 2026",
    time: "02:05 PM",
    status: "confirmed",
    collectedBy: "agent",
    agentName: "Pooja S.",
    lender: "SBI",
    product: "MSME Loan",
    dpd: 8,
    verifiedAt: "20 Jun 02:30 PM",
  },
  {
    id: "RX-006",
    debtorName: "Arjun Kapoor",
    loanId: "L-10068",
    phone: "+91 91XXX XX833",
    portfolio: "Credit Card NPA",
    amount: 19500,
    method: "UPI",
    ref: "UPI20260622AKA10068",
    date: "22 Jun 2026",
    time: "02:48 PM",
    status: "confirmed",
    collectedBy: "agent",
    agentName: "You",
    lender: "Bajaj Finance",
    product: "Credit Card NPA",
    dpd: 38,
    verifiedAt: "22 Jun 02:49 AM",
  },
  {
    id: "RX-007",
    debtorName: "Rekha Patel",
    loanId: "L-10350",
    phone: "+91 91XXX XX804",
    portfolio: "Two-Wheeler Auto",
    amount: 6400,
    method: "UPI",
    ref: "UPI20260622RPT10350",
    date: "22 Jun 2026",
    time: "01:41 PM",
    status: "confirmed",
    collectedBy: "ai",
    agentName: "AI Bot",
    lender: "Bajaj Auto",
    product: "Two-Wheeler Loan",
    dpd: 20,
    verifiedAt: "22 Jun 01:42 PM",
  },
  {
    id: "RX-008",
    debtorName: "Karthik Nair",
    loanId: "L-10122",
    phone: "+91 99XXX XX901",
    portfolio: "Personal Loan Q2",
    amount: 52000,
    method: "NEFT",
    ref: "NEFT20260621KNA10122",
    date: "21 Jun 2026",
    time: "10:10 AM",
    status: "pending_verification",
    collectedBy: "agent",
    agentName: "You",
    lender: "ICICI Bank",
    product: "Personal Loan",
    dpd: 55,
  },
  {
    id: "RX-009",
    debtorName: "Sneha Reddy",
    loanId: "L-10087",
    phone: "+91 97XXX XX556",
    portfolio: "Personal Loan Q2",
    amount: 9800,
    method: "Cheque",
    ref: "CHQ-00442",
    date: "19 Jun 2026",
    time: "03:20 PM",
    status: "bounced",
    collectedBy: "agent",
    agentName: "Ravi M.",
    lender: "HDFC Bank",
    product: "Personal Loan",
    dpd: 18,
  },
  {
    id: "RX-010",
    debtorName: "Imran Sheikh",
    loanId: "L-10478",
    phone: "+91 91XXX XX642",
    portfolio: "MSME Working Cap",
    amount: 5500,
    method: "UPI",
    ref: "UPI20260618ISH10478",
    date: "18 Jun 2026",
    time: "05:15 PM",
    status: "partial",
    collectedBy: "agent",
    agentName: "Anita K.",
    lender: "Axis Bank",
    product: "MSME Loan",
    dpd: 62,
    verifiedAt: "18 Jun 05:16 PM",
  },
  {
    id: "RX-011",
    debtorName: "Sara Khan",
    loanId: "L-10612",
    phone: "+91 90XXX XX174",
    portfolio: "Two-Wheeler Auto",
    amount: 12500,
    method: "UPI",
    ref: "UPI20260622SKA10612",
    date: "22 Jun 2026",
    time: "02:28 PM",
    status: "confirmed",
    collectedBy: "agent",
    agentName: "You",
    lender: "Bajaj Auto",
    product: "Two-Wheeler Loan",
    dpd: 11,
    verifiedAt: "22 Jun 02:29 PM",
  },
  {
    id: "RX-012",
    debtorName: "Manish Gupta",
    loanId: "L-10145",
    phone: "+91 97XXX XX461",
    portfolio: "Personal Loan Q2",
    amount: 9500,
    method: "eNACH",
    ref: "NACH20260601MGU10145",
    date: "1 Jun 2026",
    time: "12:00 AM",
    status: "confirmed",
    collectedBy: "self",
    agentName: "—",
    lender: "HDFC Bank",
    product: "Personal Loan",
    dpd: 25,
    verifiedAt: "1 Jun 12:01 AM",
  },
];

const SETTLEMENTS: SettlementRecord[] = [
  {
    id: "STL-001",
    debtorName: "Vikram Singh",
    loanId: "L-10309",
    outstanding: 148000,
    settlementAmount: 120000,
    waiver: 19,
    date: "20 Jun 2026",
    status: "approved",
    approvedBy: "Sanjay M. (Manager)",
    agentName: "You",
    reason: "Long-term NPA, debtor agreed to one-time settlement",
  },
  {
    id: "STL-002",
    debtorName: "Deepak Rawat",
    loanId: "L-09655",
    outstanding: 370000,
    settlementAmount: 300000,
    waiver: 19,
    date: "18 Jun 2026",
    status: "pending_approval",
    agentName: "Pooja S.",
    reason: "Dispute resolved, debtor willing to settle at 80%",
  },
  {
    id: "STL-003",
    debtorName: "Naresh Kumar",
    loanId: "L-09488",
    outstanding: 128000,
    settlementAmount: 90000,
    waiver: 30,
    date: "15 Jun 2026",
    status: "rejected",
    approvedBy: "Sanjay M. (Manager)",
    agentName: "Ravi M.",
    reason: "Requested 30% waiver — exceeds policy threshold",
  },
];

// ─── Status & method metadata ─────────────────────────────────────────────────

const STATUS_META: Record<PaymentStatus, { label: string; cls: string }> = {
  confirmed: { label: "Confirmed", cls: "bg-success/8 text-success/70 border-success/15" },
  pending_verification: {
    label: "Pending Verify",
    cls: "bg-warning/8 text-warning-foreground/70 border-warning/15",
  },
  bounced: { label: "Bounced", cls: "bg-destructive/8 text-destructive/70 border-destructive/15" },
  partial: { label: "Partial", cls: "bg-blue-500/8 text-blue-500/70 border-blue-400/15" },
};

const SETTLEMENT_META: Record<SettlementStatus, { label: string; cls: string }> = {
  approved: { label: "Approved", cls: "bg-success/8 text-success/70 border-success/15" },
  pending_approval: {
    label: "Pending Approval",
    cls: "bg-warning/8 text-warning-foreground/70 border-warning/15",
  },
  rejected: {
    label: "Rejected",
    cls: "bg-destructive/8 text-destructive/70 border-destructive/15",
  },
};

const METHOD_CLS: Record<string, string> = {
  UPI: "bg-primary/8 text-primary/70 border-primary/15",
  NEFT: "bg-muted text-muted-foreground border-border",
  RTGS: "bg-muted text-muted-foreground border-border",
  eNACH: "bg-accent text-accent-foreground border-border",
  Cash: "bg-success/8 text-success/70 border-success/15",
  Cheque: "bg-warning/8 text-warning-foreground/70 border-warning/15",
};

const COLLECTOR_CLS: Record<string, string> = {
  agent: "bg-muted text-muted-foreground border-border",
  ai: "bg-violet-500/8 text-violet-500/70 border-violet-400/15",
  self: "bg-blue-500/8 text-blue-500/70 border-blue-400/15",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

function PaymentsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | "all">("all");
  const [methodFilter, setMethodFilter] = useState<PaymentMethod | "all">("all");
  const [bucketFilter, setBucketFilter] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PAYMENTS.filter((p) => {
      const matchSearch =
        !q ||
        p.debtorName.toLowerCase().includes(q) ||
        p.loanId.toLowerCase().includes(q) ||
        p.ref.toLowerCase().includes(q);
      const matchStatus = statusFilter === "all" || p.status === statusFilter;
      const matchMethod = methodFilter === "all" || p.method === methodFilter;
      const matchBucket = bucketFilter === "all" || bucketOf(p.dpd) === bucketFilter;
      return matchSearch && matchStatus && matchMethod && matchBucket;
    });
  }, [search, statusFilter, methodFilter, bucketFilter]);

  const confirmedToday = PAYMENTS.filter(
    (p) => p.date === "22 Jun 2026" && p.status === "confirmed",
  );
  const confirmedAmount = confirmedToday.reduce((s, p) => s + p.amount, 0);
  const totalMonth = PAYMENTS.filter((p) => p.status === "confirmed").reduce(
    (s, p) => s + p.amount,
    0,
  );
  const pendingCount = PAYMENTS.filter((p) => p.status === "pending_verification").length;
  const bouncedCount = PAYMENTS.filter((p) => p.status === "bounced").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Confirmed collections from uploaded portfolio. Reference numbers sourced from Excel data.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 animate-in fade-in duration-400">
        {[
          {
            label: "Collected Today",
            value: formatINR(confirmedAmount),
            sub: `${confirmedToday.length} transactions`,
            icon: IndianRupee,
            cls: "text-success",
          },
          {
            label: "Month to Date",
            value: formatINR(totalMonth),
            sub: "Confirmed only",
            icon: TrendingUp,
            cls: "text-primary",
          },
          {
            label: "Pending Verify",
            value: pendingCount.toString(),
            sub: "Awaiting bank confirmation",
            icon: Clock,
            cls: "text-warning-foreground",
          },
          {
            label: "Bounced / Failed",
            value: bouncedCount.toString(),
            sub: "Requires follow-up",
            icon: AlertTriangle,
            cls: "text-destructive",
          },
        ].map((s, i) => (
          <Card
            key={s.label}
            className="animate-in fade-in duration-400"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <CardContent className="p-4 flex items-start gap-3">
              <div className={cn("mt-0.5", s.cls)}>
                <s.icon className="h-4 w-4" />
              </div>
              <div>
                <div className={cn("text-xl font-bold", s.cls)}>{s.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                <div className="text-[11px] text-muted-foreground/70">{s.sub}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs: Collections | Settlements */}
      <Tabs defaultValue="collections">
        <TabsList className="bg-muted/50 h-9">
          <TabsTrigger value="collections" className="text-sm">
            Collections
          </TabsTrigger>
          <TabsTrigger value="settlements" className="text-sm">
            Settlements
          </TabsTrigger>
        </TabsList>

        {/* ── Collections ── */}
        <TabsContent value="collections" className="space-y-3 mt-4">
          {/* Filters row: search + status pills + bucket dropdown + method dropdown */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search debtor, ref, loan…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm w-48"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Status pills */}
            <div className="flex gap-1.5 flex-wrap">
              {(
                [
                  { key: "all", label: "All" },
                  { key: "confirmed", label: "Confirmed" },
                  { key: "pending_verification", label: "Pending" },
                  { key: "bounced", label: "Bounced" },
                  { key: "partial", label: "Partial" },
                ] as const
              ).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setStatusFilter(f.key)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-all",
                    statusFilter === f.key
                      ? "bg-foreground text-background border-foreground"
                      : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Bucket dropdown */}
            <div className="relative ml-auto">
              <button
                type="button"
                onClick={() => setBucketDropOpen((o) => !o)}
                className={cn(
                  "flex items-center gap-1.5 h-8 rounded-lg border px-2.5 text-xs transition-all",
                  bucketFilter !== "all"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {bucketFilter === "all" ? "Bucket" : BUCKET_META[bucketFilter].label}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
              {bucketDropOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 w-44 rounded-lg border border-border bg-card shadow-lg py-1">
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
                    <span className="opacity-50">{PAYMENTS.length}</span>
                  </button>
                  {(["X", "1", "2", "NPA", "WriteOff"] as DPDBucket[]).map((b) => {
                    const count = PAYMENTS.filter((p) => bucketOf(p.dpd) === b).length;
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

            {/* Method pills */}
            <div className="flex gap-1.5 flex-wrap">
              {(["all", "UPI", "NEFT", "RTGS", "eNACH", "Cheque"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethodFilter(m)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
                    methodFilter === m
                      ? "bg-foreground text-background border-foreground"
                      : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  {m === "all" ? "All methods" : m}
                </button>
              ))}
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">
                  {filtered.length} records
                  {statusFilter !== "all" || methodFilter !== "all" ? " (filtered)" : ""}
                </CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    const headers = [
                      "Date",
                      "Debtor",
                      "Loan ID",
                      "Amount",
                      "Method",
                      "Status",
                      "Reference",
                      "Verified By",
                      "DPD Bucket",
                    ];
                    const rows = filtered.map((p) => [
                      p.date,
                      p.debtorName,
                      p.loanId,
                      p.amount,
                      p.method,
                      p.status,
                      p.ref,
                      p.verifiedAt ?? "",
                      p.dpd,
                    ]);
                    const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
                    const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
                    const blob = new Blob([csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "payments.csv";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <FileDown className="h-3.5 w-3.5" />
                  Export
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto max-h-[540px]">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>Debtor</TableHead>
                      <TableHead>Portfolio / Product</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Reference No.</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Collected By</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={9}
                          className="text-center py-12 text-sm text-muted-foreground"
                        >
                          No payments match this filter.
                        </TableCell>
                      </TableRow>
                    )}
                    {filtered.map((p) => {
                      const sMeta = STATUS_META[p.status];
                      const expanded = expandedId === p.id;
                      return (
                        <>
                          <TableRow
                            key={p.id}
                            className={cn(
                              "hover:bg-primary/5 cursor-pointer",
                              p.status === "bounced" && "bg-destructive/5",
                            )}
                            onClick={() => setExpandedId(expanded ? null : p.id)}
                          >
                            <TableCell>
                              <div className="font-medium text-sm">{p.debtorName}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {p.loanId} · DPD {p.dpd}d
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm text-foreground">{p.portfolio}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {p.product} · {p.lender}
                              </div>
                            </TableCell>
                            <TableCell
                              className={cn(
                                "text-right font-semibold text-sm",
                                p.status === "confirmed"
                                  ? "text-success"
                                  : p.status === "bounced"
                                    ? "text-destructive"
                                    : "text-foreground",
                              )}
                            >
                              {formatINR(p.amount)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn("text-xs", METHOD_CLS[p.method])}
                              >
                                {p.method}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {p.ref}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                              {p.date}
                              <br />
                              {p.time}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={cn("text-xs", sMeta.cls)}>
                                {sMeta.label}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn("text-xs capitalize", COLLECTOR_CLS[p.collectedBy])}
                              >
                                {p.collectedBy === "self"
                                  ? "Self-pay"
                                  : p.collectedBy === "ai"
                                    ? "AI Bot"
                                    : p.agentName}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {expanded ? (
                                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </TableCell>
                          </TableRow>

                          {/* Expanded detail row */}
                          {expanded && (
                            <TableRow
                              key={p.id + "-detail"}
                              className="bg-muted/20 hover:bg-muted/20"
                            >
                              <TableCell colSpan={9} className="py-3 px-6">
                                <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
                                  {[
                                    ["Full Reference", p.ref],
                                    ["Verification Time", p.verifiedAt ?? "—"],
                                    ["Debtor Phone", p.phone],
                                    [
                                      "Agent",
                                      p.collectedBy === "self"
                                        ? "Self-pay (no agent)"
                                        : p.agentName,
                                    ],
                                  ].map(([label, val]) => (
                                    <div key={String(label)}>
                                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        {label}
                                      </div>
                                      <div className="font-medium text-foreground mt-0.5">
                                        {val}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                {p.status === "bounced" && (
                                  <div className="mt-3 flex items-center gap-2">
                                    <AlertTriangle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
                                    <p className="text-xs text-destructive">
                                      Cheque bounced — requires immediate follow-up. Re-present or
                                      collect alternate payment.
                                    </p>
                                    <Button
                                      size="sm"
                                      className="ml-auto h-7 px-2 text-xs gap-1"
                                      onClick={() =>
                                        toast.info("Follow-up task created for " + p.debtorName)
                                      }
                                    >
                                      Create Follow-up
                                    </Button>
                                  </div>
                                )}
                                {p.status === "pending_verification" && (
                                  <div className="mt-3 flex items-center gap-2">
                                    <RefreshCcw
                                      className="h-3.5 w-3.5 text-warning-foreground flex-shrink-0 animate-spin"
                                      style={{ animationDuration: "3s" }}
                                    />
                                    <p className="text-xs text-warning-foreground">
                                      Awaiting bank confirmation. Auto-reconciliation runs every 15
                                      minutes.
                                    </p>
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Summary by method */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(["UPI", "NEFT", "RTGS", "eNACH", "Cash", "Cheque"] as PaymentMethod[]).map((m) => {
              const total = PAYMENTS.filter(
                (p) => p.method === m && p.status === "confirmed",
              ).reduce((s, p) => s + p.amount, 0);
              const count = PAYMENTS.filter((p) => p.method === m).length;
              if (count === 0) return null;
              return (
                <Card key={m} className="animate-in fade-in duration-400">
                  <CardContent className="p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      {m === "UPI" && <Smartphone className="h-3.5 w-3.5 text-primary" />}
                      {(m === "NEFT" || m === "RTGS") && (
                        <Banknote className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {(m === "eNACH" || m === "Cash" || m === "Cheque") && (
                        <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-xs font-semibold text-foreground">{m}</span>
                    </div>
                    <div className="text-sm font-bold text-foreground">
                      {total > 0 ? formatINR(total) : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {count} transaction{count !== 1 ? "s" : ""}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        {/* ── Settlements ── */}
        <TabsContent value="settlements" className="mt-4">
          <Card>
            <CardHeader className="pb-3 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold">Settlement Proposals</CardTitle>
                <span className="text-xs text-muted-foreground">
                  Manager approval required for waivers above 15%
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-auto max-h-[400px]">
                <Table>
                  <TableHeader className="sticky top-0 bg-card z-10">
                    <TableRow>
                      <TableHead>Debtor</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead className="text-right">Settlement</TableHead>
                      <TableHead className="text-right">Waiver</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Raised By</TableHead>
                      <TableHead className="min-w-[200px]">Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {SETTLEMENTS.map((s) => {
                      const meta = SETTLEMENT_META[s.status];
                      return (
                        <TableRow key={s.id} className="hover:bg-primary/5 align-top">
                          <TableCell>
                            <div className="font-medium text-sm">{s.debtorName}</div>
                            <div className="text-[11px] text-muted-foreground">{s.loanId}</div>
                          </TableCell>
                          <TableCell className="text-right font-medium text-sm">
                            {formatINR(s.outstanding)}
                          </TableCell>
                          <TableCell className="text-right font-semibold text-teal-600 text-sm">
                            {formatINR(s.settlementAmount)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right font-semibold text-sm",
                              s.waiver > 20 ? "text-destructive" : "text-warning-foreground",
                            )}
                          >
                            {s.waiver}%
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{s.date}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn("text-xs", meta.cls)}>
                              {meta.label}
                            </Badge>
                            {s.approvedBy && (
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {s.approvedBy}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {s.agentName}
                          </TableCell>
                          <TableCell>
                            <p className="text-xs text-foreground/80 leading-relaxed">{s.reason}</p>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
