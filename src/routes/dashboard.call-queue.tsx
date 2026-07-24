import { createFileRoute, Link } from "@tanstack/react-router";
import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  MessageCircle,
  SkipForward,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  BotMessageSquare,
  HandCoins,
  Play,
  Square,
  Maximize2,
  Minimize2,
  Minus,
  MicOff,
  Mic,
  PauseCircle,
  PhoneOff,
  UserRoundCog,
  ChevronDown,
  ChevronUp,
  CalendarClock,
  IndianRupee,
  AlertTriangle,
  X,
  Clock,
  CheckCheck,
  Check,
  CreditCard,
  FileText,
  TrendingDown,
  Banknote,
  PlayCircle,
  StopCircle,
  ShieldAlert,
  Send,
  Flag,
  EarOff,
  Ear,
  GitMerge,
  PhoneForwarded,
  ArrowRightLeft,
  Hash,
  Zap,
  Bell,
  Filter,
  FileDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { bucketOf, formatINR, type Debtor, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";
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
  EMPTY_DISPOSITION,
  OUTCOME_META,
  AI_STATUS_META,
  QUEUE_STATUS_META,
  STATUS_META,
  PRODUCTIVE_STATUSES,
  NON_PRODUCTIVE_STATUSES,
  type QueueFilter,
  type ProdFilter,
  type QueueSortKey,
  type SortKey,
  type SortDir,
  type SortKeyAny,
  type CallOutcome,
  type ActiveTab,
  type CallPhase,
  type CallView,
  type ActiveCall,
  type DispositionForm,
  type QueueDebtor,
  type LiveCallEntry,
  type AgentStatus,
  type CallControlProps,
} from "@/lib/call-queue/types";
// Re-export the shared types/consts so existing importers of this route file keep working.
export * from "@/lib/call-queue/types";
import {
  exportCSV,
  AI_QUEUE,
  AI_STATS,
  CALL_HISTORY,
  type AIQueueFilter,
  type CallRecord,
} from "@/lib/call-queue/mock-data";
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
import { saveEscalation } from "@/lib/escalation-store";
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
  const [manualDialSip, setManualDialSip] = useState("sip1");
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
  const [activeTab, setActiveTab] = useState<ActiveTab>("agent");
  const [queueSearch, setQueueSearch] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

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
  const [playingId, setPlayingId] = useState<string | null>(null);

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
  // Single manual call driven by the sim provider + call-machine (ringing → connected via
  // real events, no auto-hangup). Replaces the old blind setTimeout-to-connected.
  const singleCall = useSingleCall(setActiveCall);

  // Keep a ref to the live active call so async dialer callbacks can read the latest value
  const activeCallRef = useRef<ActiveCall | null>(null);
  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  const startCall = (debtor: QueueDebtor, opts?: { instant?: boolean }) => {
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
    if (!opts?.instant) singleCall.dial(debtor);
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

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    let rows = CALL_HISTORY;
    if (q)
      rows = rows.filter(
        (c) =>
          c.debtorName.toLowerCase().includes(q) ||
          c.loanId.toLowerCase().includes(q) ||
          c.outcome.includes(q),
      );
    return [...rows].sort((a, b) => {
      let av: string | number = a.time,
        bv: string | number = b.time;
      if (sortKey === "debtorName") {
        av = a.debtorName;
        bv = b.debtorName;
      }
      if (sortKey === "duration") {
        av = a.durationSecs;
        bv = b.durationSecs;
      }
      if (sortKey === "outcome") {
        av = a.outcome;
        bv = b.outcome;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [historySearch, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

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
                      SIP Line{" "}
                      <span className="text-muted-foreground/50">(future integration)</span>
                    </label>
                    <Select value={manualDialSip} onValueChange={setManualDialSip}>
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sip1">SIP-001 · Main Line (+91 22 4xxx xxxx)</SelectItem>
                        <SelectItem value="sip2">
                          SIP-002 · Backup Line (+91 22 4xxx xxxy)
                        </SelectItem>
                        <SelectItem value="sip3">
                          SIP-003 · Regional North (+91 11 4xxx xxxx)
                        </SelectItem>
                        <SelectItem value="sip4">
                          SIP-004 · Regional South (+91 44 4xxx xxxx)
                        </SelectItem>
                        <SelectItem value="sip5">
                          SIP-005 · IVR Bridge (+91 80 4xxx xxxx)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="w-full gap-1.5 h-8 text-sm"
                    disabled={!manualDialNumber}
                    onClick={() => {
                      const name = manualDialName || manualDialNumber;
                      toast.success(`Calling ${name} via ${manualDialSip.toUpperCase()}…`);
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

// ─── Agent Calls Panel ────────────────────────────────────────────────────────

function AgentCallsPanel() {
  const activeCalls = [
    {
      agent: "You",
      debtor: "Karthik Nair",
      loanId: "L-10122",
      duration: "1m 42s",
      status: "talking",
    },
    {
      agent: "Ravi M.",
      debtor: "Imran Sheikh",
      loanId: "L-10478",
      duration: "0m 28s",
      status: "ringing",
    },
    {
      agent: "Pooja S.",
      debtor: "Sara Khan",
      loanId: "L-10612",
      duration: "3m 55s",
      status: "talking",
    },
    { agent: "Deepak R.", debtor: "Nikita Rao", loanId: "L-10588", duration: "—", status: "break" },
    {
      agent: "Anita K.",
      debtor: "Sandeep Yadav",
      loanId: "L-10199",
      duration: "2m 11s",
      status: "talking",
    },
  ];
  const statusMeta: Record<string, { label: string; dot: string; cls: string }> = {
    talking: { label: "Talking", dot: "bg-success animate-pulse", cls: "text-success" },
    ringing: { label: "Ringing", dot: "bg-blue-400 animate-pulse", cls: "text-blue-500" },
    break: { label: "On Break", dot: "bg-orange-400", cls: "text-orange-500" },
  };
  return (
    <Card>
      <CardHeader className="pb-2 border-b border-border">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">Active Agent Sessions</CardTitle>
          <span className="text-xs text-muted-foreground">3 talking · 1 ringing · 1 on break</span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Debtor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activeCalls.map((row) => {
              const meta = statusMeta[row.status];
              return (
                <TableRow key={row.agent} className="hover:bg-primary/5">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold">
                        {row.agent[0]}
                      </div>
                      <span className="text-sm font-medium">{row.agent}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{row.debtor}</div>
                    <div className="text-[11px] text-muted-foreground">{row.loanId}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
                      <span className={cn("text-xs font-semibold", meta.cls)}>{meta.label}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm tabular-nums">{row.duration}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-xs">
                      Monitor
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── AI Calls Panel ───────────────────────────────────────────────────────────

const AI_FILTER_META: { key: AIQueueFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "in_call", label: "In Call" },
  { key: "waiting", label: "Waiting" },
  { key: "ptp", label: "PTP" },
  { key: "paid", label: "Paid" },
  { key: "no_answer", label: "No Answer" },
  { key: "escalated", label: "Escalated" },
  { key: "done", label: "Done" },
];

function AICallsPanel() {
  const [aiFilter, setAiFilter] = useState<AIQueueFilter>("all");
  const [aiSearch, setAiSearch] = useState("");

  const aiFilterCounts = {
    all: AI_QUEUE.length,
    in_call: AI_QUEUE.filter((r) => r.queueFilter === "in_call").length,
    waiting: AI_QUEUE.filter((r) => r.queueFilter === "waiting").length,
    ptp: AI_QUEUE.filter((r) => r.queueFilter === "ptp").length,
    paid: AI_QUEUE.filter((r) => r.queueFilter === "paid").length,
    no_answer: AI_QUEUE.filter((r) => r.queueFilter === "no_answer").length,
    escalated: AI_QUEUE.filter((r) => r.queueFilter === "escalated").length,
    done: AI_QUEUE.filter((r) => r.status === "done").length,
  };

  const filtered = AI_QUEUE.filter((r) => {
    const matchFilter =
      aiFilter === "all" ||
      r.queueFilter === aiFilter ||
      (aiFilter === "done" && r.status === "done");
    const q = aiSearch.trim().toLowerCase();
    const matchSearch =
      !q || r.debtorName.toLowerCase().includes(q) || r.loanId.toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Handled", value: AI_STATS.callsHandled },
          { label: `PTPs · ${formatINR(AI_STATS.ptpAmount)}`, value: AI_STATS.ptpsCaptured },
          { label: "Escalated", value: AI_STATS.escalated },
          { label: "No Answer", value: AI_STATS.noAnswer },
        ].map((s, i) => (
          <Card
            key={s.label}
            className="animate-in fade-in duration-400"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-foreground">{s.value}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter pills + search */}
      <div className="flex flex-wrap gap-2 items-center">
        {AI_FILTER_META.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setAiFilter(f.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all duration-150",
              aiFilter === f.key
                ? "bg-foreground text-background border-foreground"
                : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {f.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-0 text-[10px] font-bold",
                aiFilter === f.key ? "bg-white/20" : "bg-muted text-muted-foreground",
              )}
            >
              {aiFilterCounts[f.key]}
            </span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative max-w-xs">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search debtor, loan…"
              value={aiSearch}
              onChange={(e) => setAiSearch(e.target.value)}
              className="pl-7 h-7 text-xs"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={() =>
              exportCSV(
                "ai-queue.csv",
                [
                  "ID",
                  "Debtor",
                  "Loan ID",
                  "Phone",
                  "Status",
                  "Duration",
                  "Outcome",
                  "Last Message",
                ],
                filtered.map((q) => [
                  q.id,
                  q.debtorName,
                  q.loanId,
                  q.phone,
                  q.status,
                  q.duration,
                  q.outcome ?? "",
                  q.lastMsg,
                ]),
              )
            }
          >
            <FileDown className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      {/* Queue table — scrollable within card */}
      <Card>
        <CardHeader className="pb-2 border-b border-border">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">AI Bot Queue · Live</CardTitle>
            <div className="flex items-center gap-1.5 text-xs text-success">
              <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
              {AI_STATS.inCall} active
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[400px]">
            <Table>
              <TableHeader className="sticky top-0 bg-card z-10">
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Debtor</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="min-w-[240px]">Bot Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-center py-10 text-muted-foreground text-sm"
                    >
                      No AI calls match this filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((row) => {
                    const meta = AI_STATUS_META[row.status];
                    return (
                      <TableRow key={row.id} className="hover:bg-primary/5 align-top">
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
                            <span className={cn("text-xs font-semibold", meta.cls)}>
                              {meta.label}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-sm">{row.debtorName}</div>
                          <div className="text-[11px] text-muted-foreground">{row.loanId}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {row.phone}
                        </TableCell>
                        <TableCell className="text-sm font-medium tabular-nums">
                          {row.duration}
                        </TableCell>
                        <TableCell>
                          {row.outcome ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-xs",
                                OUTCOME_META[row.outcome as CallOutcome]?.cls,
                              )}
                            >
                              {OUTCOME_META[row.outcome as CallOutcome]?.label}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <p className="text-xs text-foreground/80 leading-relaxed">
                            {row.lastMsg}
                          </p>
                        </TableCell>
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

// ─── Language scripts ─────────────────────────────────────────────────────────

const CALL_SCRIPTS: Record<
  string,
  { opener: string; ptp: string; refused: string; tips: string[] }
> = {
  Hindi: {
    opener:
      "Namaste [Name] ji, main [Bank] ki taraf se baat kar raha/rahi hoon. Aapka EMI ₹[amount] due hai.",
    ptp: "Kya aap [date] tak payment kar sakte hain? Agar haan, toh main aapke liye note kar leta/leti hoon.",
    refused:
      "Main samajh sakta/sakti hoon. Kya aap mujhe bata sakte hain kya pareshani hai? Hum milke koi solution nikalte hain.",
    tips: [
      "Use 'aap' not 'tum' — formal register",
      "Avoid calling after 7 PM",
      "Mention bank name early — builds trust",
    ],
  },
  Tamil: {
    opener:
      "Vanakkam [Name] avargale, naan [Bank] irundu pesugiren. Ungal EMI ₹[amount] due aagiradu.",
    ptp: "[Date] ku payment pannalamaa? Naan ungalukkaaga note pannikiréen.",
    refused: "Purinjukiren. Enna samsyam nu sollunga — naama serndu oru solution kaanom.",
    tips: [
      "Address as 'avargal' for respect",
      "Morning calls preferred 9–11 AM",
      "If no Tamil comfort, offer to switch to English",
    ],
  },
  Telugu: {
    opener:
      "Namaskaram [Name] garu, nenu [Bank] nundi matladutunna. Meeru EMI ₹[amount] chellinchaali.",
    ptp: "[Date] loga payment chestha ra? Nenu note chestukonaanu.",
    refused: "Artham chesukuntunna. Samasyanu cheppandi — kalupu pettukoni solution chustaam.",
    tips: [
      "Use 'garu' suffix — mandatory for respect",
      "Evening 5–7 PM is best window",
      "Confirm language comfort before script",
    ],
  },
  Gujarati: {
    opener:
      "Kem cho [Name] bhai/ben, hun [Bank] thi boli raha/rahi chhu. Tamaro EMI ₹[amount] due chhe.",
    ptp: "[Date] sudhi payment karsha? Hu tamara maate note kari lidhu chhe.",
    refused: "Samajhyu. Shun takleef chhe te kaho — aapde sathe milaine solution kadhiye.",
    tips: [
      "'Bhai' for male, 'Ben' for female",
      "Business community — mention consequences briefly",
      "Be concise — they value time",
    ],
  },
  Marathi: {
    opener: "Namaskar [Name] ji, mi [Bank] madhun bolat ahe. Tumcha EMI ₹[amount] due ahe.",
    ptp: "[Date] paryant payment karal ka? Mi tumchyasathi note karto/karte.",
    refused: "Samajato/samajate. Kaay problem ahe te sanga — aapan milun solution kadhuyat.",
    tips: [
      "Use 'ji' suffix throughout",
      "Pune/Mumbai debtors prefer evenings",
      "Reference lender name — Marathi trust formal institutions",
    ],
  },
  English: {
    opener:
      "Good [morning/afternoon] [Name], I'm calling from [Bank] regarding your outstanding EMI of ₹[amount].",
    ptp: "Would you be able to make the payment by [date]? I'll note that down for you.",
    refused:
      "I understand. Could you help me understand the situation? Let's work together to find a solution.",
    tips: [
      "Maintain professional tone throughout",
      "Confirm preferred callback time if not available now",
      "Summarise agreed action before ending call",
    ],
  },
};

function getScript(language: string) {
  return CALL_SCRIPTS[language] ?? CALL_SCRIPTS["Hindi"];
}

// ─── Active Call Components ───────────────────────────────────────────────────

function fmtElapsed(s: number) {
  const m = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function ActiveCallContent({
  call,
  disposition,
  onDisposition,
  onMute,
  onHold,
  onEnd,
  onSubmit,
  onSwitchView,
  onMinimize,
}: CallControlProps) {
  const { debtor, phase, muted, held, elapsed } = call;

  // elapsed ticks centrally in CallSessionProvider so it keeps counting regardless of which
  // call UI (or none) is currently mounted — nothing to do here but read it off `call`.

  // Advanced call controls state
  const [whisper, setWhisper] = useState(false);
  const [whisperTarget, setWhisperTarget] = useState<string | null>(null);
  const [whisperOpen, setWhisperOpen] = useState(false);
  const [conferenced, setConferenced] = useState(false);
  const [addCallOpen, setAddCallOpen] = useState(false);
  const [addCallNumber, setAddCallNumber] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [manualDialOpen, setManualDialOpen] = useState(false);
  const [manualNumber, setManualNumber] = useState("");
  const [dialPadInput, setDialPadInput] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergedWith, setMergedWith] = useState<string | null>(null);

  const SUPERVISORS = [
    "Amit Sharma (Supervisor)",
    "Preethi Menon (Manager)",
    "Rohit Bose (Team Lead)",
  ];
  const AGENTS_LIST = ["Ravi Mehta", "Sonal Desai", "Mohit Rao", "Leena Krishnan", "Tarun Bose"];

  const up = (patch: Partial<DispositionForm>) => onDisposition({ ...disposition, ...patch });

  const bucket = bucketOf(debtor.dpd);
  const bucketMeta = BUCKET_META[bucket];

  // Declared before the ringing early-return below so hook count/order stays identical across
  // phase transitions — React can otherwise reuse this component instance (rather than
  // remounting it) between the ringing and connected renders, and a hook declared after an
  // early return would then violate the Rules of Hooks ("Rendered more hooks than during the
  // previous render").
  const [infoTab, setInfoTab] = useState<"loan" | "personal" | "payments" | "contacts">("loan");

  /* ── Ringing: compact single-row ── */
  if (phase === "ringing") {
    return (
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">
            {debtor.name
              .split(" ")
              .map((n) => n[0])
              .slice(0, 2)
              .join("")}
          </div>
          <div>
            <div className="font-semibold text-foreground text-sm">{debtor.name}</div>
            <div className="text-xs text-muted-foreground">
              {debtor.loanReference ?? debtor.id} · {debtor.phone}
            </div>
          </div>
          <span className="flex items-center gap-1.5 text-sm text-blue-500 font-medium ml-2">
            <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" /> Ringing…
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onSwitchView}>
            {call.view === "panel" ? (
              <Maximize2 className="h-4 w-4" />
            ) : (
              <Minimize2 className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="sm"
            className="gap-1.5 h-8 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onEnd}
          >
            <PhoneOff className="h-3.5 w-3.5" />
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  /* ── Connected / Ended: full-screen two-panel layout ── */

  // Item 8 — productive outcomes are offered during the call; non-productive appear once it ends
  const PRODUCTIVE_OUTCOMES: CallOutcome[] = ["paid", "promised", "settlement", "callback"];
  const NON_PRODUCTIVE_OUTCOMES: CallOutcome[] = ["refused", "no_answer", "voicemail", "dispute"];

  const outcomeButtons = (list: CallOutcome[]) => (
    <div className="grid grid-cols-2 gap-2">
      {list.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => up({ outcome: o })}
          className={cn(
            "rounded-lg border px-3 py-2.5 text-sm font-semibold text-left transition-all",
            disposition.outcome === o
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
          )}
        >
          {OUTCOME_META[o].label}
        </button>
      ))}
    </div>
  );

  // Outcome-specific inputs, shared between the in-call and post-call disposition panels
  const outcomeFields = () => (
    <>
      {disposition.outcome === "promised" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground flex items-center gap-1">
              <IndianRupee className="h-3 w-3" />
              PTP Amount
            </label>
            <Input
              placeholder="e.g. 8200"
              value={disposition.ptpAmount}
              onChange={(e) => up({ ptpAmount: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground flex items-center gap-1">
              <CalendarClock className="h-3 w-3" />
              PTP Date
            </label>
            <Input
              type="date"
              value={disposition.ptpDate}
              onChange={(e) => up({ ptpDate: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
      )}
      {disposition.outcome === "callback" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Callback Date</label>
            <Input
              type="date"
              value={disposition.callbackDate}
              onChange={(e) => up({ callbackDate: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Callback Time</label>
            <Input
              type="time"
              value={disposition.callbackTime}
              onChange={(e) => up({ callbackTime: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
      )}
      {disposition.outcome === "paid" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Amount Paid</label>
            <Input
              placeholder="e.g. 8200"
              value={disposition.paidAmount}
              onChange={(e) => up({ paidAmount: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Reference (UTR)</label>
            <Input
              placeholder="UTR / Ref no."
              value={disposition.paidRef}
              onChange={(e) => up({ paidRef: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
      )}
      {disposition.outcome === "settlement" && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground flex items-center gap-1">
              <IndianRupee className="h-3 w-3" />
              Settlement Amt
            </label>
            <Input
              placeholder="e.g. 45000"
              value={disposition.settlementAmount}
              onChange={(e) => up({ settlementAmount: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Date</label>
            <Input
              type="date"
              value={disposition.settlementDate}
              onChange={(e) => up({ settlementDate: e.target.value })}
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Waiver %</label>
            <Input
              placeholder="e.g. 10"
              value={disposition.settlementWaiver}
              onChange={(e) => up({ settlementWaiver: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
      )}
      {(disposition.outcome === "refused" || disposition.outcome === "dispute") && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Reason
          </label>
          <Input
            placeholder="Brief reason…"
            value={disposition.disputeReason}
            onChange={(e) => up({ disputeReason: e.target.value })}
            className="h-9"
          />
        </div>
      )}
    </>
  );

  // Previous notes / prior contact history for the side scroll during a live call
  const priorHistory = debtor.contactHistory ?? [];

  return (
    <div className="flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-300">
      {/* ── TOP BAR ── */}
      <div className="flex items-center justify-between gap-4 px-6 py-3 border-b border-border bg-card flex-shrink-0">
        {/* Identity + status */}
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="h-11 w-11 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
              {debtor.name
                .split(" ")
                .map((n) => n[0])
                .slice(0, 2)
                .join("")}
            </div>
            {phase === "connected" && (
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-success border-2 border-card" />
            )}
          </div>
          <div>
            <div className="font-semibold text-foreground text-base leading-tight">
              {debtor.name}
            </div>
            <div className="text-xs text-muted-foreground">
              {debtor.loanReference ?? debtor.id} · {debtor.phone}
              {debtor.altPhone ? ` · Alt: ${debtor.altPhone}` : ""}
            </div>
          </div>
          <span
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs font-medium",
              bucketMeta.color,
            )}
          >
            {bucketMeta.label}
          </span>
          {debtor.legalNotice && (
            <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
              ⚠ Legal Notice
            </span>
          )}
          {debtor.disputeFlag && (
            <span className="rounded-full border border-orange-400/40 bg-orange-500/10 px-2.5 py-0.5 text-xs font-medium text-orange-500">
              Dispute
            </span>
          )}
          {(debtor as QueueDebtor).retained && (
            <span className="rounded-full border border-violet-400/40 bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-500">
              ★ Retained
            </span>
          )}
        </div>

        {/* Timer + call state badges */}
        <div className="flex items-center gap-3">
          {phase === "connected" ? (
            <span className="flex items-center gap-2 text-success font-semibold tabular-nums text-lg">
              <span className="h-2.5 w-2.5 rounded-full bg-success animate-pulse" />
              {fmtElapsed(elapsed)}
            </span>
          ) : (
            <span className="text-muted-foreground font-medium">Ended · {fmtElapsed(elapsed)}</span>
          )}
          {conferenced && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 text-xs text-blue-500">
              <GitMerge className="h-3 w-3" />
              3-way{mergedWith ? ` · ${mergedWith.split(" ")[0]}` : ""}
            </span>
          )}
          {whisper && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 border border-violet-500/30 px-2 py-0.5 text-xs text-violet-500">
              <EarOff className="h-3 w-3" />
              Whisper{whisperTarget ? ` · ${whisperTarget.split(" ")[0]}` : ""}
            </span>
          )}
          {held && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-400/30 px-2 py-0.5 text-xs text-amber-500">
              <PauseCircle className="h-3 w-3" />
              On Hold
            </span>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {phase === "connected" && (
            <>
              <Button
                size="sm"
                variant={muted ? "default" : "outline"}
                className={cn("gap-1 h-8", muted && "bg-destructive text-destructive-foreground")}
                onClick={onMute}
              >
                {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {muted ? "Unmute" : "Mute"}
              </Button>
              <Button
                size="sm"
                variant={held ? "default" : "outline"}
                className={cn("gap-1 h-8", held && "bg-amber-500/80 text-white")}
                onClick={onHold}
              >
                <PauseCircle className="h-3.5 w-3.5" />
                {held ? "Resume" : "Hold"}
              </Button>
              <div className="relative">
                <Button
                  size="sm"
                  variant={whisper ? "default" : "outline"}
                  className={cn("gap-1 h-8", whisper && "bg-violet-600 text-white")}
                  onClick={() => {
                    if (whisper) {
                      setWhisper(false);
                      setWhisperTarget(null);
                      toast("Whisper OFF");
                    } else {
                      setWhisperOpen((o) => !o);
                      setAddCallOpen(false);
                      setTransferOpen(false);
                      setManualDialOpen(false);
                    }
                  }}
                >
                  {whisper ? <EarOff className="h-3.5 w-3.5" /> : <Ear className="h-3.5 w-3.5" />}
                  {whisper ? `Whisper · ${whisperTarget?.split(" ")[0]}` : "Whisper"}
                </Button>
                {whisperOpen && !whisper && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setWhisperOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-card shadow-xl p-3 space-y-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Whisper with (customer won't hear)
                      </p>
                      <div className="space-y-0.5">
                        {SUPERVISORS.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => {
                              setWhisperTarget(name);
                              setWhisper(true);
                              setWhisperOpen(false);
                              toast.success(`Whisper ON with ${name}`);
                            }}
                            className="w-full text-left px-2 py-2 rounded text-sm text-foreground hover:bg-accent/60 transition-colors flex items-center gap-2"
                          >
                            <Ear className="h-3.5 w-3.5 text-violet-500 flex-shrink-0" />
                            <span>{name}</span>
                          </button>
                        ))}
                      </div>
                      <p className="text-[10px] text-muted-foreground border-t border-border pt-2">
                        You and the selected person can speak. The customer cannot hear this
                        conversation.
                      </p>
                    </div>
                  </>
                )}
              </div>
              <div className="relative">
                <Button
                  size="sm"
                  variant={conferenced ? "default" : "outline"}
                  className={cn("gap-1 h-8", conferenced && "bg-blue-600 text-white")}
                  onClick={() => {
                    if (conferenced) {
                      setConferenced(false);
                      setMergedWith(null);
                      setMergeOpen(false);
                      toast("Back to 1:1");
                    } else {
                      setMergeOpen((o) => !o);
                      setAddCallOpen(false);
                      setTransferOpen(false);
                      setManualDialOpen(false);
                      setWhisperOpen(false);
                    }
                  }}
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  {conferenced
                    ? `Merged${mergedWith ? ` · ${mergedWith.split(" ")[0]}` : ""}`
                    : "Merge"}
                </Button>
                {mergeOpen && !conferenced && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMergeOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-card shadow-xl p-3 space-y-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Merge with
                      </p>
                      {/* Manager — portal auto-connects to the live call */}
                      <button
                        type="button"
                        onClick={() => {
                          setConferenced(true);
                          setMergedWith("Preethi Menon (Manager)");
                          setMergeOpen(false);
                          toast.success("Manager portal auto-connected to the call", {
                            description: "Preethi Menon joined — 3-way live",
                          });
                        }}
                        className="w-full text-left px-2 py-2 rounded text-sm text-violet-600 hover:bg-accent/60 transition-colors flex items-center gap-2"
                      >
                        <UserRoundCog className="h-4 w-4 flex-shrink-0" />
                        <span className="flex-1">Manager</span>
                        <span className="text-[9px] opacity-60">auto-connect</span>
                      </button>
                      <div className="border-t border-border pt-1.5 space-y-0.5 max-h-40 overflow-y-auto">
                        <p className="text-[10px] text-muted-foreground px-2">Agents</p>
                        {AGENTS_LIST.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => {
                              setConferenced(true);
                              setMergedWith(name);
                              setMergeOpen(false);
                              toast.success(`${name} merged into the call`);
                            }}
                            className="w-full text-left px-2 py-1.5 rounded text-sm text-foreground hover:bg-accent/60 transition-colors flex items-center gap-2"
                          >
                            <GitMerge className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
                            <span>{name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Add Call */}
              <div className="relative">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1 h-8"
                  onClick={() => {
                    setAddCallOpen((o) => !o);
                    setTransferOpen(false);
                    setManualDialOpen(false);
                  }}
                >
                  <PhoneForwarded className="h-3.5 w-3.5" />
                  Add Call
                </Button>
                {addCallOpen && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-card shadow-xl p-3 space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Add participant
                    </p>
                    <div className="flex gap-1.5">
                      <Input
                        placeholder="+91 XXXXX XXXXX"
                        value={addCallNumber}
                        onChange={(e) => setAddCallNumber(e.target.value)}
                        className="h-7 text-xs flex-1"
                      />
                      <Button
                        size="sm"
                        className="h-7 px-2 text-xs gap-1"
                        onClick={() => {
                          if (!addCallNumber) return;
                          toast.success(`Calling ${addCallNumber}…`);
                          setConferenced(true);
                          setAddCallOpen(false);
                          setAddCallNumber("");
                        }}
                      >
                        <Phone className="h-3 w-3" />
                        Call
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Transfer */}
              <div className="relative">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1 h-8"
                  onClick={() => {
                    setTransferOpen((o) => !o);
                    setAddCallOpen(false);
                    setManualDialOpen(false);
                  }}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  Transfer
                </Button>
                {transferOpen && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-border bg-card shadow-xl p-3 space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Transfer to
                    </p>
                    <div className="space-y-0.5 max-h-48 overflow-y-auto">
                      {[...SUPERVISORS, ...AGENTS_LIST].map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => {
                            toast.success(`Transferring to ${name}…`);
                            setTransferOpen(false);
                            onEnd();
                          }}
                          className={cn(
                            "w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent/60 transition-colors flex items-center justify-between",
                            SUPERVISORS.includes(name) ? "text-violet-500" : "text-foreground",
                          )}
                        >
                          <span>{name}</span>
                          {SUPERVISORS.includes(name) && (
                            <span className="text-[9px] opacity-50">Supervisor</span>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-border pt-2 flex gap-1.5">
                      <Input
                        placeholder="Custom number…"
                        value={transferTarget}
                        onChange={(e) => setTransferTarget(e.target.value)}
                        className="h-7 text-xs flex-1"
                      />
                      <Button
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          if (!transferTarget) return;
                          toast.success(`Transferring to ${transferTarget}…`);
                          setTransferOpen(false);
                          onEnd();
                        }}
                      >
                        <ArrowRightLeft className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* Dialpad */}
              <div className="relative">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1 h-8"
                  onClick={() => {
                    setManualDialOpen((o) => !o);
                    setAddCallOpen(false);
                    setTransferOpen(false);
                  }}
                >
                  <Hash className="h-3.5 w-3.5" />
                  Dialpad
                </Button>
                {manualDialOpen && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-48 rounded-lg border border-border bg-card shadow-xl p-3 space-y-2">
                    <div className="h-7 rounded border border-border bg-muted/40 px-2 flex items-center font-mono text-sm">
                      {dialPadInput || (
                        <span className="text-muted-foreground text-xs">press keys…</span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            setDialPadInput((d) => d + k);
                            toast(`Sent: ${k}`, { duration: 700 });
                          }}
                          className="h-8 rounded border border-border bg-muted/30 text-sm font-medium hover:bg-accent/60 transition-colors active:scale-95"
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setDialPadInput("")}
                      className="w-full text-[10px] text-muted-foreground hover:text-foreground text-center"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          <Button
            size="sm"
            className="gap-1.5 h-8 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onEnd}
          >
            <PhoneOff className="h-3.5 w-3.5" />
            End Call
          </Button>
          {phase === "connected" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={onMinimize}
              title="Minimize — keep call running in the background"
            >
              <Minus className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* ── BODY: two columns ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── LEFT: notes + history (during call) / disposition (after end) ── */}
        <div className="w-[440px] flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
          {phase === "connected" && (
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* AI score insight */}
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                <div className="text-[10px] uppercase tracking-wider text-primary/70 mb-1 font-semibold">
                  AI Insight
                </div>
                <p className="text-sm text-foreground italic">"{debtor.scoreReason}"</p>
                <div className="flex items-center gap-2 mt-2">
                  <span
                    className={cn(
                      "text-xs font-bold",
                      debtor.aiScore >= 8
                        ? "text-success"
                        : debtor.aiScore >= 5
                          ? "text-amber-500"
                          : "text-destructive",
                    )}
                  >
                    Score {debtor.aiScore}/10
                  </span>
                  <span className="text-xs text-muted-foreground">·</span>
                  <span className="text-xs text-muted-foreground">
                    DPD {debtor.dpd}d · {bucketMeta.description}
                  </span>
                </div>
              </div>
              {/* Quick actions */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => toast.success("Payment link sent")}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
                >
                  <Send className="h-3.5 w-3.5" />
                  Send Pay Link
                </button>
                <button
                  type="button"
                  onClick={() => toast.success("Statement sent")}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Statement
                </button>
                <button
                  type="button"
                  onClick={() => toast.success("Flagged")}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-xs text-muted-foreground hover:border-orange-400/60 hover:text-orange-500 transition-colors"
                >
                  <Flag className="h-3.5 w-3.5" />
                  Flag
                </button>
              </div>

              {/* Live call note */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  Live call note
                </label>
                <Textarea
                  placeholder="Type notes while on the call…"
                  value={disposition.notes}
                  onChange={(e) => up({ notes: e.target.value })}
                  className="min-h-[90px] resize-none"
                />
                <p className="text-[10px] text-muted-foreground">
                  Saved automatically with the disposition when the call ends.
                </p>
              </div>

              {/* Productive disposition — available during the call */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-foreground">Log outcome</p>
                {outcomeButtons(PRODUCTIVE_OUTCOMES)}
                {outcomeFields()}
              </div>

              {/* Previous notes & call history — scrollable */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-foreground">
                  Previous notes &amp; call history
                </p>
                <div className="rounded-lg border border-border divide-y divide-border max-h-56 overflow-y-auto">
                  {priorHistory.length ? (
                    priorHistory.map((c, i) => (
                      <div key={i} className="flex items-start gap-2 px-3 py-2">
                        <span
                          className={cn(
                            "mt-0.5 flex h-6 w-6 items-center justify-center rounded-full flex-shrink-0",
                            c.channel === "call"
                              ? "bg-primary/15 text-primary"
                              : c.channel === "whatsapp"
                                ? "bg-success/15 text-success"
                                : c.channel === "sms"
                                  ? "bg-blue-500/15 text-blue-500"
                                  : "bg-muted/50 text-muted-foreground",
                          )}
                        >
                          {c.channel === "call" ? (
                            <Phone className="h-3 w-3" />
                          ) : c.channel === "whatsapp" ? (
                            <MessageCircle className="h-3 w-3" />
                          ) : c.channel === "sms" ? (
                            <Send className="h-3 w-3" />
                          ) : (
                            <FileText className="h-3 w-3" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-foreground leading-snug">{c.outcome}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {c.date} · {c.time} · {c.agent}
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      No previous contact history
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {phase === "ended" && (
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <p className="text-sm font-semibold text-foreground">Disposition</p>
              {outcomeButtons([...PRODUCTIVE_OUTCOMES, ...NON_PRODUCTIVE_OUTCOMES])}
              {outcomeFields()}
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Notes</label>
                <Textarea
                  placeholder="Call notes…"
                  value={disposition.notes}
                  onChange={(e) => up({ notes: e.target.value })}
                  className="min-h-[80px] resize-none"
                />
              </div>
              <div className="flex items-center justify-between gap-3 pt-1 border-t border-border">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={disposition.escalate}
                    onChange={(e) => up({ escalate: e.target.checked })}
                    className="rounded"
                  />
                  <span className="text-sm text-destructive font-medium">Escalate to manager</span>
                </label>
                <Button className="gap-1.5 px-6" onClick={onSubmit} disabled={!disposition.outcome}>
                  Save &amp; Close
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: full debtor info ── */}
        <div className="flex-1 flex flex-col overflow-hidden bg-muted/10">
          {/* Tab bar */}
          <div className="flex border-b border-border bg-card px-6 gap-1 flex-shrink-0">
            {(
              [
                { key: "loan", label: "Loan Details" },
                { key: "personal", label: "Personal" },
                { key: "payments", label: "Payment History" },
                { key: "contacts", label: "Contact History" },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setInfoTab(t.key)}
                className={cn(
                  "py-3 px-4 text-sm font-medium border-b-2 transition-colors -mb-px",
                  infoTab === t.key
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {/* ── LOAN DETAILS ── */}
            {infoTab === "loan" && (
              <div className="space-y-6">
                {/* Outstanding summary row */}
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {[
                    {
                      label: "Total Outstanding",
                      value: formatINR(debtor.loanAmount),
                      cls: "text-foreground text-xl font-bold",
                    },
                    {
                      label: "Principal Outstanding",
                      value: formatINR(debtor.principalOutstanding ?? debtor.loanAmount),
                      cls: "text-foreground font-semibold",
                    },
                    {
                      label: "Interest Outstanding",
                      value: formatINR(debtor.interestOutstanding ?? 0),
                      cls: "text-amber-500 font-semibold",
                    },
                    {
                      label: "Penalty Charges",
                      value: formatINR(debtor.penaltyCharges ?? 0),
                      cls: "text-destructive font-semibold",
                    },
                  ].map(({ label, value, cls }) => (
                    <div key={label} className="rounded-xl border border-border bg-card p-4">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                        {label}
                      </div>
                      <div className={cn("text-lg", cls)}>{value}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                  {/* Loan info */}
                  <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Loan Information
                    </div>
                    {[
                      ["Loan ID", debtor.loanReference ?? debtor.id],
                      ["Loan Type", debtor.loanType ?? "—"],
                      ["Lender", debtor.lender ?? "—"],
                      ["Portfolio", debtor.portfolio],
                      ["Disbursed On", debtor.disbursedOn ?? "—"],
                      ["Tenure", debtor.tenure ? `${debtor.tenure} months` : "—"],
                      ["Interest Rate", debtor.interestRate ? `${debtor.interestRate}% p.a.` : "—"],
                      ["EMI Amount", debtor.emiAmount ? formatINR(debtor.emiAmount) : "—"],
                      [
                        "EMI Due Date",
                        debtor.emiDueDate ? `${debtor.emiDueDate}th of every month` : "—",
                      ],
                    ].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="text-foreground font-medium">{v}</span>
                      </div>
                    ))}
                  </div>

                  {/* Overdue + bank */}
                  <div className="space-y-4">
                    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Overdue Summary
                      </div>
                      {[
                        ["DPD", `${debtor.dpd} days`],
                        ["Bucket", bucketMeta.label + " — " + bucketMeta.description],
                        ["Total Overdue", formatINR(debtor.totalOverdue ?? 0)],
                        ["Total Paid", formatINR(debtor.totalPaid ?? 0)],
                        [
                          "PDC Bounced",
                          debtor.pdcBounced !== undefined ? `${debtor.pdcBounced} times` : "—",
                        ],
                        [
                          "Settlement",
                          debtor.settlementOffer
                            ? formatINR(debtor.settlementOffer)
                            : "None offered",
                        ],
                      ].map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="text-foreground font-medium">{v}</span>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Bank Account
                      </div>
                      {[
                        ["Bank", debtor.bankName ?? "—"],
                        ["Account Type", debtor.accountType ?? "—"],
                        ["IFSC", debtor.ifscCode ?? "—"],
                      ].map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="font-mono text-foreground font-medium">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Co-applicant / guarantor */}
                {(debtor.coApplicantName || debtor.guarantorName) && (
                  <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Co-Applicant / Guarantor
                    </div>
                    {debtor.coApplicantName && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Co-Applicant</span>
                        <span className="text-foreground font-medium">
                          {debtor.coApplicantName}
                          {debtor.coApplicantPhone ? ` · ${debtor.coApplicantPhone}` : ""}
                        </span>
                      </div>
                    )}
                    {debtor.guarantorName && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Guarantor</span>
                        <span className="text-foreground font-medium">{debtor.guarantorName}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── PERSONAL ── */}
            {infoTab === "personal" && (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Personal Details
                  </div>
                  {[
                    ["Full Name", debtor.name],
                    ["Gender", debtor.gender ?? "—"],
                    ["DOB", debtor.dob ?? "—"],
                    ["Age", debtor.age ? `${debtor.age} years` : "—"],
                    ["Language", debtor.language],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="text-foreground font-medium">{v}</span>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Contact Details
                  </div>
                  {[
                    ["Phone", debtor.phone],
                    ["Alt Phone", debtor.altPhone ?? "—"],
                    ["Email", debtor.email ?? "—"],
                    ["Last Contacted", debtor.lastContacted ?? "Never"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="font-mono text-foreground font-medium text-right">{v}</span>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Address
                  </div>
                  <p className="text-sm text-foreground">{debtor.address ?? "—"}</p>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">City / State</span>
                    <span className="text-foreground">
                      {[debtor.city, debtor.state].filter(Boolean).join(", ") || "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Pincode</span>
                    <span className="text-foreground font-mono">{debtor.pincode ?? "—"}</span>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Employment
                  </div>
                  {[
                    ["Employer", debtor.employer ?? "—"],
                    ["Type", debtor.employerType ?? "—"],
                    [
                      "Monthly Income",
                      debtor.monthlyIncome ? formatINR(debtor.monthlyIncome) : "—",
                    ],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="text-foreground font-medium">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── PAYMENT HISTORY ── */}
            {infoTab === "payments" && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <div className="rounded-xl border border-border bg-card p-4">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      EMI Amount
                    </div>
                    <div className="text-lg font-bold text-foreground">
                      {debtor.emiAmount ? formatINR(debtor.emiAmount) : "—"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-4">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      Total Paid
                    </div>
                    <div className="text-lg font-bold text-success">
                      {formatINR(debtor.totalPaid ?? 0)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-4">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                      PDC Bounced
                    </div>
                    <div
                      className={cn(
                        "text-lg font-bold",
                        (debtor.pdcBounced ?? 0) > 0 ? "text-destructive" : "text-success",
                      )}
                    >
                      {debtor.pdcBounced ?? 0} times
                    </div>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="py-2.5 pl-4 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                          Date
                        </th>
                        <th className="py-2.5 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                          Amount
                        </th>
                        <th className="py-2.5 text-center text-[10px] uppercase tracking-wider text-muted-foreground">
                          Method
                        </th>
                        <th className="py-2.5 text-center text-[10px] uppercase tracking-wider text-muted-foreground">
                          Status
                        </th>
                        <th className="py-2.5 pr-4 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                          Ref
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {(debtor.paymentHistory ?? []).map((p, i) => (
                        <tr key={i} className="hover:bg-muted/20">
                          <td className="py-2.5 pl-4 text-foreground">{p.date}</td>
                          <td className="py-2.5 text-right font-medium text-foreground">
                            {formatINR(p.amount)}
                          </td>
                          <td className="py-2.5 text-center">
                            <span className="rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                              {p.method}
                            </span>
                          </td>
                          <td className="py-2.5 text-center">
                            <span
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                p.status === "paid"
                                  ? "bg-success/10 text-success border-success/30"
                                  : p.status === "bounced"
                                    ? "bg-destructive/10 text-destructive border-destructive/30"
                                    : "bg-muted/50 text-muted-foreground border-border",
                              )}
                            >
                              {p.status.charAt(0).toUpperCase() + p.status.slice(1)}
                            </span>
                          </td>
                          <td className="py-2.5 pr-4 text-right font-mono text-[11px] text-muted-foreground">
                            {p.ref ?? "—"}
                          </td>
                        </tr>
                      ))}
                      {!debtor.paymentHistory?.length && (
                        <tr>
                          <td
                            colSpan={5}
                            className="py-8 text-center text-muted-foreground text-sm"
                          >
                            No payment history
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── CONTACT HISTORY ── */}
            {infoTab === "contacts" && (
              <div className="space-y-3">
                {(debtor.contactHistory ?? []).map((c, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-border bg-card p-4 flex items-start gap-4"
                  >
                    <div
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full flex-shrink-0 text-[11px] font-semibold",
                        c.channel === "call"
                          ? "bg-primary/15 text-primary"
                          : c.channel === "whatsapp"
                            ? "bg-success/15 text-success"
                            : c.channel === "sms"
                              ? "bg-blue-500/15 text-blue-500"
                              : "bg-muted/50 text-muted-foreground",
                      )}
                    >
                      {c.channel === "call" ? (
                        <Phone className="h-3.5 w-3.5" />
                      ) : c.channel === "whatsapp" ? (
                        <MessageCircle className="h-3.5 w-3.5" />
                      ) : c.channel === "sms" ? (
                        <Send className="h-3.5 w-3.5" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground capitalize">
                          {c.channel === "call"
                            ? "Phone Call"
                            : c.channel === "whatsapp"
                              ? "WhatsApp"
                              : c.channel.toUpperCase()}
                        </span>
                        <span className="text-[11px] text-muted-foreground flex-shrink-0">
                          {c.date} · {c.time}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-0.5">{c.outcome}</p>
                      <span className="text-[10px] text-muted-foreground">by {c.agent}</span>
                    </div>
                  </div>
                ))}
                {!debtor.contactHistory?.length && (
                  <div className="py-12 text-center text-muted-foreground text-sm">
                    No contact history
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
export function ActiveCallPanel(props: CallControlProps) {
  const expanded = props.call.phase === "connected" || props.call.phase === "ended";

  if (expanded) {
    // Floating panel — padded off the screen edges rather than a full-bleed overlay
    return (
      <div className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm animate-in fade-in duration-200 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full h-full max-w-6xl rounded-2xl border border-border bg-background shadow-2xl overflow-hidden flex flex-col">
          <ActiveCallContent {...props} />
        </div>
      </div>
    );
  }

  // Ringing: slim bottom bar
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card shadow-2xl shadow-black/30 animate-in slide-in-from-bottom-4 duration-300">
      <div className="mx-auto max-w-4xl px-4 py-3">
        <ActiveCallContent {...props} />
      </div>
    </div>
  );
}

export function ActiveCallModal(props: CallControlProps) {
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="max-w-2xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PhoneCall className="h-4 w-4 text-primary" />
            Active Call
          </DialogTitle>
        </DialogHeader>
        <ActiveCallContent {...props} />
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground whitespace-nowrap">
        {children}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

// ─── PTP Follow-up Tracker ───────────────────────────────────────────────────

const PTP_FOLLOWUPS = [
  {
    id: "P-001",
    debtorName: "Rahul Sharma",
    loanId: "L-10042",
    phone: "+91 98XXX XX789",
    ptpAmount: 8200,
    ptpDate: "Today",
    daysLeft: 0,
    prevAttempts: 2,
    notes: "Confirmed UPI transfer by EOD",
  },
  {
    id: "P-002",
    debtorName: "Ananya Bose",
    loanId: "L-10455",
    phone: "+91 91XXX XX334",
    ptpAmount: 15000,
    ptpDate: "Tomorrow",
    daysLeft: 1,
    prevAttempts: 1,
    notes: "Salary credited 24th — will pay immediately",
  },
  {
    id: "P-003",
    debtorName: "Divya Krishnan",
    loanId: "L-10333",
    phone: "+91 97XXX XX115",
    ptpAmount: 27500,
    ptpDate: "Tomorrow",
    daysLeft: 1,
    prevAttempts: 3,
    notes: "Has cash — transferring tonight or tomorrow",
  },
  {
    id: "P-004",
    debtorName: "Bhavna Shah",
    loanId: "L-09512",
    phone: "+91 99XXX XX308",
    ptpAmount: 9000,
    ptpDate: "23 Jun",
    daysLeft: 1,
    prevAttempts: 1,
    notes: "Retained — kept PTP last month",
  },
  {
    id: "P-005",
    debtorName: "Imran Sheikh",
    loanId: "L-10478",
    phone: "+91 91XXX XX642",
    ptpAmount: 11000,
    ptpDate: "Friday",
    daysLeft: 2,
    prevAttempts: 1,
    notes: "Reliable track record",
  },
  {
    id: "P-006",
    debtorName: "Firoz Khan",
    loanId: "L-10388",
    phone: "+91 91XXX XX220",
    ptpAmount: 12000,
    ptpDate: "25 Jun",
    daysLeft: 3,
    prevAttempts: 0,
    notes: "AI captured — IVR keypress 1",
  },
  {
    id: "P-007",
    debtorName: "Karthik Nair",
    loanId: "L-10122",
    phone: "+91 99XXX XX901",
    ptpAmount: 52000,
    ptpDate: "24 Jun",
    daysLeft: 2,
    prevAttempts: 0,
    notes: "AI captured — bot script confirmed",
  },
  {
    id: "P-008",
    debtorName: "Manish Gupta",
    loanId: "L-10145",
    phone: "+91 97XXX XX461",
    ptpAmount: 9500,
    ptpDate: "25 Jun",
    daysLeft: 3,
    prevAttempts: 2,
    notes: "Extension approved, new date set",
  },
  {
    id: "P-009",
    debtorName: "Naresh Kumar",
    loanId: "L-09488",
    phone: "+91 90XXX XX155",
    ptpAmount: 18000,
    ptpDate: "27 Jun",
    daysLeft: 5,
    prevAttempts: 4,
    notes: "Retained — phone inactive, try WhatsApp",
  },
];

function PTPTracker({
  onCall,
  onView,
  queue,
  bucketFilter,
  search,
}: {
  onCall: (d: QueueDebtor) => void;
  onView: (d: QueueDebtor) => void;
  queue: QueueDebtor[];
  bucketFilter: DPDBucket | "all";
  search: string;
}) {
  const [filter, setFilter] = useState<"all" | "today" | "tomorrow" | "later">("all");

  // Find the matching QueueDebtor for each PTP follow-up to apply bucket/search filters
  const rows = PTP_FOLLOWUPS.filter((p) => {
    const dateOk =
      filter === "all"
        ? true
        : filter === "today"
          ? p.daysLeft === 0
          : filter === "tomorrow"
            ? p.daysLeft === 1
            : p.daysLeft >= 2;
    if (!dateOk) return false;
    // Apply search
    const q = search.trim().toLowerCase();
    if (
      q &&
      !p.debtorName.toLowerCase().includes(q) &&
      !p.loanId.toLowerCase().includes(q) &&
      !p.phone.includes(q)
    )
      return false;
    // Apply bucket filter via the matching queue debtor's dpd
    if (bucketFilter !== "all") {
      const qd = queue.find((d) => d.id === p.loanId);
      if (qd && bucketOf(qd.dpd) !== bucketFilter) return false;
    }
    return true;
  });

  const todayCount = PTP_FOLLOWUPS.filter((p) => p.daysLeft === 0).length;
  const tomorrowCount = PTP_FOLLOWUPS.filter((p) => p.daysLeft === 1).length;
  const laterCount = PTP_FOLLOWUPS.filter((p) => p.daysLeft >= 2).length;
  const totalAmount = PTP_FOLLOWUPS.reduce((s, p) => s + p.ptpAmount, 0);

  return (
    <section>
      <SectionLabel>PTP Follow-up Tracker</SectionLabel>

      <div className="mt-3 space-y-3">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Due Today", value: todayCount, cls: "text-destructive" },
            { label: "Due Tomorrow", value: tomorrowCount, cls: "text-warning-foreground" },
            { label: "Later", value: laterCount, cls: "text-muted-foreground" },
            { label: "Total PTP", value: formatINR(totalAmount), cls: "text-blue-600 text-lg" },
          ].map((s, i) => (
            <Card
              key={s.label}
              className="animate-in fade-in duration-400"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <CardContent className="p-4">
                <div className={cn("text-2xl font-bold", s.cls)}>{s.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filter pills */}
        <div className="flex gap-2 flex-wrap items-center">
          {(
            [
              { key: "all", label: "All", count: PTP_FOLLOWUPS.length },
              { key: "today", label: "Due Today", count: todayCount },
              { key: "tomorrow", label: "Tomorrow", count: tomorrowCount },
              { key: "later", label: "Later", count: laterCount },
            ] as const
          ).map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all duration-150",
                filter === f.key
                  ? "bg-foreground text-background border-foreground"
                  : "bg-muted/50 border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              {f.label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-bold",
                  filter === f.key ? "bg-white/20" : "bg-muted text-muted-foreground",
                )}
              >
                {f.count}
              </span>
            </button>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs ml-auto"
            onClick={() =>
              exportCSV(
                "ptp-tracker.csv",
                [
                  "Debtor",
                  "Loan ID",
                  "Phone",
                  "PTP Amount",
                  "PTP Date",
                  "Days Left",
                  "Attempts",
                  "Notes",
                ],
                PTP_FOLLOWUPS.filter(
                  (p) =>
                    filter === "all" ||
                    p.ptpDate ===
                      (filter === "today"
                        ? "Today"
                        : filter === "tomorrow"
                          ? "Tomorrow"
                          : p.ptpDate),
                ).map((p) => [
                  p.debtorName,
                  p.loanId,
                  p.phone,
                  p.ptpAmount,
                  p.ptpDate,
                  p.daysLeft,
                  p.prevAttempts,
                  p.notes,
                ]),
              )
            }
          >
            <FileDown className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[360px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead>Debtor</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="text-right">PTP Amount</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead className="min-w-[180px]">Notes</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center py-10 text-sm text-muted-foreground"
                      >
                        No PTPs for this filter.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((p) => {
                    const urgency =
                      p.daysLeft === 0
                        ? "text-destructive"
                        : p.daysLeft === 1
                          ? "text-warning-foreground"
                          : "text-muted-foreground";
                    return (
                      <TableRow key={p.id} className="hover:bg-primary/5">
                        <TableCell>
                          <div className="font-medium text-sm">{p.debtorName}</div>
                          <div className="text-[11px] text-muted-foreground">{p.loanId}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {p.phone}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-blue-600 text-sm">
                          {formatINR(p.ptpAmount)}
                        </TableCell>
                        <TableCell>
                          <span className={cn("text-xs font-semibold", urgency)}>
                            {p.ptpDate}
                            {p.daysLeft === 0 && (
                              <span className="ml-1 text-[10px] bg-destructive/15 text-destructive px-1 rounded">
                                Overdue risk
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "text-xs font-medium",
                              p.prevAttempts >= 3 ? "text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {p.prevAttempts} prior
                          </span>
                        </TableCell>
                        <TableCell>
                          <p className="text-xs text-foreground/80 leading-relaxed">{p.notes}</p>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              className="h-7 px-2 text-xs gap-1 active:scale-95"
                              onClick={() => {
                                // Fall back to a debtor built from this row when it isn't in the
                                // live queue, so Call always opens a working call — never a toast.
                                const d: QueueDebtor = queue.find((q) => q.id === p.loanId) ?? {
                                  id: p.loanId,
                                  name: p.debtorName,
                                  phone: p.phone,
                                  loanAmount: p.ptpAmount,
                                  dpd: 0,
                                  aiScore: 7,
                                  scoreReason: p.notes,
                                  lastContacted: null,
                                  portfolio: "PTP Follow-up",
                                  language: "English",
                                  queueStatus: "ptp",
                                  scheduledAt: p.ptpDate,
                                  ptpAmount: p.ptpAmount,
                                  loanReference: p.loanId,
                                };
                                onCall(d);
                              }}
                            >
                              <Phone className="h-3 w-3" />
                              Call
                            </Button>
                          </div>
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
    </section>
  );
}

// ─── Debtor Profile Sheet ─────────────────────────────────────────────────────

const DEBTOR_EXTRA: Record<
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
    callHistory: {
      date: string;
      duration: string;
      outcome: string;
      note: string;
      type: "agent" | "ai";
    }[];
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
    callHistory: [
      {
        date: "22 Jun, 10:14 AM",
        duration: "4m 22s",
        outcome: "PTP",
        note: "Will pay by 25th June via UPI",
        type: "agent",
      },
      {
        date: "20 Jun, 11:45 AM",
        duration: "2m 05s",
        outcome: "Callback",
        note: "Asked to call back after 6 PM",
        type: "agent",
      },
      {
        date: "18 Jun, 03:30 PM",
        duration: "0m 45s",
        outcome: "No answer",
        note: "",
        type: "agent",
      },
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
    callHistory: [
      {
        date: "22 Jun, 09:00 AM",
        duration: "6m 10s",
        outcome: "PTP",
        note: "Salary credited, will settle this week",
        type: "agent",
      },
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

function getDebtorExtra(id: string) {
  return (
    DEBTOR_EXTRA[id] ?? {
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
      callHistory: [],
      payments: [],
      disputes: [],
      messages: [],
    }
  );
}

function DebtorProfileSheet({
  debtor,
  onClose,
  onCall,
}: {
  debtor: QueueDebtor;
  onClose: () => void;
  onCall: (d: QueueDebtor) => void;
}) {
  const extra = getDebtorExtra(debtor.id);
  const b = bucketOf(debtor.dpd);
  const dpdCls =
    b === "X" || b === "1"
      ? "bg-success/8 text-success/70 border-success/15"
      : b === "2"
        ? "bg-warning/8 text-warning-foreground/70 border-warning/15"
        : "bg-destructive/8 text-destructive/70 border-destructive/15";
  const initials = debtor.name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <SheetHeader className="px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
              {initials}
            </div>
            <div>
              <SheetTitle className="text-base">{debtor.name}</SheetTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {debtor.loanReference ?? debtor.id} · {debtor.phone} · {debtor.language}
              </p>
            </div>
          </div>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </SheetHeader>

      {/* Key stats band — Excel-sourced fields */}
      <div className="flex-shrink-0 px-6 py-3 bg-muted/30 border-b border-border grid grid-cols-4 gap-4 text-sm">
        {[
          {
            label: "Outstanding",
            value: formatINR(debtor.loanAmount),
            cls: "font-bold text-foreground",
          },
          {
            label: "DPD",
            value: `${debtor.dpd}d`,
            cls: cn(
              "font-bold",
              debtor.dpd > 60
                ? "text-destructive"
                : debtor.dpd > 30
                  ? "text-warning-foreground"
                  : "text-success",
            ),
          },
          {
            label: "AI Score",
            value: `${debtor.aiScore}/10`,
            cls: cn(
              "font-bold",
              debtor.aiScore >= 8
                ? "text-success"
                : debtor.aiScore >= 5
                  ? "text-warning-foreground"
                  : "text-destructive",
            ),
          },
          { label: "Principal Amount", value: extra.pos || "—", cls: "text-foreground truncate" },
        ].map(({ label, value, cls }) => (
          <div key={label}>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
            <div className={cn("text-sm mt-0.5", cls)}>{value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="h-full flex flex-col">
          <TabsList className="flex-shrink-0 rounded-none border-b border-border bg-transparent px-6 h-10 justify-start gap-1 w-full">
            {["overview", "calls", "messages", "payments", "disputes"].map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="capitalize text-xs data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none pb-2"
              >
                {t}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Overview tab — loan details from Excel + other details */}
          <TabsContent value="overview" className="flex-1 overflow-y-auto px-6 py-4 space-y-5 mt-0">
            {/* Primary loan data (Excel-sourced) */}
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
                Loan Details (from uploaded file)
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {[
                  ["Lender", extra.lender],
                  ["Product", extra.product],
                  ["Account No.", extra.accountNumber],
                  ["Disbursed On", extra.disbursedOn],
                  ["Original Amount", formatINR(extra.originalAmount)],
                  ["EMI", formatINR(extra.emi)],
                  ["Tenure", `${extra.tenure} months`],
                  ["Principal Amount", extra.pos],
                  ["Portfolio", debtor.portfolio],
                  [
                    "Status",
                    <Badge
                      key="s"
                      variant="outline"
                      className={cn("text-xs", QUEUE_STATUS_META[debtor.queueStatus].cls)}
                    >
                      {QUEUE_STATUS_META[debtor.queueStatus].label}
                    </Badge>,
                  ],
                ].map(([label, val]) => (
                  <div key={String(label)}>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="font-medium text-foreground mt-0.5">{val}</div>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* EMI schedule */}
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
                EMI Schedule
              </p>
              {extra.emiSchedule.length === 0 ? (
                <p className="text-sm text-muted-foreground">No EMI data available.</p>
              ) : (
                <div className="space-y-1.5">
                  {extra.emiSchedule.map((e, i) => {
                    const sCls =
                      e.status === "paid"
                        ? "text-success"
                        : e.status === "missed"
                          ? "text-destructive"
                          : "text-muted-foreground";
                    const sBg =
                      e.status === "paid"
                        ? "bg-success/10"
                        : e.status === "missed"
                          ? "bg-destructive/10"
                          : "bg-muted/40";
                    return (
                      <div
                        key={i}
                        className={cn(
                          "flex items-center justify-between rounded-lg px-3 py-2 text-sm",
                          sBg,
                        )}
                      >
                        <span className="text-foreground">{e.month}</span>
                        <span className="font-medium">{formatINR(e.amount)}</span>
                        <span className={cn("text-xs font-semibold capitalize", sCls)}>
                          {e.status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator />

            {/* Other details */}
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
                Other Details
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                {[
                  ["Last Contacted", debtor.lastContacted ?? "—"],
                  ["Language", debtor.language],
                  ["AI Insight", debtor.scoreReason],
                  debtor.retained ? ["Retained From", debtor.retainedFrom ?? "—"] : null,
                ]
                  .filter(Boolean)
                  .map((item) => {
                    const [label, val] = item as [string, string];
                    return (
                      <div key={label} className={label === "AI Insight" ? "col-span-2" : ""}>
                        <div className="text-xs text-muted-foreground">{label}</div>
                        <div className="font-medium text-foreground mt-0.5">{val}</div>
                      </div>
                    );
                  })}
              </div>
            </div>
          </TabsContent>

          {/* Call history tab */}
          <TabsContent value="calls" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            {extra.callHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No call history recorded.</p>
            ) : (
              <div className="space-y-0">
                {extra.callHistory.map((c, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div
                        className={cn(
                          "h-2.5 w-2.5 rounded-full mt-1",
                          c.type === "ai" ? "bg-violet-500" : "bg-primary",
                        )}
                      />
                      {i < extra.callHistory.length - 1 && (
                        <div className="w-px flex-1 bg-border mt-1" />
                      )}
                    </div>
                    <div className="pb-4">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-foreground">{c.outcome}</span>
                        <span className="text-muted-foreground">·</span>
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground text-xs">{c.duration}</span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px]",
                            c.type === "ai"
                              ? "bg-violet-500/8 text-violet-500/70 border-violet-400/15"
                              : "bg-muted text-muted-foreground border-border",
                          )}
                        >
                          {c.type === "ai" ? "AI" : "Agent"}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">{c.date}</div>
                      {c.note && (
                        <div className="mt-1 text-xs bg-accent rounded px-2 py-1">{c.note}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Messages tab */}
          <TabsContent value="messages" className="flex-1 overflow-y-auto px-6 py-4 space-y-2 mt-0">
            {extra.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages sent.</p>
            ) : (
              extra.messages.map((m, i) => (
                <div
                  key={i}
                  className={cn("flex", m.dir === "out" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[75%] rounded-2xl px-3 py-2 text-sm",
                      m.dir === "out"
                        ? "bg-primary text-primary-foreground rounded-br-sm"
                        : "bg-card border border-border text-foreground rounded-bl-sm",
                    )}
                  >
                    <p>{m.text}</p>
                    <div
                      className={cn(
                        "flex items-center gap-1 mt-1 text-[10px]",
                        m.dir === "out"
                          ? "justify-end text-primary-foreground/70"
                          : "text-muted-foreground",
                      )}
                    >
                      {m.time}
                      <span className="capitalize">{m.channel}</span>
                      {m.dir === "out" && <CheckCheck className="h-3 w-3" />}
                    </div>
                  </div>
                </div>
              ))
            )}
          </TabsContent>

          {/* Payments tab */}
          <TabsContent value="payments" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            {extra.payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments recorded.</p>
            ) : (
              <div className="space-y-2">
                {extra.payments.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
                  >
                    <div>
                      <div className="font-semibold text-foreground">{formatINR(p.amount)}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.date} · {p.ref}
                      </div>
                    </div>
                    <Badge variant="secondary">{p.method}</Badge>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Disputes tab */}
          <TabsContent value="disputes" className="flex-1 overflow-y-auto px-6 py-4 space-y-3 mt-0">
            {extra.disputes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No disputes raised.</p>
            ) : (
              extra.disputes.map((disp) => (
                <div key={disp.id} className="rounded-lg border border-border p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{disp.type}</span>
                    <Badge
                      variant={
                        disp.status === "resolved"
                          ? "secondary"
                          : disp.status === "escalated"
                            ? "destructive"
                            : "outline"
                      }
                      className="capitalize"
                    >
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
        <Button size="sm" className="gap-1.5 h-8 active:scale-95" onClick={() => onCall(debtor)}>
          <Phone className="h-3.5 w-3.5" />
          Call Now
        </Button>
        <Button
          size="sm"
          className="gap-1.5 h-8 bg-success text-success-foreground hover:bg-success/90 active:scale-95"
          onClick={() => toast.success("WhatsApp opened for " + debtor.name)}
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
      </div>
    </div>
  );
}

// ─── Script Panel ────────────────────────────────────────────────────────────

function ScriptPanel({ debtor }: { debtor: QueueDebtor }) {
  const [open, setOpen] = useState(true);
  const [activeScript, setActiveScript] = useState<"opener" | "ptp" | "refused">("opener");
  const script = getScript(debtor.language);
  const ptpHint = debtor.ptpAmount ? `₹${debtor.ptpAmount.toLocaleString("en-IN")}` : "₹[amount]";
  const filled = (s: string) =>
    s
      .replace("[Name]", debtor.name.split(" ")[0])
      .replace("[amount]", debtor.loanAmount.toLocaleString("en-IN"))
      .replace(/₹\[amount\]/g, ptpHint);

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-primary"
      >
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Script · {debtor.language}
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {/* Script type tabs */}
          <div className="flex gap-1">
            {(["opener", "ptp", "refused"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setActiveScript(t)}
                className={cn(
                  "rounded px-2.5 py-1 text-[11px] font-semibold capitalize transition-all",
                  activeScript === t
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {t === "opener" ? "Opening" : t === "ptp" ? "Get PTP" : "Handles Refusal"}
              </button>
            ))}
          </div>

          {/* Script text */}
          <div className="rounded-md bg-card border border-border px-3 py-2 text-sm text-foreground leading-relaxed font-medium italic">
            "{filled(script[activeScript])}"
          </div>

          {/* Tips */}
          <div className="space-y-1">
            {script.tips.map((tip, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <span className="text-primary mt-0.5">›</span>
                <span>{tip}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Recording Player ─────────────────────────────────────────────────────────

function RecordingPlayer({
  id,
  duration,
  isPlaying,
  onToggle,
}: {
  id: string;
  duration: number;
  isPlaying: boolean;
  onToggle: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isPlaying) {
      setProgress(0);
      intervalRef.current = setInterval(() => {
        setProgress((p) => {
          if (p >= 100) {
            clearInterval(intervalRef.current!);
            onToggle();
            return 0;
          }
          return p + 100 / duration;
        });
      }, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setProgress(0);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // Keyed on isPlaying only: `duration` is fixed per clip and `onToggle` is invoked once at
    // completion via closure. Adding onToggle would restart playback on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  const elapsed = Math.round((progress / 100) * duration);

  return (
    <div className="flex items-center gap-1.5 min-w-[120px]">
      <button
        type="button"
        onClick={onToggle}
        className="flex-shrink-0 text-primary hover:text-primary/80 transition-colors"
        title={isPlaying ? "Stop" : "Play recording"}
      >
        {isPlaying ? (
          <StopCircle className="h-4 w-4 text-destructive" />
        ) : (
          <PlayCircle className="h-4 w-4" />
        )}
      </button>
      {isPlaying ? (
        <div className="flex-1 space-y-0.5">
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-1000 rounded-full"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-[10px] text-muted-foreground tabular-nums">
            {fmtElapsed(elapsed)} / {fmtElapsed(duration)}
          </div>
        </div>
      ) : (
        <span className="text-[10px] text-muted-foreground">{fmtElapsed(duration)}</span>
      )}
    </div>
  );
}

// ─── Escalation Modal ─────────────────────────────────────────────────────────

const ESCALATION_REASONS = [
  "Debtor requested manager",
  "Dispute — wrong amount",
  "Dispute — already paid",
  "Legal notice / Section notice",
  "Abusive / threatening debtor",
  "90+ DPD threshold exceeded",
  "Settlement approval needed",
  "Other",
] as const;

function EscalationModal({
  debtor,
  prefillNotes,
  agentId,
  agentName,
  onClose,
}: {
  debtor: QueueDebtor;
  prefillNotes: string;
  agentId: string;
  agentName: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<(typeof ESCALATION_REASONS)[number] | "">("");
  const [priority, setPriority] = useState<"normal" | "urgent" | "critical">("normal");
  const [notes, setNotes] = useState(prefillNotes);
  const [submitted, setSubmitted] = useState(false);

  const priorityCls = {
    normal: "border-border text-muted-foreground",
    urgent: "border-warning text-warning-foreground bg-warning/10",
    critical: "border-destructive text-destructive bg-destructive/10",
  };

  const handleSubmit = () => {
    if (!reason) {
      toast.error("Select a reason");
      return;
    }
    saveEscalation({
      debtor: {
        id: debtor.id,
        name: debtor.name,
        phone: debtor.phone,
        altPhone: debtor.altPhone,
        loanAmount: debtor.loanAmount,
        dpd: debtor.dpd,
        aiScore: debtor.aiScore,
        scoreReason: debtor.scoreReason,
        lastContacted: debtor.lastContacted,
        portfolio: debtor.portfolio,
        language: debtor.language,
        queueStatus: debtor.queueStatus,
        scheduledAt: debtor.scheduledAt,
        ptpAmount: debtor.ptpAmount,
      },
      reason,
      priority,
      notes,
      agentId,
      agentName,
    }).catch((e) => toast.error(e instanceof Error ? e.message : "Failed to send escalation"));
    setSubmitted(true);
    setTimeout(() => {
      onClose();
      toast.success(`Escalation sent to manager — ${reason}`);
    }, 800);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            Escalate to Manager
          </DialogTitle>
        </DialogHeader>

        {submitted ? (
          <div className="py-8 text-center space-y-2">
            <div className="h-12 w-12 rounded-full bg-success/15 flex items-center justify-center mx-auto">
              <Send className="h-5 w-5 text-success" />
            </div>
            <p className="font-medium text-foreground">Escalation submitted</p>
            <p className="text-sm text-muted-foreground">Manager has been notified.</p>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Debtor context */}
            <div className="rounded-lg bg-muted/40 border border-border px-4 py-3 grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Debtor
                </div>
                <div className="font-medium text-foreground mt-0.5">{debtor.name}</div>
                <div className="text-xs text-muted-foreground">
                  {debtor.loanReference ?? debtor.id}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Outstanding
                </div>
                <div className="font-semibold text-foreground mt-0.5">
                  {formatINR(debtor.loanAmount)}
                </div>
                <div className="text-xs text-muted-foreground">DPD {debtor.dpd}d</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  AI Score
                </div>
                <div
                  className={cn(
                    "font-bold mt-0.5",
                    debtor.aiScore >= 8
                      ? "text-success"
                      : debtor.aiScore >= 5
                        ? "text-warning-foreground"
                        : "text-destructive",
                  )}
                >
                  {debtor.aiScore}/10
                </div>
                <div className="text-xs text-muted-foreground">{debtor.portfolio}</div>
              </div>
            </div>

            {/* Reason */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Reason for escalation</label>
              <div className="grid grid-cols-2 gap-2">
                {ESCALATION_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-xs text-left font-medium transition-all",
                      reason === r
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-muted/30 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* Priority */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Priority</label>
              <div className="flex gap-2">
                {(["normal", "urgent", "critical"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-2 text-xs font-semibold capitalize transition-all",
                      priority === p
                        ? priorityCls[p] + " ring-1 ring-current"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {p === "critical" && <Flag className="h-3 w-3 inline mr-1" />}
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Context for manager</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What happened on the call? What does the manager need to know?"
                className="text-sm min-h-[80px] resize-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                className={cn(
                  "gap-1.5",
                  priority === "critical"
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : "",
                )}
                onClick={handleSubmit}
                disabled={!reason}
              >
                <Send className="h-3.5 w-3.5" />
                Send to Manager
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SortHead({
  label,
  k,
  active,
  dir,
  toggle,
  className,
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
