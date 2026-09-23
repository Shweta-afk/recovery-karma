// The one debtor-profile layout, used everywhere a debtor's full info is shown: the standalone
// Debtors page, the "View" action from the Call Queue, and the manager's escalation list. Used
// to be two independently-built components (one per surface) that had quietly drifted apart —
// different tabs, one still reading mock call history where the other had long since switched
// to real call_logs, a stale Principal Amount fallback in one but not the other. Merged
// 2026-09-07 so there is exactly one implementation to keep in sync from here on.
import { useState, useEffect, useMemo } from "react";
import {
  Phone,
  MessageCircle,
  HandCoins,
  Banknote,
  Clock,
  CheckCheck,
  Check,
  Anchor,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatINR, displayId, type Debtor } from "@/lib/mock-debtors";
import { AssignedAgentLine } from "@/components/assigned-agent";
import { CopyButton } from "@/components/ui/copy-button";
import { TracePanel } from "@/components/profilex/trace-panel";
import { getDispositions, refreshDispositions } from "@/lib/disposition-store";
import { useFullExtra } from "@/lib/debtor-extra";
import { requestRetention, getRetentionRequestsFor } from "@/lib/retention-store";

const CALL_OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  promised: "PTP",
  refused: "Refused",
  no_answer: "No Answer",
  voicemail: "Voicemail",
  dispute: "Dispute",
  callback: "Callback",
  settlement: "Settlement",
};

