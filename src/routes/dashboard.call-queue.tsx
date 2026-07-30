import { createFileRoute, Link } from "@tanstack/react-router";
import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Phone,
  PhoneCall,
  MessageCircle,
  SkipForward,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  BotMessageSquare,
  Square,
  ChevronDown,
  ChevronUp,
  X,
  Clock,
  Check,
  PhoneForwarded,
  ArrowRightLeft,
  Hash,
  Zap,
  Bell,
  Filter,
  FileDown,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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

import { Sheet, SheetContent } from "@/components/ui/sheet";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { bucketOf, formatINR, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";
import {
  getPortfolios,
  getAgentDebtorIds,
  refreshPortfolios,
  DEFAULT_PORTFOLIO_SETTINGS,
  type CallMode,
} from "@/lib/portfolio-store";
import { useDialerRun } from "@/lib/dialer/use-dialer-run";
import { useSingleCall } from "@/lib/dialer/use-single-call";
import {
  QUEUE_FILTERS,
  OUTCOME_META,
  QUEUE_STATUS_META,
  STATUS_META,
  PRODUCTIVE_STATUSES,
  NON_PRODUCTIVE_STATUSES,
  type QueueFilter,
  type ProdFilter,
  type QueueSortKey,
  type CallOutcome,
  type ActiveCall,
  type DispositionForm,
  type QueueDebtor,
  type LiveCallEntry,
  type AgentStatus,
} from "@/lib/call-queue/types";
// Re-export the shared types/consts so existing importers of this route file keep working.
export * from "@/lib/call-queue/types";
import { exportCSV } from "@/lib/call-queue/mock-data";
import {
  ActiveCallPanel,
  ActiveCallModal,
  SectionLabel,
  PTPTracker,
  DebtorProfileSheet,
  EscalationModal,
} from "@/components/call-queue/active-call";
// Re-export the two call-control components manager.queue.tsx imports from this route path.
export { ActiveCallPanel, ActiveCallModal } from "@/components/call-queue/active-call";
import {
  saveDisposition,
  getAgentDispositions,
  refreshDispositions,
  type DispositionRecord,
  type CallOutcome as StoredOutcome,
} from "@/lib/disposition-store";
import {
  saveReminder,
  getDueReminders,
  markReminderNotified,
  refreshReminders,
  type Reminder,
} from "@/lib/reminder-store";

import { useAuth } from "@/lib/auth";
import { useCallSession } from "@/lib/call-session";
import { toast } from "sonner";

export const Route = createFileRoute("/dashboard/call-queue")({
  head: () => ({
    meta: [
      { title: "Call Queue · RecoveryAI" },
      {
        name: "description",
        content: "Agent and AI call queue with filters and full call history.",
      },
    ],
  }),
  // Accept an optional ?filter= so dashboard cards can deep-link into a pre-filtered queue
  validateSearch: (search: Record<string, unknown>): { filter?: QueueFilter } => {
    const f = search.filter;
    return typeof f === "string" && (QUEUE_FILTERS as readonly string[]).includes(f)
      ? { filter: f as QueueFilter }
      : {};
  },
  component: CallQueuePage,
});

/** DIDs assigned to the Tata SmartFlo account, usable as outbound caller IDs. Tata rejects
 * any caller_id that isn't one of these with a 422 ("DID Selected is either disabled…"). */
const SMARTFLO_DIDS = [
  "917965810560",
  "917965810601",
  "917965810606",
  "917965810614",
  "917965810618",
] as const;

// ─── Mock data ────────────────────────────────────────────────────────────────

/** Build a queue from portfolios assigned to this agent; returns empty if none assigned */
export function buildAssignedQueue(agentId: string): QueueDebtor[] {
  const slices = getAgentDebtorIds(agentId);
  if (!slices.length) return [];
  const allPortfolios = getPortfolios();
  const result: QueueDebtor[] = [];
  for (const { portfolioId, debtorIds } of slices) {
    const portfolio = allPortfolios.find((p) => p.id === portfolioId);
    if (!portfolio) continue;
    const idSet = new Set(debtorIds);
    for (const row of portfolio.rows) {
      if (!idSet.has(row.id)) continue;
      result.push({
        id: row.id,
        loanReference: row.loanReference,
        name: row.name || "(unknown)",
        phone: row.phone || "—",
        loanAmount: row.loanAmount,
        dpd: row.dpd,
        aiScore: Math.max(1, Math.min(10, Math.round(10 - row.dpd / 20))),
        scoreReason: `From ${portfolio.name} · ${portfolio.lender}`,
        lastContacted: "—",
        portfolio: portfolio.name,
        portfolioId: portfolio.id,
        language: "English",
        email: row.email,
        queueStatus: "fresh",
        scheduledAt: "—",
        ptpAmount: 0,
        retained: false,
      });
    }
  }
  return result;
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

// ─── Main page ────────────────────────────────────────────────────────────────

function CallQueuePage() {
  const { user } = useAuth();
  // Operational identity is the account email (matches the roster + assignments)
  const agentId = user?.email ?? user?.id ?? "AGT-ANON";
  const agentName = user?.name ?? "Agent";

  // Agent availability status
  const [status, setStatus] = useState<AgentStatus>("available");
  const [statusOpen, setStatusOpen] = useState(false);
  const statusMeta = STATUS_META[status];

  // Queue = only the debtors assigned to this agent from uploaded portfolios
  const [allQueue, setAllQueue] = useState<QueueDebtor[]>(() => buildAssignedQueue(agentId));

  // Reload queue when assignments/portfolios change
  useEffect(() => {
    const reload = () => {
      setAllQueue(buildAssignedQueue(agentId));
    };
    window.addEventListener("portfolios-updated", reload);
    refreshPortfolios();
    refreshDispositions();
    return () => {
      window.removeEventListener("portfolios-updated", reload);
    };
  }, [agentId]);

  // Portfolio mode/name are properties of the portfolio, set by the manager at upload time.
  // An agent's queue can span multiple portfolios; show the primary (first) one they're
  // currently working, falling back to the platform default when nothing is assigned yet.
  const primaryPortfolio = allQueue[0]?.portfolioId
    ? getPortfolios().find((p) => p.id === allQueue[0].portfolioId)
    : undefined;
  const dialerSettings = primaryPortfolio?.settings ?? DEFAULT_PORTFOLIO_SETTINGS;
  const portfolioMode: CallMode = dialerSettings.callMode;
  const portfolioName = primaryPortfolio?.name ?? "No portfolio assigned";

  // Seed loggedOutcomes from persisted dispositions
  const [loggedOutcomes, setLoggedOutcomes] = useState<
    Record<string, { outcome: CallOutcome; time: string }>
  >(() => {
    const persisted = getAgentDispositions(agentId);
    const map: Record<string, { outcome: CallOutcome; time: string }> = {};
    persisted.forEach((d) => {
      const t = new Date(d.time);
      map[d.debtorId] = {
        outcome: d.outcome as CallOutcome,
        time: `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`,
      };
    });
    return map;
  });

  // Predictive dialer driven by the real engine + simulated provider (src/lib/dialer).
  // Legs progress through the actual call state machine; mode: "server" later moves it
  // server-side for true background dialing with no change here.
  const dialer = useDialerRun();
  const [prodFilter, setProdFilter] = useState<ProdFilter>("all");
  const [manualDialPageOpen, setManualDialPageOpen] = useState(false);
  const [manualDialNumber, setManualDialNumber] = useState("");
  const [manualDialName, setManualDialName] = useState("");
  // Caller ID shown to the debtor — must be a DID on the Tata account, never a personal number.
  const [manualDialCallerId, setManualDialCallerId] = useState<string>(SMARTFLO_DIDS[0]);
  const [retainedOpen, setRetainedOpen] = useState(false);
  const [predictiveNotif, setPredictiveNotif] = useState<string | null>(null);
  // A call the AI has connected and is handing to the agent WHILE they're already on another call
  const [incomingTransfer, setIncomingTransfer] = useState<{
    debtor: QueueDebtor;
    from: string;
  } | null>(null);
  const { filter: initialFilter } = Route.useSearch();
  const [queueFilter, setQueueFilter] = useState<QueueFilter>(initialFilter ?? "all");
  const [bucketFilter, setBucketFilter] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [queueSearch, setQueueSearch] = useState("");

  // Queue table column sort + filters
  const [qSortKey, setQSortKey] = useState<QueueSortKey | null>(null);
  const [qSortDir, setQSortDir] = useState<"asc" | "desc">("asc");
  const [filterOutstanding, setFilterOutstanding] = useState<"all" | "lt1L" | "1to5L" | "gt5L">(
    "all",
  );
  const [filterDpd, setFilterDpd] = useState<"all" | "lt30" | "30to60" | "61to90" | "gt90">("all");
  const [filterScore, setFilterScore] = useState<"all" | "high" | "mid" | "low">("all");
  const [filterStatus, setFilterStatus] = useState<QueueDebtor["queueStatus"] | "all">("all");
  const [openColFilter, setOpenColFilter] = useState<string | null>(null);

  const toggleQSort = (key: QueueSortKey) => {
    if (qSortKey === key) setQSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setQSortKey(key);
      setQSortDir("asc");
    }
    setOpenColFilter(null);
  };

  // Debtor profile sheet
  const [profileDebtor, setProfileDebtor] = useState<QueueDebtor | null>(null);

  // Escalation modal
  const [escalationCall, setEscalationCall] = useState<{
    debtor: QueueDebtor;
    notes: string;
  } | null>(null);

  // (loggedOutcomes is initialized above from persisted store)

  // Active call state — lives in CallSessionProvider (mounted above the dashboard's <Outlet/>)
  // so it survives navigating away from this page, letting the minimized call bar keep showing.
  const { activeCall, setActiveCall, disposition, setDisposition } = useCallSession();
  // Single-call mode: use "server" to place real calls through Tata SmartFlo (not simulator)
  const singleCall = useSingleCall(setActiveCall, { mode: "server" });
  // Keep a ref to the live active call so async dialer callbacks can read the latest value
  const activeCallRef = useRef<ActiveCall | null>(null);
  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  const startCall = (
    debtor: QueueDebtor,
    opts?: { instant?: boolean; agentPhone?: string; callerId?: string },
  ) => {
    singleCall.reset(); // clear any prior in-flight sim/timer
    setActiveCall({
      debtor,
      phase: opts?.instant ? "connected" : "ringing",
      view: "panel",
      muted: false,
      held: false,
      elapsed: 0,
    });
    setDisposition({
      outcome: "",
      ptpAmount: "",
      ptpDate: "",
      callbackDate: "",
      callbackTime: "",
      paidAmount: "",
      paidRef: "",
      disputeReason: "",
      settlementAmount: "",
      settlementDate: "",
      settlementWaiver: "",
      escalate: false,
      notes: "",
      followUpDate: "",
    });
    // A transferred call is already live on the AI side — connect instantly; a fresh dial rings
    // first, then connects when the (simulated) provider reports the debtor answered.
    if (!opts?.instant)
      singleCall.dial(debtor, { agentPhone: opts?.agentPhone, callerId: opts?.callerId });
  };

  const endCall = () => singleCall.hangup();

  // AI has a live debtor to hand over. If the agent is free, connect them straight away.
  // If they're already on a connected call, surface a Take / Forward notification instead.
  const handleAiTransfer = (debtor: QueueDebtor, from: string) => {
    const current = activeCallRef.current;
    const busy = !!current && current.phase === "connected";
    if (busy) {
      setIncomingTransfer({ debtor, from });
    } else {
      startCall(debtor, { instant: true });
      toast.success(`${from} connected ${debtor.name} to you`);
    }
  };

  // Take the transferred call — replaces whatever the agent is on (mock behaviour)
  const takeTransfer = () => {
    if (!incomingTransfer) return;
    startCall(incomingTransfer.debtor, { instant: true });
    toast.success(`Connected to ${incomingTransfer.debtor.name}`);
    setIncomingTransfer(null);
  };
  const forwardTransfer = () => {
    if (!incomingTransfer) return;
    toast.success(`${incomingTransfer.debtor.name} redirected to next available agent`);
    setIncomingTransfer(null);
  };

  // Build a human-readable note that is always saved against the debtor, whatever the outcome.
  const buildAutoNote = (d: DispositionForm): string => {
    const amt = d.ptpAmount ? formatINR(parseFloat(d.ptpAmount)) : "";
    switch (d.outcome) {
      case "promised":
        return `PTP for ${amt || "amount TBD"} on ${d.ptpDate || "date TBD"}`;
      case "callback":
        return `Callback scheduled for ${d.callbackDate || "date TBD"}${d.callbackTime ? ` at ${d.callbackTime}` : ""}`;
      case "paid":
        return `Paid ${d.paidAmount ? formatINR(parseFloat(d.paidAmount)) : ""}${d.paidRef ? ` (Ref ${d.paidRef})` : ""}`.trim();
      case "settlement":
        return `Settlement ${d.settlementAmount ? formatINR(parseFloat(d.settlementAmount)) : ""}${d.settlementDate ? ` on ${d.settlementDate}` : ""}${d.settlementWaiver ? ` · ${d.settlementWaiver}% waiver` : ""}`.trim();
      case "refused":
        return `Refused to pay${d.disputeReason ? `: ${d.disputeReason}` : ""}`;
      case "dispute":
        return `Dispute raised${d.disputeReason ? `: ${d.disputeReason}` : ""}`;
      case "no_answer":
        return "No answer";
      case "voicemail":
        return "Voicemail left";
      default:
        return "Call logged";
    }
  };

  const submitDisposition = () => {
    if (!disposition.outcome) {
      toast.error("Select an outcome before submitting");
      return;
    }
    if (disposition.escalate && activeCall) {
      setEscalationCall({ debtor: activeCall.debtor, notes: disposition.notes });
    }
    if (activeCall) {
      const debtor = activeCall.debtor;
      const now = new Date();

      // 4a — every disposition is stored as text; auto-note is prepended to any typed note
      const autoNote = buildAutoNote(disposition);
      const combinedNotes = [autoNote, disposition.notes.trim()].filter(Boolean).join(" — ");

      // Persist to disposition store
      const record: DispositionRecord = {
        id: crypto.randomUUID(),
        debtorId: debtor.id,
        debtorName: debtor.name,
        phone: debtor.phone,
        agentId,
        agentName,
        portfolioName: debtor.portfolio,
        outcome: disposition.outcome as StoredOutcome,
        notes: combinedNotes,
        ptpAmount: disposition.ptpAmount ? parseFloat(disposition.ptpAmount) : undefined,
        ptpDate: disposition.ptpDate || undefined,
        paidAmount: disposition.paidAmount ? parseFloat(disposition.paidAmount) : undefined,
        paidRef: disposition.paidRef || undefined,
        loanAmount: debtor.loanAmount,
        dpd: debtor.dpd,
        time: now.toISOString(),
      };
      saveDisposition(record).catch((e) =>
        toast.error(e instanceof Error ? e.message : "Failed to save call outcome"),
      );

      // 3 — PTP / callback: SMS the debtor and set an agent reminder for the scheduled date
      if (disposition.outcome === "promised" || disposition.outcome === "callback") {
        const isPTP = disposition.outcome === "promised";
        const dueDate = isPTP ? disposition.ptpDate : disposition.callbackDate;
        const amt = disposition.ptpAmount ? formatINR(parseFloat(disposition.ptpAmount)) : "";
        const sms = isPTP
          ? `Dear ${debtor.name}, we've recorded your promise to pay ${amt} by ${dueDate || "the agreed date"}. Thank you — RecoveryAI`
          : `Dear ${debtor.name}, our agent will call you back on ${disposition.callbackDate || "the agreed date"}${disposition.callbackTime ? ` at ${disposition.callbackTime}` : ""}. — RecoveryAI`;
        toast.success(`SMS sent to ${debtor.name}`, { description: sms });

        if (dueDate) {
          const reminder: Reminder = {
            id: crypto.randomUUID(),
            agentId,
            debtorId: debtor.id,
            debtorName: debtor.name,
            phone: debtor.phone,
            kind: isPTP ? "ptp" : "callback",
            amount: disposition.ptpAmount ? parseFloat(disposition.ptpAmount) : undefined,
            dueDate,
            dueTime: isPTP ? undefined : disposition.callbackTime || undefined,
            message: isPTP
              ? `PTP due — ${debtor.name} promised ${amt} for ${dueDate}`
              : `Callback due — ${debtor.name} on ${dueDate}${disposition.callbackTime ? ` at ${disposition.callbackTime}` : ""}`,
            createdAt: now.toISOString(),
          };
          saveReminder(reminder).catch((e) =>
            toast.error(e instanceof Error ? e.message : "Failed to save reminder"),
          );
          toast(`Reminder set for ${dueDate}`, { icon: "🔔" });
        }
      } else {
        toast.success(`Call logged — ${disposition.outcome}`);
      }

      // Record outcome so queue row shows a confirmation badge
      const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
      setLoggedOutcomes((prev) => ({
        ...prev,
        [debtor.id]: { outcome: disposition.outcome as CallOutcome, time: timeStr },
      }));
    }
    singleCall.reset();
    setActiveCall(null);
  };

  // When a PTP / callback date has arrived, remind the agent (fires once per due reminder)
  useEffect(() => {
    refreshReminders().then(() => {
      const todayISO = new Date().toISOString().slice(0, 10);
      const due = getDueReminders(agentId, todayISO);
      due.forEach((r) => {
        toast(r.message, {
          icon: "🔔",
          duration: 7000,
          description: `Follow up with ${r.debtorName}`,
        });
        markReminderNotified(r.id).catch(() => {});
      });
    });
  }, [agentId]);

  const filterCounts = useMemo(
    () => ({
      all: allQueue.length,
      retained: allQueue.filter((d) => d.retained).length,
      callback: allQueue.filter((d) => d.queueStatus === "callback").length,
      ptp: allQueue.filter((d) => d.queueStatus === "ptp").length,
      no_answer: allQueue.filter((d) => d.queueStatus === "no_answer").length,
      fresh: allQueue.filter((d) => d.queueStatus === "fresh").length,
      escalated: allQueue.filter((d) => d.queueStatus === "escalated").length,
      switch_off: 5,
      nc: 8,
      paid: 6,
    }),
    [allQueue],
  );

  const filteredQueue = useMemo(() => {
    let rows = allQueue;

    // Bucket filter
    if (bucketFilter !== "all") rows = rows.filter((d) => bucketOf(d.dpd) === bucketFilter);

    // Productive / Non-Productive
    if (prodFilter === "productive")
      rows = rows.filter((d) => PRODUCTIVE_STATUSES.includes(d.queueStatus));
    else if (prodFilter === "non_productive")
      rows = rows.filter((d) => NON_PRODUCTIVE_STATUSES.includes(d.queueStatus));

    // Status pill filter
    if (queueFilter === "retained") rows = rows.filter((d) => d.retained);
    else if (queueFilter === "callback") rows = rows.filter((d) => d.queueStatus === "callback");
    else if (queueFilter === "ptp") rows = rows.filter((d) => d.queueStatus === "ptp");
    else if (queueFilter === "no_answer") rows = rows.filter((d) => d.queueStatus === "no_answer");
    else if (queueFilter === "fresh") rows = rows.filter((d) => d.queueStatus === "fresh");
    else if (queueFilter === "escalated") rows = rows.filter((d) => d.queueStatus === "escalated");

    // Column filters
    if (filterStatus !== "all") rows = rows.filter((d) => d.queueStatus === filterStatus);
    if (filterOutstanding === "lt1L") rows = rows.filter((d) => d.loanAmount < 100000);
    else if (filterOutstanding === "1to5L")
      rows = rows.filter((d) => d.loanAmount >= 100000 && d.loanAmount <= 500000);
    else if (filterOutstanding === "gt5L") rows = rows.filter((d) => d.loanAmount > 500000);
    if (filterDpd === "lt30") rows = rows.filter((d) => d.dpd < 30);
    else if (filterDpd === "30to60") rows = rows.filter((d) => d.dpd >= 30 && d.dpd <= 60);
    else if (filterDpd === "61to90") rows = rows.filter((d) => d.dpd > 60 && d.dpd <= 90);
    else if (filterDpd === "gt90") rows = rows.filter((d) => d.dpd > 90);
    if (filterScore === "high") rows = rows.filter((d) => d.aiScore >= 8);
    else if (filterScore === "mid") rows = rows.filter((d) => d.aiScore >= 5 && d.aiScore < 8);
    else if (filterScore === "low") rows = rows.filter((d) => d.aiScore < 5);

    // Search
    const q = queueSearch.trim().toLowerCase();
    if (q)
      rows = rows.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          (d.loanReference ?? d.id).toLowerCase().includes(q) ||
          d.phone.includes(q),
      );

    // Column sort
    if (qSortKey) {
      rows = [...rows].sort((a, b) => {
        let av: string | number = 0,
          bv: string | number = 0;
        if (qSortKey === "name") {
          av = a.name;
          bv = b.name;
        }
        if (qSortKey === "outstanding") {
          av = a.loanAmount;
          bv = b.loanAmount;
        }
        if (qSortKey === "dpd") {
          av = a.dpd;
          bv = b.dpd;
        }
        if (qSortKey === "aiScore") {
          av = a.aiScore;
          bv = b.aiScore;
        }
        if (qSortKey === "status") {
          av = a.queueStatus;
          bv = b.queueStatus;
        }
        if (qSortKey === "scheduled") {
          av = a.scheduledAt;
          bv = b.scheduledAt;
        }
        if (av < bv) return qSortDir === "asc" ? -1 : 1;
        if (av > bv) return qSortDir === "asc" ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [
    allQueue,
    queueFilter,
    bucketFilter,
    queueSearch,
    prodFilter,
    filterStatus,
    filterOutstanding,
    filterDpd,
    filterScore,
    qSortKey,
    qSortDir,
  ]);

  const FILTERS: { key: QueueFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "retained", label: "Retained" },
    { key: "callback", label: "Callback" },
    { key: "ptp", label: "PTP" },
    { key: "no_answer", label: "No Answer" },
    { key: "fresh", label: "Fresh" },
    { key: "escalated", label: "Escalated" },
  ];

  return (
    <div className="space-y-8">
      {/* ── Header ── */}
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Queue</h1>
            <p className="text-sm text-muted-foreground">Live queue · 30 Jun 2026</p>
          </div>

          {/* Agent availability status widget */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setStatusOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs transition-all hover:border-foreground/30"
            >
              <span className={cn("h-2 w-2 rounded-full flex-shrink-0", statusMeta.dot)} />
              <span className={cn("font-medium", statusMeta.txt)}>{statusMeta.label}</span>
              <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
            </button>
            {statusOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-40 rounded-lg border border-border bg-card shadow-lg py-1">
                {(
                  Object.entries(STATUS_META) as [AgentStatus, (typeof STATUS_META)[AgentStatus]][]
                ).map(([key, s]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setStatus(key);
                      setStatusOpen(false);
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted/50",
                      status === key ? "bg-muted/30" : "",
                    )}
                  >
                    <span className={cn("h-2 w-2 rounded-full flex-shrink-0", s.dot)} />
                    <span className={cn("font-medium", s.txt)}>{s.label}</span>
                    {status === key && (
                      <span className="ml-auto text-[10px] text-muted-foreground">●</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Mode status bar ── */}
        <DialerModeBar
          portfolioMode={portfolioMode}
          portfolioName={portfolioName}
          dialerRunning={dialer.running}
        />
      </div>

      {/* ── Predictive notification banner ── */}
      {predictiveNotif && (
        <div className="animate-in slide-in-from-top-2 duration-300 flex items-center gap-3 rounded-lg border border-success/30 bg-success/8 px-4 py-2.5 text-sm text-success font-medium">
          <Bell className="h-4 w-4 flex-shrink-0 animate-pulse" />
          <span>Predictive Dialer: {predictiveNotif}</span>
          <button
            type="button"
            onClick={() => setPredictiveNotif(null)}
            className="ml-auto text-success/60 hover:text-success"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Summary Stats ── */}
      <section className="space-y-3 animate-in fade-in duration-400">
        {/* Overall row */}
        <div className="grid grid-cols-3 gap-3">
          {[
            {
              label: "Total Count",
              value: allQueue.length.toString(),
              sub: "accounts in queue",
              cls: "text-foreground",
            },
            {
              label: "Total Principal",
              value: formatINR(allQueue.reduce((s, d) => s + d.loanAmount, 0)),
              sub: "outstanding principal",
              cls: "text-foreground",
            },
            {
              label: "Total PTP",
              value: formatINR(allQueue.reduce((s, d) => s + (d.ptpAmount ?? 0), 0)),
              sub: `${filterCounts.ptp} accounts promised`,
              cls: "text-blue-500",
            },
          ].map((s, i) => (
            <Card
              key={s.label}
              className="animate-in fade-in duration-300"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <CardContent className="p-4">
                <div className={cn("text-xl font-bold tabular-nums", s.cls)}>{s.value}</div>
                <div className="text-xs font-medium text-foreground mt-0.5">{s.label}</div>
                <div className="text-[11px] text-muted-foreground">{s.sub}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Productive / Non-Productive toggle + breakdown */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* Productive */}
          <Card
            className={cn(
              "border transition-all cursor-pointer",
              prodFilter === "productive"
                ? "border-success ring-1 ring-success/30"
                : "border-border",
            )}
            onClick={() => setProdFilter((p) => (p === "productive" ? "all" : "productive"))}
          >
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-success animate-pulse" />
                  <span className="text-sm font-semibold text-success">Productive</span>
                  <span className="text-xs text-muted-foreground">(debtor responded)</span>
                </div>
                <span className="text-lg font-bold text-success">
                  {filterCounts.callback + filterCounts.ptp + 3 + 6}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: "Callback", value: filterCounts.callback, cls: "text-amber-500" },
                  { label: "PTP", value: filterCounts.ptp, cls: "text-blue-500" },
                  { label: "Partial Paid", value: 3, cls: "text-emerald-500" },
                  { label: "Paid", value: 6, cls: "text-success" },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="rounded-lg bg-muted/30 border border-border p-2 text-center"
                  >
                    <div className={cn("text-base font-bold", s.cls)}>{s.value}</div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Non-Productive */}
          <Card
            className={cn(
              "border transition-all cursor-pointer",
              prodFilter === "non_productive"
                ? "border-destructive ring-1 ring-destructive/30"
                : "border-border",
            )}
            onClick={() =>
              setProdFilter((p) => (p === "non_productive" ? "all" : "non_productive"))
            }
          >
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                  <span className="text-sm font-semibold text-muted-foreground">
                    Non-Productive
                  </span>
                  <span className="text-xs text-muted-foreground">(no response)</span>
                </div>
                <span className="text-lg font-bold text-muted-foreground">
                  {filterCounts.fresh + filterCounts.no_answer + filterCounts.escalated + 5 + 8}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Ringing / Fresh", value: filterCounts.fresh, cls: "text-blue-400" },
                  { label: "Switch Off", value: 5, cls: "text-orange-500" },
                  {
                    label: "NC (No Contact)",
                    value: filterCounts.no_answer + 8,
                    cls: "text-destructive",
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="rounded-lg bg-muted/30 border border-border p-2 text-center"
                  >
                    <div className={cn("text-base font-bold", s.cls)}>{s.value}</div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── PTP Follow-up Tracker ── */}
      <PTPTracker
        onCall={startCall}
        onView={setProfileDebtor}
        queue={allQueue}
        bucketFilter={bucketFilter}
        search={queueSearch}
      />

      {/* ── Call Queue ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionLabel>Call Queue · Today</SectionLabel>

          {/* Dialer controls — above the queue, not in page header */}
          <div className="flex items-center gap-2">
            {/* Manual Dial */}
            <div className="relative">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-sm"
                onClick={() => setManualDialPageOpen((o) => !o)}
              >
                <Hash className="h-3.5 w-3.5" />
                Manual Dial
              </Button>
              {manualDialPageOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-lg border border-border bg-card shadow-xl p-4 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Manual Outbound Call
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">Debtor name (optional)</label>
                    <Input
                      placeholder="e.g. Rahul Sharma"
                      value={manualDialName}
                      onChange={(e) => setManualDialName(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">Phone number to call</label>
                    <Input
                      placeholder="+91 XXXXX XXXXX"
                      value={manualDialNumber}
                      onChange={(e) => setManualDialNumber(e.target.value)}
                      className="h-8 text-sm font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">
                      Caller ID (SmartFlo DID)
                    </label>
                    <Select value={manualDialCallerId} onValueChange={setManualDialCallerId}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SMARTFLO_DIDS.map((did) => (
                          <SelectItem key={did} value={did}>
                            {did}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="w-full gap-1.5 h-8 text-sm"
                    disabled={!manualDialNumber}
                    onClick={() => {
                      const name = manualDialName || manualDialNumber;
                      // Create a temporary debtor object for manual dial
                      const manualDebtor: QueueDebtor = {
                        id: `manual-${Date.now()}`,
                        name: name,
                        phone: manualDialNumber,
                        loanReference: "Manual Dial",
                        loanAmount: 0,
                        dpd: 0,
                        aiScore: 0,
                        status: "contacted",
                        portfolio: "Manual",
                        queueStatus: "fresh",
                        retained: false,
                      };
                      // Agent leg comes from the signed-in agent; the DID is only the caller ID.
                      startCall(manualDebtor, { callerId: manualDialCallerId });
                      toast.success(`Calling ${name} from ${manualDialCallerId}…`);
                      setManualDialPageOpen(false);
                      setManualDialNumber("");
                      setManualDialName("");
                    }}
                  >
                    <Phone className="h-3.5 w-3.5" />
                    Call Now
                  </Button>
                  <p className="text-[10px] text-muted-foreground text-center">
                    Call will be logged and recorded automatically.
                  </p>
                </div>
              )}
            </div>

            {/* Predictive dialer — real engine + simulated provider via useDialerRun */}
            <Button
              size="sm"
              onClick={() => {
                if (dialer.running) {
                  dialer.stop();
                  return;
                }
                // 4b — dial the currently filtered queue, not the whole book
                const target = filteredQueue.length ? filteredQueue : allQueue;
                const activeFilter = FILTERS.find((f) => f.key === queueFilter);
                dialer.start({
                  settings: dialerSettings,
                  targets: target.map((d) => ({
                    id: d.id,
                    name: d.name,
                    phone: d.phone,
                    portfolioId: d.portfolioId,
                    aiScore: d.aiScore,
                  })),
                  agentsAvailable: Math.min(5, target.length),
                });
                toast.success(
                  `Predictive dialing ${activeFilter && queueFilter !== "all" ? `"${activeFilter.label}"` : "full"} queue — ${target.length} account${target.length === 1 ? "" : "s"}`,
                );
                // AI reaches a live debtor and hands over: auto-connect if the agent is free,
                // otherwise raise a Take / Forward notification. (Kept as a demo flourish.)
                setTimeout(() => {
                  const transferDebtor = target[Math.min(5, target.length - 1)];
                  if (transferDebtor) handleAiTransfer(transferDebtor, "AI Bot");
                }, 6000);
              }}
              className={cn(
                "gap-1.5 text-sm",
                dialer.running
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-success text-success-foreground hover:bg-success/90",
              )}
            >
              {dialer.running ? (
                <>
                  <Square className="h-3.5 w-3.5" />
                  Stop Dialer
                </>
              ) : (
                <>
                  <Zap className="h-3.5 w-3.5" />
                  Predictive Dial
                </>
              )}
            </Button>
          </div>
        </div>

        {/* ── Retained debtors — collapsible ── */}
        {(() => {
          const retained = allQueue.filter((d) => d.retained);
          if (!retained.length) return null;
          return (
            <div className="mb-3 rounded-xl border border-violet-400/30 bg-violet-500/5 overflow-hidden">
              <button
                type="button"
                onClick={() => setRetainedOpen((o) => !o)}
                className="w-full flex items-center justify-between px-4 py-2.5 text-left group"
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-violet-500 flex-shrink-0" />
                  <span className="text-sm font-semibold text-violet-600">Retained Debtors</span>
                  <span className="text-xs text-muted-foreground">
                    Carried over from previous month · {retained.length} accounts
                  </span>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-violet-500 transition-transform duration-200",
                    retainedOpen && "rotate-180",
                  )}
                />
              </button>
              {retainedOpen && (
                <div className="border-t border-violet-400/20">
                  <div className="overflow-auto max-h-[300px]">
                    <Table>
                      <TableHeader className="sticky top-0 bg-violet-500/5 z-10">
                        <TableRow>
                          <TableHead>Debtor</TableHead>
                          <TableHead>Phone</TableHead>
                          <TableHead className="text-right">Outstanding</TableHead>
                          <TableHead>DPD</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Scheduled</TableHead>
                          <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {retained.map((d) => {
                          const b = bucketOf(d.dpd);
                          const dpdCls =
                            b === "X" || b === "1"
                              ? "bg-success/8 text-success/70 border-success/15"
                              : b === "2"
                                ? "bg-warning/8 text-warning-foreground/70 border-warning/15"
                                : "bg-destructive/8 text-destructive/70 border-destructive/15";
                          const statusMeta = QUEUE_STATUS_META[d.queueStatus];
                          return (
                            <TableRow key={d.id} className="hover:bg-violet-500/5">
                              <TableCell>
                                <div className="font-medium text-sm">{d.name}</div>
                                <div className="text-[11px] text-muted-foreground">
                                  {d.loanReference ?? d.id} ·{" "}
                                  <span className="text-violet-500">from {d.retainedFrom}</span>
                                </div>
                              </TableCell>
                              <TableCell className="font-mono text-xs">{d.phone}</TableCell>
                              <TableCell className="text-right font-medium text-sm">
                                {formatINR(d.loanAmount)}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={cn("font-medium text-xs", dpdCls)}
                                >
                                  {d.dpd}d
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={cn("text-xs", statusMeta.cls)}>
                                  {statusMeta.label}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {d.scheduledAt}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    size="sm"
                                    className="h-7 px-2 text-xs gap-1"
                                    onClick={() => startCall(d)}
                                  >
                                    <Phone className="h-3 w-3" />
                                    Call
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-7 px-2 text-xs gap-1 bg-success text-success-foreground hover:bg-success/90"
                                  >
                                    <MessageCircle className="h-3 w-3" />
                                    WA
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Currently ringing — sits directly above the queue */}
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-blue-400/25 bg-blue-500/5 px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />
          <span className="text-sm font-semibold text-blue-500">
            Currently Ringing:{" "}
            {dialer.running ? dialer.legs.filter((c) => c.status === "ringing").length : 0}
          </span>
          <span className="text-xs text-muted-foreground">outbound calls active right now</span>
          {prodFilter !== "all" && (
            <button
              type="button"
              onClick={() => setProdFilter("all")}
              className="ml-auto text-xs text-primary hover:underline"
            >
              Clear filter ({prodFilter === "productive" ? "Productive" : "Non-Productive"}) ×
            </button>
          )}
        </div>

        {/* Status filter pills */}
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setQueueFilter(f.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all duration-150",
                queueFilter === f.key
                  ? f.key === "retained"
                    ? "bg-violet-600 text-white border-violet-600"
                    : "bg-foreground text-background border-foreground"
                  : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              {f.label}
              <span
                className={cn(
                  "rounded-full px-1.5 py-0 text-[10px] font-bold",
                  queueFilter === f.key ? "bg-white/20" : "bg-muted text-muted-foreground",
                )}
              >
                {filterCounts[f.key]}
              </span>
            </button>
          ))}

          {/* Bucket dropdown + search — right side */}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setBucketDropOpen((o) => !o)}
                className={cn(
                  "flex items-center gap-1.5 h-7 rounded-lg border px-2.5 text-xs transition-all",
                  bucketFilter !== "all"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {bucketFilter === "all" ? "All Buckets" : BUCKET_META[bucketFilter].label}
                <ChevronDown className="h-3 w-3 opacity-60" />
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
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50",
                      bucketFilter === "all"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    All Buckets
                  </button>
                  {(["X", "1", "2", "NPA", "WriteOff"] as DPDBucket[]).map((b) => (
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
                      <span className="opacity-50">
                        {allQueue.filter((d) => bucketOf(d.dpd) === b).length}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative max-w-xs">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search debtor, loan…"
                value={queueSearch}
                onChange={(e) => setQueueSearch(e.target.value)}
                className="pl-7 h-7 text-xs"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() =>
                exportCSV(
                  "call-queue.csv",
                  [
                    "Name",
                    "Loan ID",
                    "Phone",
                    "Outstanding",
                    "DPD",
                    "Status",
                    "AI Score",
                    "Scheduled",
                  ],
                  filteredQueue.map((d) => [
                    d.name,
                    d.loanReference ?? d.id,
                    d.phone,
                    d.loanAmount,
                    d.dpd,
                    d.queueStatus,
                    d.aiScore,
                    d.scheduledAt,
                  ]),
                )
              }
            >
              <FileDown className="h-3.5 w-3.5" />
              Export
            </Button>
          </div>
        </div>

        <Card className="animate-in fade-in duration-400">
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[480px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    {/* Debtor name — sortable A→Z */}
                    <TableHead>
                      <QColHead
                        label="Debtor"
                        sortKey="name"
                        activeSort={qSortKey}
                        sortDir={qSortDir}
                        onSort={toggleQSort}
                      />
                    </TableHead>
                    <TableHead className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                      Phone
                    </TableHead>

                    {/* Outstanding — sort + range filter */}
                    <TableHead>
                      <QColHead
                        label="Outstanding"
                        sortKey="outstanding"
                        activeSort={qSortKey}
                        sortDir={qSortDir}
                        onSort={toggleQSort}
                        activeFilter={filterOutstanding !== "all"}
                        onFilterToggle={() =>
                          setOpenColFilter((o) => (o === "outstanding" ? null : "outstanding"))
                        }
                      >
                        {openColFilter === "outstanding" && (
                          <ColFilterDropdown onClose={() => setOpenColFilter(null)}>
                            {(
                              [
                                ["all", "All"],
                                ["lt1L", "< ₹1L"],
                                ["1to5L", "₹1L – ₹5L"],
                                ["gt5L", "> ₹5L"],
                              ] as [typeof filterOutstanding, string][]
                            ).map(([v, l]) => (
                              <ColFilterOption
                                key={v}
                                label={l}
                                active={filterOutstanding === v}
                                onClick={() => {
                                  setFilterOutstanding(v);
                                  setOpenColFilter(null);
                                }}
                              />
                            ))}
                          </ColFilterDropdown>
                        )}
                      </QColHead>
                    </TableHead>

                    {/* DPD — sort + range filter */}
                    <TableHead>
                      <QColHead
                        label="DPD"
                        sortKey="dpd"
                        activeSort={qSortKey}
                        sortDir={qSortDir}
                        onSort={toggleQSort}
                        activeFilter={filterDpd !== "all"}
                        onFilterToggle={() => setOpenColFilter((o) => (o === "dpd" ? null : "dpd"))}
                      >
                        {openColFilter === "dpd" && (
                          <ColFilterDropdown onClose={() => setOpenColFilter(null)}>
                            {(
                              [
                                ["all", "All DPD"],
                                ["lt30", "< 30 days"],
                                ["30to60", "30 – 60 days"],
                                ["61to90", "61 – 90 days"],
                                ["gt90", "> 90 days"],
                              ] as [typeof filterDpd, string][]
                            ).map(([v, l]) => (
                              <ColFilterOption
                                key={v}
                                label={l}
                                active={filterDpd === v}
                                onClick={() => {
                                  setFilterDpd(v);
                                  setOpenColFilter(null);
                                }}
                              />
                            ))}
                          </ColFilterDropdown>
                        )}
                      </QColHead>
                    </TableHead>

                    {/* Status — sort + value filter */}
                    <TableHead>
                      <QColHead
                        label="Status"
                        sortKey="status"
                        activeSort={qSortKey}
                        sortDir={qSortDir}
                        onSort={toggleQSort}
                        activeFilter={filterStatus !== "all"}
                        onFilterToggle={() =>
                          setOpenColFilter((o) => (o === "status" ? null : "status"))
                        }
                      >
                        {openColFilter === "status" && (
                          <ColFilterDropdown onClose={() => setOpenColFilter(null)}>
                            {(
                              [
                                ["all", "All"],
                                ["fresh", "Fresh"],
                                ["callback", "Callback"],
                                ["ptp", "PTP"],
                                ["no_answer", "No Answer"],
                                ["escalated", "Escalated"],
                              ] as [typeof filterStatus, string][]
                            ).map(([v, l]) => (
                              <ColFilterOption
                                key={v}
                                label={l}
                                active={filterStatus === v}
                                onClick={() => {
                                  setFilterStatus(v);
                                  setOpenColFilter(null);
                                }}
                              />
                            ))}
                          </ColFilterDropdown>
                        )}
                      </QColHead>
                    </TableHead>

                    {/* AI Score — sort + range filter */}
                    <TableHead>
                      <QColHead
                        label="Score"
                        sortKey="aiScore"
                        activeSort={qSortKey}
                        sortDir={qSortDir}
                        onSort={toggleQSort}
                        activeFilter={filterScore !== "all"}
                        onFilterToggle={() =>
                          setOpenColFilter((o) => (o === "score" ? null : "score"))
                        }
                      >
                        {openColFilter === "score" && (
                          <ColFilterDropdown onClose={() => setOpenColFilter(null)}>
                            {(
                              [
                                ["all", "All"],
                                ["high", "High (8–10)"],
                                ["mid", "Mid (5–7)"],
                                ["low", "Low (1–4)"],
                              ] as [typeof filterScore, string][]
                            ).map(([v, l]) => (
                              <ColFilterOption
                                key={v}
                                label={l}
                                active={filterScore === v}
                                onClick={() => {
                                  setFilterScore(v);
                                  setOpenColFilter(null);
                                }}
                              />
                            ))}
                          </ColFilterDropdown>
                        )}
                      </QColHead>
                    </TableHead>

                    {/* Scheduled — sortable */}
                    <TableHead>
                      <QColHead
                        label="Scheduled"
                        sortKey="scheduled"
                        activeSort={qSortKey}
                        sortDir={qSortDir}
                        onSort={toggleQSort}
                      />
                    </TableHead>

                    <TableHead className="text-muted-foreground text-xs font-medium uppercase tracking-wider min-w-[160px]">
                      Reason
                    </TableHead>

                    {/* Reset all column filters */}
                    <TableHead className="text-right">
                      {qSortKey ||
                      filterOutstanding !== "all" ||
                      filterDpd !== "all" ||
                      filterScore !== "all" ||
                      filterStatus !== "all" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setQSortKey(null);
                            setFilterOutstanding("all");
                            setFilterDpd("all");
                            setFilterScore("all");
                            setFilterStatus("all");
                          }}
                          className="text-[10px] text-primary hover:underline whitespace-nowrap"
                        >
                          Reset filters
                        </button>
                      ) : (
                        <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                          Actions
                        </span>
                      )}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredQueue.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="text-center py-12 text-muted-foreground text-sm"
                      >
                        No debtors match this filter.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredQueue.map((d, i) => (
                      <QueueRow
                        key={d.id}
                        d={d}
                        index={i}
                        onCall={startCall}
                        onView={setProfileDebtor}
                        loggedOutcome={loggedOutcomes[d.id]}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ── Activity history — moved to its own page ── */}
      <section>
        <Link
          to="/dashboard/history"
          className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-all hover:border-foreground/30 hover:shadow-sm"
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted flex-shrink-0">
            <Clock className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">Activity History</div>
            <div className="text-xs text-muted-foreground">
              Full call, IVR, SMS &amp; WhatsApp history with filters — now on its own page.
            </div>
          </div>
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary group-hover:underline flex-shrink-0">
            Open <ArrowRightLeft className="h-3.5 w-3.5" />
          </span>
        </Link>
      </section>

      {/* ── Active Call ── */}
      {activeCall && activeCall.view === "panel" && (
        <ActiveCallPanel
          call={activeCall}
          disposition={disposition}
          onDisposition={setDisposition}
          onMute={() => setActiveCall((c) => (c ? { ...c, muted: !c.muted } : null))}
          onHold={() => setActiveCall((c) => (c ? { ...c, held: !c.held } : null))}
          onEnd={endCall}
          onSubmit={submitDisposition}
          onSwitchView={() => setActiveCall((c) => (c ? { ...c, view: "modal" } : null))}
          onMinimize={() => setActiveCall((c) => (c ? { ...c, view: "minimized" } : null))}
        />
      )}
      {activeCall && activeCall.view === "modal" && (
        <ActiveCallModal
          call={activeCall}
          disposition={disposition}
          onDisposition={setDisposition}
          onMute={() => setActiveCall((c) => (c ? { ...c, muted: !c.muted } : null))}
          onHold={() => setActiveCall((c) => (c ? { ...c, held: !c.held } : null))}
          onEnd={endCall}
          onSubmit={submitDisposition}
          onSwitchView={() => setActiveCall((c) => (c ? { ...c, view: "panel" } : null))}
          onMinimize={() => setActiveCall((c) => (c ? { ...c, view: "minimized" } : null))}
        />
      )}

      {/* ── Incoming AI transfer — only shown while the agent is already on a call ── */}
      {incomingTransfer && (
        <IncomingTransferNotification
          debtor={incomingTransfer.debtor}
          from={incomingTransfer.from}
          onTake={takeTransfer}
          onForward={forwardTransfer}
        />
      )}

      {/* ── Floating Live Calls Panel (bottom-right) — fed by engine legs ── */}
      {dialer.running && dialer.legs.length > 0 && (
        <LiveCallsPanel
          liveCalls={dialer.legs}
          onDismiss={() => dialer.stop()}
          onTake={(lc) => {
            const debtor = allQueue.find((d) => d.id === lc.loanId) ?? allQueue[0];
            startCall(debtor);
          }}
          onTransfer={(lc) => {
            toast.success(`${lc.debtor} redirected to next available agent`);
          }}
        />
      )}

      {/* ── Escalation Modal ── */}
      {escalationCall && (
        <EscalationModal
          debtor={escalationCall.debtor}
          prefillNotes={escalationCall.notes}
          agentId={agentId}
          agentName={agentName}
          onClose={() => setEscalationCall(null)}
        />
      )}

      {/* ── Debtor Profile Sheet ── */}
      <Sheet
        open={!!profileDebtor}
        onOpenChange={(open) => {
          if (!open) setProfileDebtor(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full max-w-2xl p-0 overflow-hidden flex flex-col sm:max-w-2xl"
        >
          {profileDebtor && (
            <DebtorProfileSheet
              debtor={profileDebtor}
              onClose={() => setProfileDebtor(null)}
              onCall={startCall}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Queue Row ────────────────────────────────────────────────────────────────

function QueueRow({
  d,
  index,
  onCall,
  onView,
  loggedOutcome,
}: {
  d: QueueDebtor;
  index: number;
  onCall: (d: QueueDebtor) => void;
  onView: (d: QueueDebtor) => void;
  loggedOutcome?: { outcome: CallOutcome; time: string };
}) {
  const b = bucketOf(d.dpd);
  const dpdCls =
    b === "X" || b === "1"
      ? "bg-success/8 text-success/70 border-success/15"
      : b === "2"
        ? "bg-warning/8 text-warning-foreground/70 border-warning/15"
        : "bg-destructive/8 text-destructive/70 border-destructive/15";
  const scoreCls =
    d.aiScore >= 8
      ? "bg-success text-success-foreground"
      : d.aiScore >= 5
        ? "bg-warning text-warning-foreground"
        : "bg-destructive text-destructive-foreground";
  const statusMeta = QUEUE_STATUS_META[d.queueStatus];
  return (
    <TableRow
      className={cn(
        "animate-in fade-in duration-300 hover:bg-primary/5 cursor-pointer align-top",
        loggedOutcome && "bg-success/3",
      )}
      style={{ animationDelay: `${Math.min(index * 25, 400)}ms` }}
    >
      <TableCell>
        <button
          type="button"
          onClick={() => onView(d)}
          className="text-left hover:underline decoration-primary/40 underline-offset-2"
        >
          <div className="font-medium text-sm text-foreground">{d.name}</div>
          <div className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
            {d.loanReference ?? d.id}
            {d.retained && <span className="text-violet-500 font-semibold">· Retained</span>}
            {loggedOutcome && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 rounded px-1 py-px text-[9px] font-bold border",
                  OUTCOME_META[loggedOutcome.outcome].cls,
                )}
              >
                <Check className="h-2.5 w-2.5" />
                {OUTCOME_META[loggedOutcome.outcome].label} · {loggedOutcome.time}
              </span>
            )}
          </div>
        </button>
      </TableCell>
      <TableCell className="font-mono text-xs text-foreground">{d.phone}</TableCell>
      <TableCell className="text-right font-medium text-sm">{formatINR(d.loanAmount)}</TableCell>
      <TableCell>
        <Badge variant="outline" className={cn("font-medium text-xs", dpdCls)}>
          {d.dpd}d
        </Badge>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={cn("text-xs", statusMeta.cls)}>
          {statusMeta.label}
        </Badge>
      </TableCell>
      <TableCell>
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold",
            scoreCls,
          )}
        >
          {d.aiScore}
        </span>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {d.scheduledAt}
      </TableCell>
      <TableCell>
        <p className="text-xs text-foreground/80 max-w-[160px] leading-snug">{d.scoreReason}</p>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            className="h-7 px-2 text-xs gap-1 active:scale-95"
            onClick={() => onCall(d)}
          >
            <Phone className="h-3 w-3" />
            Call
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs gap-1 bg-success text-success-foreground hover:bg-success/90 active:scale-95"
          >
            <MessageCircle className="h-3 w-3" />
            WA
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground active:scale-95"
          >
            <SkipForward className="h-3 w-3" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── Queue column sort + filter head ─────────────────────────────────────────

function QColHead({
  label,
  sortKey,
  activeSort,
  sortDir,
  onSort,
  activeFilter,
  onFilterToggle,
  children,
}: {
  label: string;
  sortKey: QueueSortKey;
  activeSort: QueueSortKey | null;
  sortDir: "asc" | "desc";
  onSort: (k: QueueSortKey) => void;
  // Omit both for columns that have no filter — the filter button is then hidden.
  activeFilter?: boolean;
  onFilterToggle?: () => void;
  children?: React.ReactNode;
}) {
  const isActive = activeSort === sortKey;
  const SortIcon = !isActive ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <div className="relative flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider transition-colors hover:text-foreground whitespace-nowrap",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <SortIcon className="h-3 w-3 flex-shrink-0" />
      </button>
      {onFilterToggle && (
        <button
          type="button"
          onClick={onFilterToggle}
          className={cn(
            "ml-0.5 rounded p-0.5 transition-colors hover:bg-muted/60",
            activeFilter ? "text-primary" : "text-muted-foreground/50 hover:text-muted-foreground",
          )}
        >
          <Filter className="h-3 w-3" />
        </button>
      )}
      {children}
    </div>
  );
}

function ColFilterDropdown({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 top-full mt-1 z-40 min-w-[140px] rounded-lg border border-border bg-card shadow-xl py-1 animate-in fade-in zoom-in-95 duration-100">
        {children}
      </div>
    </>
  );
}

function ColFilterOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-muted/50 flex items-center justify-between gap-2",
        active ? "text-foreground font-semibold" : "text-muted-foreground",
      )}
    >
      {label}
      {active && <span className="h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />}
    </button>
  );
}

// ─── Incoming Transfer Notification ───────────────────────────────────────────
// Prominent, high-visibility prompt shown ONLY when the agent is already on a call
// and the AI hands over another connected debtor. Sits top-center, above everything.

function IncomingTransferNotification({
  debtor,
  from,
  onTake,
  onForward,
}: {
  debtor: QueueDebtor;
  from: string;
  onTake: () => void;
  onForward: () => void;
}) {
  return (
    <div className="fixed inset-x-0 top-4 z-[60] flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border-2 border-amber-400/60 bg-card shadow-2xl shadow-black/30 animate-in slide-in-from-top-4 fade-in duration-300 overflow-hidden">
        <div className="flex items-center gap-2 bg-amber-500/15 px-4 py-2 border-b border-amber-400/30">
          <PhoneForwarded className="h-4 w-4 text-amber-600 animate-pulse flex-shrink-0" />
          <span className="text-sm font-bold text-amber-700">Incoming call transfer</span>
          <span className="ml-auto text-[11px] font-medium text-amber-600/80">from {from}</span>
        </div>
        <div className="px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500/15 flex-shrink-0">
              <span className="text-base font-bold text-amber-700">{debtor.name.charAt(0)}</span>
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold text-foreground truncate">{debtor.name}</div>
              <div className="text-xs text-muted-foreground">
                {debtor.loanReference ?? debtor.id} · {debtor.phone}
              </div>
            </div>
            <div className="ml-auto text-right flex-shrink-0">
              <div className="text-sm font-bold text-foreground tabular-nums">
                {formatINR(debtor.loanAmount)}
              </div>
              <div className="text-[11px] text-muted-foreground">{debtor.dpd}d overdue</div>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            You're already on a call. Take this over to connect now, or forward it to the next
            available agent.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              onClick={onTake}
              className="h-10 gap-1.5 bg-success text-success-foreground hover:bg-success/90"
            >
              <Phone className="h-4 w-4" />
              Take Call
            </Button>
            <Button onClick={onForward} variant="outline" className="h-10 gap-1.5">
              <PhoneForwarded className="h-4 w-4" />
              Forward
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Dialer mode status bar ─────────────────────────────────────────────────
// Shared by the agent's own call queue and the manager's read-only Agent Live View
// so both surfaces show an identical portfolio-mode + dialer-status strip.
export function DialerModeBar({
  portfolioMode,
  portfolioName,
  dialerRunning,
}: {
  portfolioMode: CallMode;
  portfolioName: string;
  dialerRunning: boolean;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap rounded-xl border border-border bg-card px-4 py-2.5">
      {/* Portfolio mode — read-only, set by manager */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Portfolio Mode
        </span>
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold",
            portfolioMode === "hybrid"
              ? "border-violet-400/20 bg-violet-500/8 text-violet-500"
              : portfolioMode === "ai_only"
                ? "border-blue-400/20 bg-blue-500/8 text-blue-500"
                : portfolioMode === "ivr_agent"
                  ? "border-amber-400/20 bg-amber-500/8 text-amber-600"
                  : "border-primary/20 bg-primary/8 text-primary",
          )}
        >
          {portfolioMode === "hybrid" ? (
            <>
              <BotMessageSquare className="h-3 w-3" />
              Hybrid (AI + Agent)
            </>
          ) : portfolioMode === "ai_only" ? (
            <>
              <BotMessageSquare className="h-3 w-3" />
              AI Only
            </>
          ) : portfolioMode === "ivr_agent" ? (
            <>
              <PhoneCall className="h-3 w-3" />
              IVR + Agent
            </>
          ) : (
            <>
              <Phone className="h-3 w-3" />
              Agent Only
            </>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground">· {portfolioName}</span>
        <span className="text-[10px] text-muted-foreground/50 italic">set by manager</span>
      </div>

      <div className="h-4 w-px bg-border" />

      {/* Dialer status */}
      <span className="inline-flex items-center gap-1.5 text-xs font-medium">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            dialerRunning ? "bg-success animate-pulse" : "bg-muted-foreground",
          )}
        />
        <span className={dialerRunning ? "text-success" : "text-muted-foreground"}>
          Predictive Dialer {dialerRunning ? "RUNNING" : "OFF"}
        </span>
      </span>

      {(portfolioMode === "hybrid" || portfolioMode === "ivr_agent") && dialerRunning && (
        <>
          <div className="h-4 w-px bg-border" />
          {portfolioMode === "hybrid" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-violet-500 animate-pulse" />
              AI active
            </span>
          )}
          {portfolioMode === "ivr_agent" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              IVR active
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            Agents active
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Today · 30 Jun 2026</span>
      </div>
    </div>
  );
}

// ─── Live Calls Panel ─────────────────────────────────────────────────────────

export function LiveCallsPanel({
  liveCalls,
  onDismiss,
  onTake,
  onTransfer,
}: {
  liveCalls: LiveCallEntry[];
  onDismiss: () => void;
  onTake: (lc: LiveCallEntry) => void;
  onTransfer: (lc: LiveCallEntry) => void;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const connected = liveCalls.filter((c) => c.status === "connected").length;
  const ringing = liveCalls.filter((c) => c.status === "ringing").length;
  const transfers = liveCalls.filter((c) => c.incoming).length;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-72 rounded-xl border border-border bg-card shadow-2xl shadow-black/20 animate-in slide-in-from-bottom-4 duration-300 overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setCollapsed((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors border-b border-border"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />
        <span className="text-xs font-semibold text-foreground flex-1 text-left">Live Calls</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {connected}✓ {ringing}↻ {liveCalls.length} total
        </span>
        {transfers > 0 && (
          <span className="rounded bg-amber-500/15 px-1.5 py-px text-[9px] font-bold text-amber-600">
            {transfers} transfer{transfers > 1 ? "s" : ""}
          </span>
        )}
        {collapsed ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="text-muted-foreground hover:text-foreground flex-shrink-0 ml-0.5"
        >
          <X className="h-3 w-3" />
        </button>
      </button>

      {/* Call rows — hidden when collapsed */}
      {!collapsed && (
        <div className="divide-y divide-border/60 max-h-64 overflow-y-auto">
          {liveCalls.map((lc) => {
            const dotCls =
              lc.status === "connected"
                ? "bg-success animate-pulse"
                : lc.status === "ringing"
                  ? "bg-blue-400 animate-pulse"
                  : lc.status === "on_hold"
                    ? "bg-amber-400"
                    : lc.status === "no_answer"
                      ? "bg-destructive"
                      : "bg-muted-foreground";
            const statusShort =
              lc.status === "connected"
                ? "Live"
                : lc.status === "ringing"
                  ? "Ring"
                  : lc.status === "on_hold"
                    ? "Hold"
                    : lc.status === "no_answer"
                      ? "N/A"
                      : "Done";

            return (
              <div
                key={lc.id}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5",
                  lc.incoming
                    ? "bg-amber-500/5 border-l-2 border-l-amber-500"
                    : "hover:bg-muted/20",
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", dotCls)} />

                {/* Debtor + loan */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 leading-none">
                    <span className="text-[11px] font-medium text-foreground truncate">
                      {lc.debtor}
                    </span>
                    {lc.type === "ai" && (
                      <span className="text-[8px] font-bold text-violet-500 flex-shrink-0">AI</span>
                    )}
                    {lc.incoming && (
                      <span className="text-[8px] font-bold text-amber-600 flex-shrink-0">↩</span>
                    )}
                  </div>
                  <span className="text-[9px] text-muted-foreground">{lc.loanId}</span>
                </div>

                {/* Status + duration */}
                <div className="flex-shrink-0 text-right mr-1">
                  <div
                    className={cn(
                      "text-[9px] font-semibold leading-none",
                      lc.status === "connected"
                        ? "text-success"
                        : lc.status === "ringing"
                          ? "text-blue-400"
                          : lc.status === "no_answer"
                            ? "text-destructive"
                            : "text-muted-foreground",
                    )}
                  >
                    {statusShort}
                  </div>
                  <div className="font-mono text-[9px] text-muted-foreground">{lc.duration}</div>
                </div>

                {/* Transfer actions — inline pill buttons */}
                {lc.incoming && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => onTake(lc)}
                      className="rounded bg-success/15 px-1.5 py-0.5 text-[9px] font-bold text-success hover:bg-success/25 transition-colors"
                    >
                      Take
                    </button>
                    <button
                      type="button"
                      onClick={() => onTransfer(lc)}
                      className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground hover:bg-muted/70 transition-colors"
                    >
                      Fwd
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