function formatCallDate(iso: string): string {
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

// ─── Extra data keyed by loan ID (from uploaded Excel) — messages/disputes/EMI schedule have no
// real backing table yet, so these stay as illustrative fallback content for the handful of
// mock loan ids below, and an honest empty state ("No X yet") for every real debtor. ─────────

const EXTRA: Record<
  string,
  {
    lender: string;
    product: string;
    originalAmount: number;
    emi: number;
    tenure: number;
    disbursedOn: string;
    accountNumber: string;
    branch: string;
    pos: string;
    emiSchedule: { month: string; amount: number; status: "paid" | "missed" | "upcoming" }[];
    payments: { date: string; amount: number; method: string; ref: string }[];
    disputes: {
      id: string;
      type: string;
      status: "open" | "resolved" | "escalated";
      raised: string;
    }[];
    messages: {
      dir: "out" | "in";
      text: string;
      time: string;
      channel: "whatsapp" | "sms" | "ivr";
    }[];
  }
> = {
  "L-10042": {
    lender: "HDFC Bank",
    product: "Personal Loan",
    originalAmount: 300000,
    emi: 8200,
    tenure: 36,
    disbursedOn: "Apr 2023",
    accountNumber: "HDFC-PL-10042",
    branch: "Andheri West",
    pos: "HDFC Branch, Andheri",
    emiSchedule: [
      { month: "Apr 2026", amount: 8200, status: "paid" },
      { month: "May 2026", amount: 8200, status: "paid" },
      { month: "Jun 2026", amount: 8200, status: "missed" },
      { month: "Jul 2026", amount: 8200, status: "upcoming" },
    ],
    payments: [{ date: "15 May 2026", amount: 8200, method: "UPI", ref: "UPI202605151234" }],
    disputes: [],
    messages: [
      {
        dir: "out",
        text: "Namaste Rahul ji, aapka EMI ₹8,200 due hai. Kripya aaj payment karein.",
        time: "10:15 AM",
        channel: "whatsapp",
      },
      {
        dir: "in",
        text: "Haan sir, kal tak kar dunga UPI se.",
        time: "10:18 AM",
        channel: "whatsapp",
      },
      {
        dir: "out",
        text: "Payment details SMS bhej diya hai. Please account details se transfer karein.",
        time: "10:19 AM",
        channel: "sms",
      },
    ],
  },
  "L-10018": {
    lender: "Bajaj Finance",
    product: "Credit Card NPA",
    originalAmount: 120000,
    emi: 3800,
    tenure: 24,
    disbursedOn: "Jan 2024",
    accountNumber: "BFL-CC-10018",
    branch: "Surat Dealer",
    pos: "Dealer – Bajaj, Surat",
    emiSchedule: [
      { month: "Apr 2026", amount: 3800, status: "paid" },
      { month: "May 2026", amount: 3800, status: "missed" },
      { month: "Jun 2026", amount: 3800, status: "missed" },
      { month: "Jul 2026", amount: 3800, status: "upcoming" },
    ],
    payments: [],
    disputes: [
      { id: "D-001", type: "Interest waiver request", status: "open", raised: "10 Jun 2026" },
    ],
    messages: [
      {
        dir: "out",
        text: "Dear customer, 2 EMIs overdue. Please pay immediately to avoid legal notice.",
        time: "9:05 AM",
        channel: "sms",
      },
    ],
  },
};

function getExtra(id: string) {
  return (
    EXTRA[id] ?? {
      lender: "Axis Bank",
      product: "Personal Loan",
      originalAmount: 0,
      emi: 0,
      tenure: 0,
      disbursedOn: "—",
      accountNumber: "—",
      branch: "—",
      pos: "—",
      emiSchedule: [],
      payments: [],
      disputes: [],
      messages: [],
    }
  );
}

const RETENTION_STATUS_LABEL: Record<string, string> = {
  pending_manager: "Retention requested · awaiting manager",
  approved: "Retention approved · awaiting export to bank",
  sent_to_bank: "Retention sent to bank · awaiting next cycle",
};

export function DebtorProfile({
  d,
  onClose,
  onCall,
}: {
  d: Debtor;
  onClose: () => void;
  /** Places a real call to this debtor. Omitted where nothing in the surrounding page can
   * actually start one (e.g. the standalone Debtors page has no dialer context) — the Call Now
   * button hides itself in that case rather than pretending to place a call it can't. */
  onCall?: (d: Debtor) => void;
}) {
  const anyD = d as Debtor & {
    _uploadedExtra?: Record<string, string>;
    _lender?: string;
    _product?: string;
  };
  const isUploaded = !!anyD._uploadedExtra;
  // A list fetch carries only part of the bag (debtor-extra.ts); this shows every column.
  const csvFields = useFullExtra(isUploaded ? d.id : undefined, anyD._uploadedExtra);
  const extra = isUploaded ? null : getExtra(d.id);
  const initials = d.name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Real call_logs for this debtor — same disposition-store used by Activity History.
  const [disps, setDisps] = useState(() => getDispositions());
  useEffect(() => {
    const load = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", load);
    refreshDispositions()
      .then(load)
      .catch((e) => console.warn("[debtor-profile] disposition refresh failed:", e));
    return () => window.removeEventListener("dispositions-updated", load);
  }, []);

  const debtorCalls = useMemo(
    () => disps.filter((r) => r.debtorId === d.id).sort((a, b) => b.time.localeCompare(a.time)),
    [disps, d.id],
  );
  const debtorPayments = useMemo(
    () => debtorCalls.filter((r) => r.outcome === "paid" && r.paidAmount),
    [debtorCalls],
  );

  // Request Retention — asks the manager to keep this account into the next portfolio cycle
  // instead of it being recalled by the bank. Only meaningful for a debtor tied to a real
  // portfolio (debtorFromRow() in portfolio-store.ts sets this); an ad-hoc/manual-dial debtor
  // has nothing to request retention FOR, so the whole action hides rather than erroring.
  const portfolioId = d.portfolioId;
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retentionReason, setRetentionReason] = useState("");
  const [retentionSubmitting, setRetentionSubmitting] = useState(false);
  const latestRetentionRequest = getRetentionRequestsFor(d.id)[0];
  const inFlightRetention =
    latestRetentionRequest &&
    (["pending_manager", "approved", "sent_to_bank"] as const).includes(
      latestRetentionRequest.status as "pending_manager" | "approved" | "sent_to_bank",
    )
      ? latestRetentionRequest
      : undefined;

  const submitRetention = async () => {
    if (!portfolioId) return;
    setRetentionSubmitting(true);
    try {
      await requestRetention({ debtorId: d.id, portfolioId, reason: retentionReason.trim() });
      toast.success("Retention requested — awaiting manager review");
      setRetentionOpen(false);
      setRetentionReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to request retention");
    } finally {
      setRetentionSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <SheetHeader className="px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-full bg-muted flex items-center justify-center text-muted-foreground font-semibold">
            {initials}
          </div>
          <div className="flex-1">
            <SheetTitle className="text-base">{d.name}</SheetTitle>
            <p className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
              <span className="inline-flex items-center gap-1">
                {displayId(d)}
                <CopyButton value={displayId(d)} label="Loan ID" />
              </span>
              ·
              <span className="inline-flex items-center gap-1">
                {d.phone}
                <CopyButton value={d.phone} label="Phone number" />
              </span>
              · {d.language}
            </p>
            <AssignedAgentLine debtorId={d.id} />
          </div>
        </div>
      </SheetHeader>

      {/* Key stats band */}
      <div className="flex-shrink-0 px-6 py-3 border-b border-border grid grid-cols-4 gap-4 text-sm bg-muted/20">
        {[
          { label: "Outstanding", value: formatINR(d.loanAmount) },
          { label: "DPD", value: `${d.dpd} days` },
          { label: "AI Score", value: `${d.aiScore}/10` },
          {
            label: "Principal Amount",
            // d.principalOutstanding is real (migrations/20260905_debtors_principal_amount.sql);
            // the extra["pos"/"Principal"] lookup is a fallback heuristic for debtors uploaded
            // before that field existed, guessing at an unmapped raw CSV column.
            value: d.principalOutstanding
              ? formatINR(d.principalOutstanding)
              : isUploaded
                ? csvFields["pos"] || csvFields["Principal"] || "—"
                : extra?.pos || "—",
          },
        ].map(({ label, value }) => (
          <div key={label}>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div className="font-semibold text-foreground mt-0.5 text-sm truncate">{value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="h-full flex flex-col">
          <TabsList className="flex-shrink-0 rounded-none border-b border-border bg-transparent px-6 h-10 justify-start gap-1">
            {["overview", "calls", "insights", "messages", "payments", "disputes"].map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="capitalize text-xs data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-foreground rounded-none pb-2 text-muted-foreground"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto px-6 py-4 space-y-5 mt-0">
            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                Personal
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Personal Details
                  </div>
                  {(
                    [
                      ["Full Name", d.name],
                      ["Gender", d.gender ?? "—"],
                      ["DOB", d.dob ?? "—"],
                      ["Age", d.age ? `${d.age} years` : "—"],
                      ["Language", d.language],
                    ] as [string, string][]
                  ).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="text-foreground font-medium">{v}</span>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg border border-border p-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Contact Details
                  </div>
                  {[
                    { label: "Primary", number: d.phone },
                    ...(d.altPhones ?? []).map((number, i) => ({ label: `Alt ${i + 1}`, number })),
                  ].map(({ label, number }) => (
                    <div key={label} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="flex items-center gap-1 font-mono text-foreground font-medium">
                        {number}
                        <CopyButton value={number} label="Phone number" />
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Email</span>
                    <span className="font-mono text-foreground font-medium">{d.email ?? "—"}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Last Contacted</span>
                    <span className="font-mono text-foreground font-medium">
                      {d.lastContacted ?? "Never"}
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-border p-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Address
                  </div>
                  <p className="text-sm text-foreground">{d.address ?? "—"}</p>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">City / State</span>
                    <span className="text-foreground">
                      {[d.city, d.state].filter(Boolean).join(", ") || "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Pincode</span>
                    <span className="text-foreground font-mono">{d.pincode ?? "—"}</span>
                  </div>
                </div>

                <div className="rounded-lg border border-border p-3 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Employment
                  </div>
                  {(
                    [
                      ["Employer", d.employer ?? "—"],
                      ["Type", d.employerType ?? "—"],
                      ["Monthly Income", d.monthlyIncome ? formatINR(d.monthlyIncome) : "—"],
                    ] as [string, string][]
                  ).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="text-foreground font-medium">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <Separator />

            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                {isUploaded
                  ? "CSV Fields · from uploaded portfolio"
                  : "Loan Details · from uploaded file"}
              </p>
              {isUploaded ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  {(
                    [
                      ["Lender", anyD._lender || "—"],
                      ["Product", anyD._product || "—"],
                      ["Portfolio", d.portfolio],
                      ["DPD", String(d.dpd)],
                    ] as [string, string][]
                  ).map(([label, val]) => (
                    <div key={label}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="font-medium text-foreground mt-0.5">{val || "—"}</div>
                    </div>
                  ))}
                  {Object.entries(csvFields).map(([col, val]) => (
                    <div key={col}>
                      <div className="text-xs text-muted-foreground capitalize">
                        {col.replace(/_/g, " ")}
                      </div>
                      <div className="font-medium text-foreground mt-0.5 break-all">
                        {val || "—"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  {(
                    [
                      ["Lender", extra!.lender],
                      ["Product", extra!.product],
                      ["Account No.", extra!.accountNumber],
                      ["Disbursed On", extra!.disbursedOn],
                      ["Original Amount", formatINR(extra!.originalAmount)],
                      ["EMI", formatINR(extra!.emi)],
                      ["Tenure", `${extra!.tenure} months`],
                      ["Principal Amount", extra!.pos],
                      ["Portfolio", d.portfolio],
                    ] as [string, string][]
                  ).map(([label, val]) => (
                    <div key={label}>
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="font-medium text-foreground mt-0.5">{val}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                EMI Schedule
              </p>
              {(extra?.emiSchedule ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No EMI data available.</p>
              ) : (
                <div className="space-y-1.5">
                  {extra!.emiSchedule.map((e, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <span className="text-foreground">{e.month}</span>
                      <span className="font-medium text-foreground">{formatINR(e.amount)}</span>
                      <span
                        className={cn(
                          "text-xs font-medium capitalize",
                          e.status === "paid"
                            ? "text-foreground"
                            : e.status === "missed"
                              ? "text-muted-foreground line-through"
                              : "text-muted-foreground",
                        )}
                      >
                        {e.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                Other Details
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {(
                  [
                    ["AI Insight", d.scoreReason],
                    d.retained ? ["Retained From", d.retainedFrom ?? "—"] : null,
                  ].filter(Boolean) as [string, string][]
                ).map(([label, val]) => (
                  <div key={label} className="col-span-2">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="font-medium text-foreground mt-0.5">{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* Call history */}
          <TabsContent value="calls" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            {debtorCalls.length === 0 ? (
              <p className="text-sm text-muted-foreground">No call history recorded.</p>
            ) : (
              <div>
                {debtorCalls.map((c, i) => (
                  <div key={c.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="h-2 w-2 rounded-full bg-muted-foreground mt-1.5" />
                      {i < debtorCalls.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                    </div>
                    <div className="pb-4">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-foreground">
                          {CALL_OUTCOME_LABEL[c.outcome] ?? c.outcome}
                        </span>
                        <span className="text-muted-foreground">·</span>
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground text-xs">
                          {formatDuration(c.durationSeconds)}
                        </span>
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          {c.callType === "human" ? "Agent" : (c.callType ?? "Agent").toUpperCase()}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatCallDate(c.time)}
                        {c.agentName && <> · {c.agentName}</>}
                      </div>
                      {c.notes && (
                        <div className="mt-1 text-xs bg-muted rounded px-2 py-1 text-foreground/80">
                          {c.notes}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Trace — ProfileX skip-tracing. Managers/admins can run a lookup here; agents see
              whatever their manager already paid for, read-only. Role gate lives in TracePanel. */}
          <TabsContent value="insights" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            <TracePanel debtorId={d.id} debtorName={d.name} />
          </TabsContent>

          {/* Messages */}
          <TabsContent value="messages" className="flex-1 overflow-y-auto px-6 py-4 space-y-2 mt-0">
            {(extra?.messages ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages sent.</p>
            ) : (
              extra!.messages.map((m, i) => (
                <div
                  key={i}
                  className={cn("flex", m.dir === "out" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[75%] rounded-2xl px-3 py-2 text-sm",
                      m.dir === "out"
                        ? "bg-foreground text-background rounded-br-sm"
                        : "bg-muted border border-border text-foreground rounded-bl-sm",
                    )}
                  >
                    <p>{m.text}</p>
                    <div
                      className={cn(
                        "flex items-center gap-1 mt-1 text-[10px]",
                        m.dir === "out" ? "justify-end opacity-60" : "text-muted-foreground",
                      )}
                    >
                      {m.time} · {m.channel}
                      {m.dir === "out" && <CheckCheck className="h-3 w-3" />}
                      {m.dir === "in" && <Check className="h-3 w-3" />}
                    </div>
                  </div>
                </div>
              ))
            )}
          </TabsContent>

          {/* Payments */}
          <TabsContent value="payments" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            {debtorPayments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments recorded.</p>
            ) : (
              <div className="space-y-2">
                {debtorPayments.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
                  >
                    <div>
                      <div className="font-semibold text-foreground">
                        {formatINR(p.paidAmount ?? 0)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatCallDate(p.time)}
                        {p.notes ? ` · ${p.notes}` : ""}
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-xs">
                      Logged by {p.agentName || "agent"}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Disputes */}
          <TabsContent value="disputes" className="flex-1 overflow-y-auto px-6 py-4 space-y-3 mt-0">
            {(extra?.disputes ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No disputes raised.</p>
            ) : (
              extra!.disputes.map((disp) => (
                <div key={disp.id} className="rounded-lg border border-border p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">{disp.type}</span>
                    <Badge variant="outline" className="capitalize text-xs text-muted-foreground">
                      {disp.status}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {disp.id} · Raised {disp.raised}
                  </div>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Action bar */}
      <div className="flex-shrink-0 border-t border-border px-6 py-3 flex flex-wrap gap-2 bg-card">
        {onCall && (
          <Button size="sm" className="gap-1.5 h-8 active:scale-95" onClick={() => onCall(d)}>
            <Phone className="h-3.5 w-3.5" />
            Call Now
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 active:scale-95"
          onClick={() => toast.success("WhatsApp opened for " + d.name)}
        >
          <MessageCircle className="h-3.5 w-3.5" />
          WhatsApp
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 active:scale-95"
          onClick={() => toast.success("Payment details sent via SMS")}
        >
          <Banknote className="h-3.5 w-3.5" />
          Share Details
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 active:scale-95"
          onClick={() => toast.info("Settlement workflow initiated")}
        >
          <HandCoins className="h-3.5 w-3.5" />
          Settlement
        </Button>
        {portfolioId &&
          (d.retained ? (
            <Badge
              variant="outline"
              className="h-8 gap-1.5 border-violet-400/40 bg-violet-500/10 px-3 text-violet-500"
            >
              <Anchor className="h-3.5 w-3.5" />
              Retained · from {d.retainedFrom ?? "previous cycle"}
            </Badge>
          ) : inFlightRetention ? (
            <Badge
              variant="outline"
              className="h-8 gap-1.5 border-amber-400/40 bg-amber-500/10 px-3 text-amber-600"
            >
              <Anchor className="h-3.5 w-3.5" />
              {RETENTION_STATUS_LABEL[inFlightRetention.status] ?? "Retention requested"}
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 active:scale-95"
              onClick={() => setRetentionOpen(true)}
            >
              <Anchor className="h-3.5 w-3.5" />
              Request Retention
            </Button>
          ))}
      </div>

      {/* Request Retention dialog — asks the manager to keep this account into the next
          portfolio cycle instead of it being recalled by the bank. See retention-store.ts. */}
      <Dialog open={retentionOpen} onOpenChange={setRetentionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request Retention</DialogTitle>
            <DialogDescription>
              Ask your manager to request the bank keep <strong>{d.name}</strong> in the next
              portfolio cycle instead of it being recalled — useful for an active PTP or an ongoing
              negotiation you don't want to lose.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Why should this account be retained? (e.g. PTP due next week, mid-negotiation on settlement)"
            value={retentionReason}
            onChange={(e) => setRetentionReason(e.target.value)}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRetentionOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={submitRetention} disabled={retentionSubmitting}>
              {retentionSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Anchor className="h-3.5 w-3.5" />
              )}
              Submit Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
