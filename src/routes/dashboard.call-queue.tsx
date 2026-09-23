import { createFileRoute, Link } from "@tanstack/react-router";
import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Phone,
  PhoneCall,
  MessageCircle,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Square,
  ChevronDown,
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
  ListOrdered,
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
import { todayIstKey } from "@/lib/date-filter";
import { setAgentStatus, closeOpenStatus } from "@/lib/agent-presence-store";
import { bucketOf, formatINR, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";
import {
  addDebtorPhone,
  DEFAULT_PORTFOLIO_SETTINGS,
  type CallMode,
  findDebtorByLoanReference,
} from "@/lib/portfolio-store";
import { formatISTDate } from "@/lib/agent-time-stats";
import { useDialerRun } from "@/lib/dialer/use-dialer-run";
import type { DialTarget } from "@/lib/dialer/engine";
import { fetchDialerAgentNumbers } from "@/lib/dialer/agent-pool";
import { useSingleCall } from "@/lib/dialer/use-single-call";
import {
  QUEUE_FILTERS,
  OUTCOME_META,
  OUTCOME_REASONS,
  QUEUE_STATUS_META,
  dialModeFromDialerMode,
  type DialMode,
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
  EscalationModal,
} from "@/components/call-queue/active-call";
import { DebtorProfile } from "@/components/debtor-profile";
// Re-export so existing importers of this route file (e.g. manager.queue.tsx) keep working —
// these live in proper shared modules now, not in this route file.
export { ActiveCallPanel, ActiveCallModal } from "@/components/call-queue/active-call";
export { buildAssignedQueue } from "@/lib/call-queue/build-queue";
import { buildQueueFromPortfolios } from "@/lib/call-queue/build-queue";
import {
  getScopedPortfolios,
  refreshScopedPortfolios,
  type DebtorScope,
} from "@/lib/scoped-debtors";
export {
  DialerModeBar,
  DialingBoard,
  ProductiveDialBoard,
  LiveCallsPanel,
} from "@/components/call-queue/dialer-boards";
import {
  DialerModeBar,
  DialingBoard,
  ProductiveDialBoard,
  LiveCallsPanel,
} from "@/components/call-queue/dialer-boards";
import {
  saveDisposition,
  isUuid,
  getAgentDispositions,
  getAgentsDispositions,
  getPtpFollowups,
  getTeamPtpFollowups,
  getCaseFollowups,
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
import { buildDispositionSms } from "@/lib/sms-templates";
import { escalateMissedCasesToManager } from "@/lib/ptp-escalation-store";

import { useAuth } from "@/lib/auth";
import { useCallSession } from "@/lib/call-session";
import { toast } from "sonner";
import { TELEPHONY_CALLER_IDS } from "@/lib/telephony/caller-ids";
import { ListPager, usePaged } from "@/components/list-pager";

export const Route = createFileRoute("/dashboard/call-queue")({
  head: () => ({
    meta: [
      { title: "Call Queue · SamvadX" },
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

// ─── Metadata ─────────────────────────────────────────────────────────────────

// ─── Main page ────────────────────────────────────────────────────────────────

/** Route wrapper — the signed-in agent's own, fully interactive queue.
 *
 * Route.useSearch() lives HERE and not inside CallQueueContent. It resolves against the
 * /dashboard/call-queue match, so calling it from a component rendered under a different
 * route — which is exactly what the manager's Agent Live View does — throws
 * "Invariant failed" and takes the whole page down. The wrapper is the only place that is
 * guaranteed to be on this route, so the search param is read here and passed down. */
function CallQueuePage() {
  const { filter } = Route.useSearch();
  return <CallQueueContent initialFilter={filter} />;
}

/**
 * The whole Call Queue screen, reused read-only by the manager's Agent Live View.
 *
 * Two identities, deliberately separate — conflating them is what made the manager's view
 * unsafe to dial from in the first place:
 *
 *   agentId / agentName        WHOSE BOOK IS ON SCREEN. Defaults to the signed-in user, so
 *                              the agent's own route is unchanged. The manager's Agent Live
 *                              View passes the selected agent, rendering their real queue —
 *                              every filter, column, pill and panel.
 *
 *   actingAgentId / -Name      WHO IS PLACING THE CALL. Always the signed-in user, never the
 *                              prop. Dispositions, reminders and escalations are written
 *                              against this, so a manager dialling from an agent's queue is
 *                              recorded as the manager's own work rather than silently
 *                              credited to the agent whose screen they happen to be reading.
 *
 * Side effects that write on the agent's behalf (PTP miss escalation, the due-reminder
 * poller) run only when those two identities are the same — otherwise merely opening this
 * tab would fire them under the viewed agent's name.
 */
/** Whole seconds between two ISO instants, or undefined when either is missing or the pair is
 * nonsensical. Undefined means "not recorded" and must never be reported as zero. */
function secondsBetween(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return undefined;
  return Math.round((b - a) / 1000);
}

export function CallQueueContent({
  agentId: agentIdProp,
  agentName: agentNameProp,
  initialFilter,
}: {
  /** A single agent's own book, or (the manager combined "whole team" view) every agent in the
   * list merged into one queue — see buildAssignedQueue in build-queue.ts. */
  agentId?: string | string[];
  agentName?: string;
  /** Seeds the status pill from ?filter=. Supplied by the route wrapper — this component must
   * never read route search itself, see CallQueuePage. */
  initialFilter?: QueueFilter;
} = {}) {
  const { user } = useAuth();
  // Operational identity is the account email (matches the roster + assignments)
  const actingAgentId = user?.email ?? user?.id ?? "AGT-ANON";
  const actingAgentName = user?.name ?? "Agent";
  const agentId = agentIdProp ?? actingAgentId;
  const agentName = agentNameProp ?? actingAgentName;
  const isCombined = Array.isArray(agentId);
  /** True on an agent's own queue; false when a manager is reading someone else's (or the
   * combined multi-agent view, which is never "self"). */
  const isSelf = !isCombined && agentId === actingAgentId;
  // Stable primitive for effect deps — agentId itself may be a fresh array reference every
  // render (the caller mapping agents -> ids inline), which would otherwise reload/re-fire
  // every effect below on every render instead of only when the actual membership changes.
  const agentKey = isCombined ? agentId.slice().sort().join(",") : agentId;
  // Every Call Queue view — an agent's own, a manager reading one agent, or the "whole team"
  // combined view — is scoped by assigned_agent_id, never by portfolio/team membership. See
  // scoped-debtors.ts for why this replaces a full sync of every debtor the caller can see.
  // extraColumns: the one list that renders bank-file columns (see extraColumns below).
  const debtorScope: DebtorScope = useMemo(
    () => ({ kind: "agents", agentIds: isCombined ? agentId : [agentId], extraColumns: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentKey],
  );

  // Agent availability status
  const [status, setStatus] = useState<AgentStatus>("available");
  const [statusOpen, setStatusOpen] = useState(false);
  const statusMeta = STATUS_META[status];

  // Queue = only the debtors assigned to this agent from uploaded portfolios
  const [fullQueue, setFullQueue] = useState<QueueDebtor[]>(() =>
    buildQueueFromPortfolios(getScopedPortfolios(debtorScope)),
  );
  // Which portfolio the agent/manager is looking at. Applied to the queue itself (not just the
  // table) so counts, the dialer boards and the "primary portfolio" dialer settings below all
  // follow the selection. "all" = every portfolio, the previous behaviour.
  const [portfolioFilter, setPortfolioFilter] = useState<string>("all");
  const portfolioOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of fullQueue) {
      if (d.portfolioId) counts.set(d.portfolioId, (counts.get(d.portfolioId) ?? 0) + 1);
    }
    const all = getScopedPortfolios(debtorScope);
    return Array.from(counts, ([id, count]) => ({
      id,
      count,
      name: all.find((p) => p.id === id)?.name ?? "Portfolio",
    })).sort((a, b) => a.name.localeCompare(b.name));
  }, [fullQueue, debtorScope]);
  // A selection that no longer exists (portfolio closed, accounts reassigned) falls back to all
  // rather than leaving the queue empty behind a stale filter.
  const activePortfolioFilter = portfolioOptions.some((o) => o.id === portfolioFilter)
    ? portfolioFilter
    : "all";
  const allQueue = useMemo(
    () =>
      activePortfolioFilter === "all"
        ? fullQueue
        : fullQueue.filter((d) => d.portfolioId === activePortfolioFilter),
    [fullQueue, activePortfolioFilter],
  );

  // Reload queue when assignments/portfolios change. Scoped to just this agentId/agentIds set
  // (see scoped-debtors.ts) instead of resyncing every debtor the signed-in user can see —
  // that full sync measured at 1.3s in the database alone for one manager's team, before
  // network transfer, and was the main cause of Call Queue loading slowly (2026-09-22).
  useEffect(() => {
    const reload = () => setFullQueue(buildQueueFromPortfolios(getScopedPortfolios(debtorScope)));
    window.addEventListener("scoped-portfolios-updated", reload);
    // buildQueueFromPortfolios derives queueStatus/scheduledAt/ptpAmount from the dispositions
    // cache, so the queue has to rebuild when that cache lands — not just when portfolios do.
    // refreshDispositions() below is async and usually resolves AFTER this first build.
    window.addEventListener("dispositions-updated", reload);
    refreshScopedPortfolios(debtorScope);
    refreshDispositions();
    return () => {
      window.removeEventListener("scoped-portfolios-updated", reload);
      window.removeEventListener("dispositions-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey]);

  // Portfolio mode/name are properties of the portfolio, set by the manager at upload time.
  // An agent's queue can span multiple portfolios; show the primary (first) one they're
  // currently working, falling back to the platform default when nothing is assigned yet.
  const primaryPortfolio = allQueue[0]?.portfolioId
    ? getScopedPortfolios(debtorScope).find((p) => p.id === allQueue[0].portfolioId)
    : undefined;
  const dialerSettings = primaryPortfolio?.settings ?? DEFAULT_PORTFOLIO_SETTINGS;
  const portfolioMode: CallMode = dialerSettings.callMode;
  const portfolioName = primaryPortfolio?.name ?? "No portfolio assigned";

  // Seed loggedOutcomes from persisted dispositions
  const outcomesFor = (id: string | string[]) => {
    const persisted = Array.isArray(id) ? getAgentsDispositions(id) : getAgentDispositions(id);
    const map: Record<string, { outcome: CallOutcome; time: string; reason?: string }> = {};
    persisted.forEach((d) => {
      const t = new Date(d.time);
      map[d.debtorId] = {
        outcome: d.outcome as CallOutcome,
        time: `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`,
        reason: d.reason || undefined,
      };
    });
    return map;
  };
  const [loggedOutcomes, setLoggedOutcomes] = useState<
    Record<string, { outcome: CallOutcome; time: string; reason?: string }>
  >(() => outcomesFor(agentId));
  // Re-seed when switching who's being viewed (Agent Live View swaps agentId on the same
  // mounted instance, not a remount) — without this, switching agents left the previous
  // agent's outcome badges showing until a call was logged for the new one.
  useEffect(() => {
    setLoggedOutcomes(outcomesFor(agentId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey]);

  // Recomputed whenever a call is logged (loggedOutcomes changes right after saveDisposition).
  const ptpFollowups = useMemo(
    () => (isCombined ? getTeamPtpFollowups(agentId) : getPtpFollowups(agentId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentKey, loggedOutcomes],
  );

  // Predictive dialer driven by the real engine + simulated provider (src/lib/dialer).
  // Legs progress through the actual call state machine; mode: "server" later moves it
  // server-side for true background dialing with no change here.
  const dialer = useDialerRun();
  // Which floating board to show while the dialer is running: Predictive opens several lines
  // at once (DialingBoard); Productive works one debtor at a time in list order
  // (ProductiveDialBoard). Both share the same useDialerRun instance/legs — this only tracks
  // which button started the current run so the right board renders.
  const [activeDialMode, setActiveDialMode] = useState<"predictive" | "productive" | null>(null);
  // Ordered list dialed by the current Productive run, captured at start so the board can show
  // fixed list-position progress (done / current / upcoming) rather than just the live legs.
  const [productiveTargets, setProductiveTargets] = useState<DialTarget[]>([]);
  const [prodFilter, setProdFilter] = useState<ProdFilter>("all");
  // Caller ID the dialer runs present to the debtor — must be a DID/ExoPhone on the account,
  // never a personal number. Fixed to the first configured DID now that the manual-dial form
  // (which used to own the picker) has moved to ManualDialDock; the dialer boards below still
  // need a caller ID to run with.
  const manualDialCallerId = TELEPHONY_CALLER_IDS[0] ?? "";
  const [retainedOpen, setRetainedOpen] = useState(false);
  const [predictiveNotif, setPredictiveNotif] = useState<string | null>(null);
  const [ptpBannerDismissed, setPtpBannerDismissed] = useState(false);
  // A call the AI has connected and is handing to the agent WHILE they're already on another call
  const [incomingTransfer, setIncomingTransfer] = useState<{
    debtor: QueueDebtor;
    from: string;
  } | null>(null);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>(initialFilter ?? "all");
  const [bucketFilter, setBucketFilter] = useState<DPDBucket | "all">("all");
  const [bucketDropOpen, setBucketDropOpen] = useState(false);
  const [dispositionFilter, setDispositionFilter] = useState<CallOutcome | "all">("all");
  // Narrows within the chosen outcome (e.g. Refused → "Broken Promise to Pay"). Reset to "all"
  // whenever the outcome itself changes, since a reason from a different outcome's list would
  // silently match nothing.
  const [reasonFilter, setReasonFilter] = useState<string | "all">("all");
  const [dispositionDropOpen, setDispositionDropOpen] = useState(false);
  const [expandedDispositionOutcome, setExpandedDispositionOutcome] = useState<CallOutcome | null>(
    null,
  );
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

  // Productive dialing screen-pop: open the debtor's full profile the moment their number
  // starts ringing, same convention as a call-center "screen pop." Only pops once per debtor
  // (tracked via the ref) so it doesn't fight an agent who closes the sheet mid-ring — it pops
  // again only when Productive moves on to a genuinely different debtor.
  const poppedProductiveDebtorRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeDialMode !== "productive") {
      poppedProductiveDebtorRef.current = null;
      return;
    }
    const ringingLeg = dialer.legs.find((lc) => !lc.incoming && lc.status === "ringing");
    if (!ringingLeg || poppedProductiveDebtorRef.current === ringingLeg.loanId) return;
    const debtor = allQueue.find((d) => d.id === ringingLeg.loanId);
    if (!debtor) return;
    poppedProductiveDebtorRef.current = ringingLeg.loanId;
    setProfileDebtor(debtor);
  }, [activeDialMode, dialer.legs, allQueue]);

  // Escalation modal
  const [escalationCall, setEscalationCall] = useState<{
    debtor: QueueDebtor;
    notes: string;
  } | null>(null);

  // (loggedOutcomes is initialized above from persisted store)

  // Active call state — lives in CallSessionProvider (mounted above the dashboard's <Outlet/>)
  // so it survives navigating away from this page, letting the minimized call bar keep showing.
  const { activeCall, setActiveCall, disposition, setDisposition } = useCallSession();
  // Single-call mode: use "server" to place real calls through the telephony provider (not simulator)
  const singleCall = useSingleCall(setActiveCall, { mode: "server" });
  // Keep a ref to the live active call so async dialer callbacks can read the latest value
  const activeCallRef = useRef<ActiveCall | null>(null);
  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  // Open an "available" interval when an agent opens their own queue, and close it when the
  // tab goes away. Without this, an agent who never touches the status picker records nothing
  // and their whole day reads as untracked.
  useEffect(() => {
    if (!isSelf) return;
    void setAgentStatus("available");
    const bye = () => void closeOpenStatus();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      void closeOpenStatus();
    };
  }, [isSelf]);

  const startCall = (
    debtor: QueueDebtor,
    opts?: {
      instant?: boolean;
      agentPhone?: string;
      callerId?: string;
      /** Defaults to "single" — an ordinary one-at-a-time click-to-call, which is what every
       * queue row, the PTP tracker and a transfer all are. The boards and the Manual Dial
       * dock pass their own. */
      dialMode?: DialMode;
    },
  ) => {
    singleCall.reset(); // clear any prior in-flight sim/timer
    setActiveCall({
      debtor,
      dialMode: opts?.dialMode ?? "single",
      // Start of the ring, so ring time can be measured rather than estimated. A transfer
      // (`instant`) is already connected, so its ring time is zero, not unknown.
      dialStartedAt: new Date().toISOString(),
      phase: opts?.instant ? "connected" : "ringing",
      view: "panel",
      muted: false,
      held: false,
      elapsed: 0,
    });
    setDisposition({
      outcome: "",
      reason: "",
      ptpAmount: "",
      ptpDate: "",
      ptpTime: "",
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
      attachLoanId: "",
    });
    // A transferred call is already live on the AI side — connect instantly; a fresh dial rings
    // first, then connects when the (simulated) provider reports the debtor answered.
    if (!opts?.instant)
      singleCall.dial(debtor, { agentPhone: opts?.agentPhone, callerId: opts?.callerId });
  };

  const endCall = () => singleCall.hangup();

  // Records a number the agent just learned (e.g. from the debtor or a family member) against
  // the debtor being called, and reflects it on the in-progress call's snapshot immediately —
  // `activeCall.debtor` is a point-in-time copy, not reactively bound to the portfolio store,
  // so without this the newly added number wouldn't show up until the call was re-opened.
  const handleAddPhone = async (phone: string) => {
    const current = activeCallRef.current;
    if (!current) return;
    try {
      await addDebtorPhone(current.debtor.id, phone);
      setActiveCall((c) =>
        c
          ? { ...c, debtor: { ...c.debtor, altPhones: [...(c.debtor.altPhones ?? []), phone] } }
          : c,
      );
      toast.success("Number added");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add number");
      throw e; // let the input keep what was typed instead of clearing on failure
    }
  };

  // Places a fresh call to a specific number for the debtor already on screen (their primary
  // or one of their alt numbers) — e.g. after the primary number goes unanswered.
  const handleCallNumber = (phone: string) => {
    const current = activeCallRef.current;
    if (!current) return;
    startCall({ ...current.debtor, phone });
  };

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
    // Says "declined", not "redirected to next available agent". Nothing is redirected: there
    // is no provider-side transfer (see PROVIDER_CALL_CONTROL in active-call.tsx), and the
    // dialer has no queue to hand a leg back to. Dismissing the offer is all this does.
    toast(`Declined — ${incomingTransfer.debtor.name} was not connected to you`);
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

      // 4a — every disposition is stored as text; auto-note (+ picked reason) is prepended to
      // any typed note, so the reason shows up in Activity History even though it's also its
      // own field on the record.
      const autoNote = [buildAutoNote(disposition), disposition.reason].filter(Boolean).join(" — ");
      const combinedNotes = [autoNote, disposition.notes.trim()].filter(Boolean).join(" — ");

      // Persist to disposition store
      // Retro-attach: an unmapped manual call can name its account at disposition time. When
      // it resolves, the log is written against the REAL debtor row — which is what puts the
      // call (and its notes) on that account's history instead of nowhere. Ignored when it
      // doesn't match, and irrelevant for any call that already has a debtor behind it.
      const attached = findDebtorByLoanReference(disposition.attachLoanId);
      const attachTo = attached && !isUuid(debtor.id) ? attached : null;

      const record: DispositionRecord = {
        id: crypto.randomUUID(),
        debtorId: attachTo ? attachTo.debtor.id : debtor.id,
        debtorName: attachTo ? attachTo.debtor.name : debtor.name,
        phone: debtor.phone,
        // The caller, not the queue's owner — see the identity note on CallQueueContent.
        agentId: actingAgentId,
        agentName: actingAgentName,
        portfolioName: attachTo ? attachTo.portfolio.name : debtor.portfolio,
        outcome: disposition.outcome as StoredOutcome,
        reason: disposition.reason || undefined,
        notes: combinedNotes,
        ptpAmount: disposition.ptpAmount ? parseFloat(disposition.ptpAmount) : undefined,
        ptpDate: disposition.ptpDate || undefined,
        ptpTime: disposition.ptpTime || undefined,
        // Only meaningful on a callback; the escalation chain reads these to know when a
        // promised call-back was due (see ptp-escalation-store.ts).
        callbackDate: disposition.callbackDate || undefined,
        callbackTime: disposition.callbackTime || undefined,
        paidAmount: disposition.paidAmount ? parseFloat(disposition.paidAmount) : undefined,
        paidRef: disposition.paidRef || undefined,
        loanAmount: debtor.loanAmount,
        dpd: debtor.dpd,
        // Present only if the provider published a recording before the agent dispositioned.
        // Some providers publish these asynchronously, so this is often still empty here and
        // has to be backfilled later once the provider makes it available.
        dialMode: activeCall?.dialMode ?? "single",
        // Measured, not estimated. Undefined rather than 0 when the moments were not
        // captured — a call whose ring time is unknown must not be reported as instant.
        ringSeconds: secondsBetween(activeCall?.dialStartedAt, activeCall?.answeredAt),
        wrapSeconds: secondsBetween(activeCall?.endedAt, now.toISOString()),
        recordingUrl: activeCall?.recordingUrl,
        // Lets the recording be attached later, once the provider publishes it.
        providerCallId: activeCall?.providerCallId,
        time: now.toISOString(),
      };
      saveDisposition(record).catch((e) =>
        toast.error(e instanceof Error ? e.message : "Failed to save call outcome"),
      );

      // 3 — PTP / callback: SMS the debtor and set an agent reminder for the scheduled date
      if (disposition.outcome === "promised" || disposition.outcome === "callback") {
        const isPTP = disposition.outcome === "promised";
        const dueDate = isPTP ? disposition.ptpDate : disposition.callbackDate;
        const dueTime = isPTP ? disposition.ptpTime : disposition.callbackTime;
        const amt = disposition.ptpAmount ? formatINR(parseFloat(disposition.ptpAmount)) : "";
        const sms = buildDispositionSms(disposition.outcome, debtor.name, disposition);
        if (sms) toast.success(`SMS sent to ${debtor.name}`, { description: sms });

        if (dueDate) {
          const reminder: Reminder = {
            id: crypto.randomUUID(),
            // Follow-ups belong to whoever took the call.
            agentId: actingAgentId,
            debtorId: debtor.id,
            debtorName: debtor.name,
            phone: debtor.phone,
            kind: isPTP ? "ptp" : "callback",
            amount: disposition.ptpAmount ? parseFloat(disposition.ptpAmount) : undefined,
            dueDate,
            dueTime: dueTime || undefined,
            message: isPTP
              ? `PTP due — ${debtor.name} promised ${amt} for ${dueDate}${dueTime ? ` at ${dueTime}` : ""}`
              : `Callback due — ${debtor.name} on ${dueDate}${dueTime ? ` at ${dueTime}` : ""}`,
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
        [debtor.id]: {
          outcome: disposition.outcome as CallOutcome,
          time: timeStr,
          reason: disposition.reason || undefined,
        },
      }));
    }
    singleCall.reset();
    setActiveCall(null);
  };

  // When a PTP / callback date has arrived, remind the agent (fires once per due reminder).
  // Self only: markReminderNotified() burns the reminder, so a manager glancing at this agent's
  // queue would consume their due-reminder popups and the agent would never see them.
  useEffect(() => {
    // Self only (never true for the combined multi-agent view — isCombined forces isSelf false).
    if (!isSelf || isCombined) return;
    refreshReminders().then(() => {
      // IST, not UTC. Reminder due-dates are IST calendar dates, but toISOString() reports
      // the UTC day — so an agent on an early shift (before 05:30 IST) was shown YESTERDAY's
      // reminders, burning them via markReminderNotified, and never shown today's at all.
      const todayISO = todayIstKey();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey, isSelf]);

  // Missed-PTP escalation, step 1 of the chain (agent -> manager) — see
  // ptp-escalation-store.ts. Runs opportunistically whenever this page loads or the agent logs
  // another call (ptpFollowups recomputes on loggedOutcomes); ptp_escalations dedupes so this
  // never re-notifies the same overdue PTP twice.
  useEffect(() => {
    // Self only: this WRITES escalations attributed to the agent. Left ungated, a manager
    // merely opening this agent's queue in Agent Live View would raise escalations in that
    // agent's name without anyone acting. Never true for the combined multi-agent view.
    if (!isSelf || isCombined) return;
    // Every dated commitment, not just PTPs — a callback the agent agreed to and never made
    // escalates on the same chain. getCaseFollowups covers both; ptpFollowups above stays
    // PTP-only because the PTP tracker UI it feeds is promise-specific.
    escalateMissedCasesToManager(agentId, getCaseFollowups(agentId)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentKey, ptpFollowups, isSelf]);

  const filterCounts = useMemo(
    () => ({
      all: allQueue.length,
      retained: allQueue.filter((d) => d.retained).length,
      callback: allQueue.filter((d) => d.queueStatus === "callback").length,
      ptp: allQueue.filter((d) => d.queueStatus === "ptp").length,
      no_answer: allQueue.filter((d) => d.queueStatus === "no_answer").length,
      fresh: allQueue.filter((d) => d.queueStatus === "fresh").length,
      escalated: allQueue.filter((d) => d.queueStatus === "escalated").length,
    }),
    [allQueue],
  );

  // "Remaining" = accounts in the queue not yet worked TODAY, judged by lastContacted, which
  // is an IST day key (see fetch-debtors.ts) — so the count rolls over at midnight IST rather
  // than at 05:30 the way a UTC comparison would. Every other count on this row stays as-is;
  // this is the one an agent actually works down to zero.
  const remainingToday = useMemo(() => {
    const today = todayIstKey();
    return allQueue.filter((d) => d.lastContacted !== today).length;
  }, [allQueue]);

  const filteredQueue = useMemo(() => {
    let rows = allQueue;

    // Bucket filter
    if (bucketFilter !== "all") rows = rows.filter((d) => bucketOf(d.dpd) === bucketFilter);

    // Disposition filter — the agent's own latest logged outcome per debtor, optionally
    // narrowed further to a specific reason within that outcome.
    if (dispositionFilter !== "all")
      rows = rows.filter((d) => loggedOutcomes[d.id]?.outcome === dispositionFilter);
    if (reasonFilter !== "all")
      rows = rows.filter((d) => loggedOutcomes[d.id]?.reason === reasonFilter);

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
    dispositionFilter,
    reasonFilter,
    loggedOutcomes,
    queueSearch,
    prodFilter,
    filterStatus,
    filterOutstanding,
    filterDpd,
    filterScore,
    qSortKey,
    qSortDir,
  ]);

  // Every raw CSV column the upload didn't map to a named field — debtorFromRow() carries the
  // whole bag on `_uploadedExtra`. Rendered as extra columns after Reason so scrolling the
  // (non-sticky) middle of the row surfaces most of the uploaded file, not just the handful of
  // fields this table already has dedicated columns for. Built from allQueue (not
  // filteredQueue) so the column set doesn't jump around as filters/search change; ordered by
  // first appearance so it roughly tracks the source CSV's column order.
  //
  // Capped — some portfolios carry 150+ unmapped columns, which used to render literally, and
  // one (165 columns) blew the table out to ~32,900px wide. Confirmed live (screen recording)
  // that a table that wide makes Chromium "ghost" far-off-screen cell content through the
  // sticky Debtor/Actions columns during horizontal scroll — a real compositor bug, not just a
  // usability problem, and will-change:transform on the sticky cells did not fix it. 25 columns
  // keeps the table in a width range with no observed ghosting and is already far more of the
  // upload than the table showed before this feature existed.
  const MAX_EXTRA_COLUMNS = 25;
  // Paged rendering (list-pager.tsx). Everything above — filters, counts, export, "dial all" —
  // still works on the whole filteredQueue; only the table body shows one page. The key is the
  // same set of inputs filteredQueue depends on (plus whose queue it is), so a filter/sort/
  // search change goes back to page 1 but a background refresh or a saved disposition does not.
  const queuePaged = usePaged(
    filteredQueue,
    JSON.stringify([
      agentKey,
      queueFilter,
      bucketFilter,
      dispositionFilter,
      reasonFilter,
      queueSearch,
      prodFilter,
      filterStatus,
      filterOutstanding,
      filterDpd,
      filterScore,
      qSortKey,
      qSortDir,
    ]),
  );
  const queueScrollRef = useRef<HTMLDivElement>(null);

  const extraColumns = useMemo(() => {
    const seen = new Set<string>();
    const cols: string[] = [];
    for (const d of allQueue) {
      if (cols.length >= MAX_EXTRA_COLUMNS) break;
      const extra = (d as QueueDebtor & { _uploadedExtra?: Record<string, string> })._uploadedExtra;
      if (!extra) continue;
      for (const key of Object.keys(extra)) {
        if (cols.length >= MAX_EXTRA_COLUMNS) break;
        if (!seen.has(key)) {
          seen.add(key);
          cols.push(key);
        }
      }
    }
    return cols;
  }, [allQueue]);

  // Narrower than QueueFilter — only the statuses filterCounts actually computes from real
  // queueStatus data. switch_off/nc/paid exist in QueueFilter for URL back-compat but were
  // never wired to real counts or filtering, so they're not offered as pills here.
  const FILTERS: { key: Extract<QueueFilter, keyof typeof filterCounts>; label: string }[] = [
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
            <p className="text-sm text-muted-foreground">Live queue · {formatISTDate()}</p>
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
                      // Persisted now, not just held in React state. This picker has existed
                      // since the beginning and was never saved, which is why break and idle
                      // time had to be invented — see agent-presence-store.ts. Only for the
                      // agent's own queue: a manager viewing someone else's must not stamp
                      // presence under their name.
                      if (isSelf) void setAgentStatus(key);
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
          portfolioName={isCombined ? "Combined team view — multiple portfolios" : portfolioName}
          dialerRunning={dialer.running}
        />
      </div>

      {/* ── Portfolio switcher — first thing on the page, above every KPI card. Only shown when
          there is more than one open portfolio to choose between. ── */}
      {portfolioOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Portfolio">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Portfolio
          </span>
          {[
            { id: "all", name: "All portfolios", count: fullQueue.length },
            ...portfolioOptions,
          ].map((o) => (
            <button
              key={o.id}
              type="button"
              role="tab"
              aria-selected={activePortfolioFilter === o.id}
              onClick={() => setPortfolioFilter(o.id)}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors",
                activePortfolioFilter === o.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground hover:bg-muted",
              )}
            >
              {o.name}
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  activePortfolioFilter === o.id ? "bg-primary-foreground/20" : "bg-muted",
                )}
              >
                {o.count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── Priority PTP reminder — PTPs due today, impossible to miss without dismissing ── */}
      {!ptpBannerDismissed && ptpFollowups.some((p) => p.daysLeft === 0) && (
        <div className="animate-in slide-in-from-top-2 duration-300 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-sm text-destructive font-medium">
          <Bell className="h-4 w-4 flex-shrink-0 animate-pulse" />
          <span>
            {ptpFollowups.filter((p) => p.daysLeft === 0).length} PTP
            {ptpFollowups.filter((p) => p.daysLeft === 0).length === 1 ? "" : "s"} due today —{" "}
            {formatINR(
              ptpFollowups.filter((p) => p.daysLeft === 0).reduce((s, p) => s + p.ptpAmount, 0),
            )}{" "}
            total. Don't miss these.
          </span>
          <button
            type="button"
            onClick={() =>
              document
                .getElementById("ptp-follow-up-tracker")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            className="text-destructive/80 hover:text-destructive underline underline-offset-2 text-xs flex-shrink-0"
          >
            View
          </button>
          <button
            type="button"
            onClick={() => setPtpBannerDismissed(true)}
            className="text-destructive/60 hover:text-destructive flex-shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Predictive notification banner ── */}
      {predictiveNotif && (
        <div className="animate-in slide-in-from-top-2 duration-300 flex items-center gap-3 rounded-lg border border-success/30 bg-success/8 px-4 py-2.5 text-sm text-success font-medium">
          <Bell className="h-4 w-4 flex-shrink-0 animate-pulse" />
          <span>Productive Dialer: {predictiveNotif}</span>
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            {
              label: "Remaining",
              value: remainingToday.toString(),
              sub: "not yet worked today",
              cls: "text-amber-500",
            },
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
                  {filterCounts.callback + filterCounts.ptp}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: "Callback", value: filterCounts.callback, cls: "text-amber-500" },
                  { label: "PTP", value: filterCounts.ptp, cls: "text-blue-500" },
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
                  {filterCounts.fresh + filterCounts.no_answer + filterCounts.escalated}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Ringing / Fresh", value: filterCounts.fresh, cls: "text-blue-400" },
                  { label: "No Answer", value: filterCounts.no_answer, cls: "text-destructive" },
                  {
                    label: "Escalated",
                    value: filterCounts.escalated,
                    cls: "text-orange-500",
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
      <div id="ptp-follow-up-tracker" />
      <PTPTracker
        onCall={startCall}
        onView={setProfileDebtor}
        queue={allQueue}
        followups={ptpFollowups}
        bucketFilter={bucketFilter}
        search={queueSearch}
      />

      {/* ── Call Queue ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionLabel>Call Queue · Today</SectionLabel>

          {/* Dialer controls — above the queue, not in page header. Hidden on the manager's
              combined "whole team" view: dialerSettings below is one portfolio's config
              (whichever debtor happens to be first in the merged list), and applying it as a
              bulk-dial run across accounts that may span several agents' different portfolios
              would silently use the wrong call-mode/rechurn policy for most of them. Calling
              a specific row still works fine either way. */}
          {!isCombined && (
            <div className="flex items-center gap-2">
              {/* Manual Dial moved out of this page entirely — it now lives in the
                always-available ManualDialDock (bottom-left, mounted at the dashboard and
                manager layout level), so an agent can dial from anywhere instead of only
                from here. It also gained a Loan ID field, which binds an off-queue call to
                a real account. See src/components/manual-dial-dock.tsx. */}

              {/* "Productive Dial" button — dialerMode "predictive" internally (kept as-is; only
                the display label changed). Real engine + simulated provider via useDialerRun. */}
              <Button
                size="sm"
                disabled={dialer.running && activeDialMode !== "predictive"}
                onClick={async () => {
                  if (dialer.running) {
                    dialer.stop();
                    setActiveDialMode(null);
                    return;
                  }
                  // 4b — dial the currently filtered queue, not the whole book
                  const target = filteredQueue.length ? filteredQueue : allQueue;
                  const activeFilter = FILTERS.find((f) => f.key === queueFilter);
                  // The agent pool is the concurrency ceiling: click-to-call rings an agent
                  // first, so a line cannot be opened without one free to take it.
                  const agentNumbers = await fetchDialerAgentNumbers();
                  if (!agentNumbers.length) {
                    toast.error(
                      "No agents with a phone number configured — set one in Admin → Users before dialing.",
                    );
                    return;
                  }
                  setActiveDialMode("predictive");
                  try {
                    await dialer.start({
                      settings: dialerSettings,
                      targets: target.map((d) => ({
                        id: d.id,
                        name: d.name,
                        phone: d.phone,
                        portfolioId: d.portfolioId,
                        aiScore: d.aiScore,
                      })),
                      agentNumbers,
                      callerId: manualDialCallerId,
                    });
                  } catch (e) {
                    setActiveDialMode(null);
                    toast.error(e instanceof Error ? e.message : "Failed to start the dialer");
                    return;
                  }
                  toast.success(
                    `Dialing ${activeFilter && queueFilter !== "all" ? `"${activeFilter.label}"` : "full"} queue — ${target.length} account${target.length === 1 ? "" : "s"} across ${agentNumbers.length} agent${agentNumbers.length === 1 ? "" : "s"}`,
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
                  dialer.running && activeDialMode === "predictive"
                    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    : "bg-success text-success-foreground hover:bg-success/90",
                )}
              >
                {dialer.running && activeDialMode === "predictive" ? (
                  <>
                    <Square className="h-3.5 w-3.5" />
                    Stop Dialer
                  </>
                ) : (
                  <>
                    <Zap className="h-3.5 w-3.5" />
                    Productive Dial
                  </>
                )}
              </Button>

              {/* "Progressive Dial" button — dialerMode "productive" internally (kept as-is; only
                the display label changed). Same engine, capacity forced to one line: dial the
                next debtor in list order, wait for it to reach a terminal state (no-answer /
                busy / completed) or connect, then move to the next. No overdial. */}
              <Button
                size="sm"
                variant="outline"
                disabled={dialer.running && activeDialMode !== "productive"}
                onClick={async () => {
                  if (dialer.running) {
                    dialer.stop();
                    setActiveDialMode(null);
                    return;
                  }
                  const target = filteredQueue.length ? filteredQueue : allQueue;
                  const activeFilter = FILTERS.find((f) => f.key === queueFilter);
                  const agentNumbers = await fetchDialerAgentNumbers();
                  if (!agentNumbers.length) {
                    toast.error(
                      "No agents with a phone number configured — set one in Admin → Users before dialing.",
                    );
                    return;
                  }
                  const orderedTargets: DialTarget[] = target.map((d) => ({
                    id: d.id,
                    name: d.name,
                    phone: d.phone,
                    portfolioId: d.portfolioId,
                    aiScore: d.aiScore,
                    // CSV alt_phones plus any an agent added by hand (Debtor Profile → Add Phone)
                    // — planProductiveBatch works through these after the primary number.
                    altPhones: d.altPhones,
                  }));
                  setActiveDialMode("productive");
                  setProductiveTargets(orderedTargets);
                  try {
                    await dialer.start({
                      settings: { ...dialerSettings, dialerMode: "productive" },
                      targets: orderedTargets,
                      agentNumbers,
                      callerId: manualDialCallerId,
                    });
                  } catch (e) {
                    setActiveDialMode(null);
                    setProductiveTargets([]);
                    toast.error(e instanceof Error ? e.message : "Failed to start the dialer");
                    return;
                  }
                  toast.success(
                    `Progressive calling ${activeFilter && queueFilter !== "all" ? `"${activeFilter.label}"` : "full"} queue — ${target.length} account${target.length === 1 ? "" : "s"}, one at a time`,
                  );
                }}
                className="gap-1.5 text-sm"
              >
                {dialer.running && activeDialMode === "productive" ? (
                  <>
                    <Square className="h-3.5 w-3.5" />
                    Stop Dialer
                  </>
                ) : (
                  <>
                    <ListOrdered className="h-3.5 w-3.5" />
                    Progressive Dial
                  </>
                )}
              </Button>
            </div>
          )}
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

        {/* Status filter pills — never wraps; the pills scroll horizontally on their own so
            they always stay on one line. The overflow-x-auto that does that lives on THIS
            inner wrapper only, not on a shared ancestor of the dropdowns below — an ancestor
            with overflow-x set forces overflow-y to "auto" too (a CSS overflow-x/y coupling
            rule), which was silently clipping the Bucket/Disposition dropdown panels to this
            row's height instead of letting them float over the table. */}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setQueueFilter(f.key)}
                className={cn(
                  "inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all duration-150",
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
          </div>

          {/* Bucket + Disposition dropdowns + search — right side */}
          <div className="ml-auto flex flex-shrink-0 items-center gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setBucketDropOpen((o) => !o)}
                className={cn(
                  "flex items-center gap-1.5 h-7 rounded-lg border px-2.5 text-xs transition-all whitespace-nowrap",
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
            <div className="relative">
              <button
                type="button"
                onClick={() => setDispositionDropOpen((o) => !o)}
                className={cn(
                  "flex items-center gap-1.5 h-7 max-w-[160px] rounded-lg border px-2.5 text-xs transition-all",
                  dispositionFilter !== "all"
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                <span className="truncate">
                  {dispositionFilter === "all"
                    ? "Disposition"
                    : reasonFilter === "all"
                      ? OUTCOME_META[dispositionFilter].label
                      : reasonFilter}
                </span>
                <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-60" />
              </button>
              {dispositionDropOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 w-64 rounded-lg border border-border bg-card shadow-lg py-1 max-h-96 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => {
                      setDispositionFilter("all");
                      setReasonFilter("all");
                      setDispositionDropOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50",
                      dispositionFilter === "all"
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    All Dispositions
                  </button>
                  {(Object.keys(OUTCOME_META) as CallOutcome[]).map((code) => {
                    const reasons = OUTCOME_REASONS[code] ?? [];
                    const isExpanded = expandedDispositionOutcome === code;
                    return (
                      <div key={code}>
                        <div
                          className={cn(
                            "flex items-center justify-between hover:bg-muted/50",
                            dispositionFilter === code && reasonFilter === "all" && "bg-muted/30",
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setDispositionFilter(code);
                              setReasonFilter("all");
                              setDispositionDropOpen(false);
                            }}
                            className={cn(
                              "flex-1 text-left px-3 py-1.5 text-xs",
                              dispositionFilter === code
                                ? "font-medium text-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {OUTCOME_META[code].label}
                          </button>
                          <span className="text-[10px] opacity-50 pr-1">
                            {allQueue.filter((d) => loggedOutcomes[d.id]?.outcome === code).length}
                          </span>
                          {reasons.length > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedDispositionOutcome((o) => (o === code ? null : code))
                              }
                              className="px-2 py-1.5 text-muted-foreground hover:text-foreground"
                              title="Show reasons"
                            >
                              <ChevronDown
                                className={cn(
                                  "h-3 w-3 transition-transform",
                                  isExpanded && "rotate-180",
                                )}
                              />
                            </button>
                          )}
                        </div>
                        {isExpanded && (
                          <div className="border-l border-border ml-3 pl-2">
                            {reasons.map((reason) => {
                              const count = allQueue.filter(
                                (d) =>
                                  loggedOutcomes[d.id]?.outcome === code &&
                                  loggedOutcomes[d.id]?.reason === reason,
                              ).length;
                              return (
                                <button
                                  key={reason}
                                  type="button"
                                  onClick={() => {
                                    setDispositionFilter(code);
                                    setReasonFilter(reason);
                                    setDispositionDropOpen(false);
                                  }}
                                  className={cn(
                                    "w-full text-left px-2 py-1 text-[11px] hover:bg-muted/50 flex items-center justify-between gap-2",
                                    dispositionFilter === code && reasonFilter === reason
                                      ? "font-medium text-foreground"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  <span className="truncate">{reason}</span>
                                  {count > 0 && (
                                    <span className="opacity-50 flex-shrink-0">{count}</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
              className="h-7 gap-1 text-xs whitespace-nowrap"
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
            <div ref={queueScrollRef} className="overflow-auto max-h-[480px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    {/* Debtor name — fixed left column, doesn't scroll with the rest of the
                        row's info; sortable A→Z. transform-gpu (translate3d(0,0,0)) forces its
                        own compositing layer — confirmed live that without it, Chromium lets a
                        non-sticky cell from elsewhere in the FIRST row (the one directly under
                        this sticky header) paint through this cell during horizontal scroll.
                        Only ever the first row — a sticky-header/sticky-column corner bug, not
                        a table-width issue (reproduced at both 32,900px and 4,600px). */}
                    <TableHead className="sticky left-0 z-20 w-[190px] max-w-[190px] bg-card shadow-[1px_0_0_0_var(--border)] transform-gpu">
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

                    {/* Raw CSV columns — scroll past Reason to see them; see extraColumns. */}
                    {extraColumns.map((col) => (
                      <TableHead
                        key={col}
                        className="text-muted-foreground text-xs font-medium uppercase tracking-wider whitespace-nowrap min-w-[120px]"
                      >
                        {col.replace(/_/g, " ")}
                      </TableHead>
                    ))}

                    {/* Reset all column filters */}
                    <TableHead className="sticky right-0 z-20 bg-card text-right shadow-[-1px_0_0_0_var(--border)] transform-gpu">
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
                  {/* Zero-height spacer row, ALWAYS first. Confirmed live (screen recording +
                      manual retest) that the row directly under a sticky thead, in a table
                      that also has a sticky left column, is where Chromium lets a non-sticky
                      cell elsewhere in that row paint through the sticky one during horizontal
                      scroll — reproduced at three different table widths, survived
                      will-change:transform and transform-gpu on the sticky cells themselves.
                      Making that position a real (if invisible) row means whatever corner case
                      Chromium mishandles lands here instead of on an actual debtor's row. */}
                  <TableRow aria-hidden className="h-0 leading-none">
                    <TableCell colSpan={9 + extraColumns.length} className="h-0 p-0 border-0" />
                  </TableRow>
                  {filteredQueue.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={9 + extraColumns.length}
                        className="text-center py-12 text-muted-foreground text-sm"
                      >
                        No debtors match this filter.
                      </TableCell>
                    </TableRow>
                  ) : (
                    queuePaged.pageItems.map((d, i) => (
                      <QueueRow
                        key={d.id}
                        d={d}
                        index={i}
                        onCall={startCall}
                        onView={setProfileDebtor}
                        loggedOutcome={loggedOutcomes[d.id]}
                        extraColumns={extraColumns}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <ListPager
              paged={queuePaged}
              scrollTo={queueScrollRef}
              noun="debtors"
              className="border-t border-border px-4"
            />
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
          onAddPhone={handleAddPhone}
          onCallNumber={handleCallNumber}
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
          onAddPhone={handleAddPhone}
          onCallNumber={handleCallNumber}
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

      {/* ── Floating Dialing Board (bottom-left) — every number currently ringing at once.
          Progressive Dial (dialerMode "productive") never has more than one, so it gets its
          own sequential board below instead. ── */}
      {dialer.running && activeDialMode !== "productive" && (
        <DialingBoard liveCalls={dialer.legs} />
      )}

      {/* ── Floating Progressive Dial Board (bottom-left) — one debtor at a time, in list order ── */}
      {dialer.running && activeDialMode === "productive" && (
        <ProductiveDialBoard
          targets={productiveTargets}
          liveCalls={dialer.legs}
          onStop={() => {
            dialer.stop();
            setActiveDialMode(null);
          }}
        />
      )}

      {/* ── Floating Live Calls Panel (bottom-right) — fed by engine legs ── */}
      {dialer.running && dialer.legs.length > 0 && (
        <LiveCallsPanel
          liveCalls={dialer.legs}
          onDismiss={() => {
            dialer.stop();
            setActiveDialMode(null);
          }}
          onTake={(lc) => {
            const debtor = allQueue.find((d) => d.id === lc.loanId) ?? allQueue[0];
            // Taking a leg off the running dialer — attribute it to whichever board produced
            // it, not to "single". activeDialMode is the INTERNAL enum, whose two values read
            // backwards; dialModeFromDialerMode is the one place that is untangled.
            startCall(debtor, {
              dialMode: activeDialMode ? dialModeFromDialerMode(activeDialMode) : "single",
            });
          }}
          onTransfer={(lc) => {
            // Transferring a live leg is a provider-side operation this app cannot perform —
            // see PROVIDER_CALL_CONTROL in active-call.tsx. Say so rather than claiming it
            // reached another agent.
            toast(`Transfer is not available yet — ${lc.debtor} is still on your line`);
          }}
          onEndLeg={(lc) => {
            dialer
              .endLeg(lc.id)
              .catch((e) => toast.error(e instanceof Error ? e.message : "Failed to end call"));
            toast.success(`Ended call with ${lc.debtor}`);
          }}
        />
      )}

      {/* ── Escalation Modal ── */}
      {escalationCall && (
        <EscalationModal
          debtor={escalationCall.debtor}
          prefillNotes={escalationCall.notes}
          agentId={actingAgentId}
          agentName={actingAgentName}
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
            <DebtorProfile
              d={profileDebtor}
              onClose={() => setProfileDebtor(null)}
              onCall={(d) => startCall(d as QueueDebtor)}
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
  extraColumns,
}: {
  d: QueueDebtor;
  index: number;
  onCall: (d: QueueDebtor) => void;
  onView: (d: QueueDebtor) => void;
  loggedOutcome?: { outcome: CallOutcome; time: string };
  extraColumns: string[];
}) {
  const uploadedExtra = (d as QueueDebtor & { _uploadedExtra?: Record<string, string> })
    ._uploadedExtra;
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
      {/* Fixed left column — stays put while the rest of the row's info scrolls sideways.
          w/max-w + overflow-hidden keeps a long loan reference from bleeding into the Phone
          column that sits right next to it (it isn't sticky, so nothing pushes it out of the
          way — it just gets painted over unless this column's content is clipped).
          Found the real cause of the "ghosting" bug this shipped with: bg-success/5 is 5%
          OPACITY — a sticky cell needs an opaque background to hide the columns scrolled
          underneath it, and this one let ~95% of whatever was behind it show straight
          through, which only ever showed up on rows with a logged outcome because that's the
          one thing gating this branch. color-mix produces a solid (fully opaque) color that
          looks the same but doesn't have that problem; bg-success/5 must never come back
          here even though it's the app's normal way to tint a highlighted row elsewhere. */}
      <TableCell
        className={cn(
          "sticky left-0 z-10 w-[190px] max-w-[190px] overflow-hidden shadow-[1px_0_0_0_var(--border)]",
          loggedOutcome ? "bg-[color-mix(in_oklch,var(--success)_5%,var(--card))]" : "bg-card",
        )}
      >
        <button
          type="button"
          onClick={() => onView(d)}
          className="block w-full text-left hover:underline decoration-primary/40 underline-offset-2"
        >
          <div className="truncate font-medium text-sm text-foreground">{d.name}</div>
          {/* Each on its own block-level line — never sharing a line with the ID — so there
              is no flex-wrap reflow for a sticky cell to get wrong. A flex row here (even with
              wrapping) could end up transiently painting the ID and the badge on top of each
              other for the first row in the list; stacked block lines can't. */}
          <div className="truncate text-[11px] text-muted-foreground">
            {d.loanReference ?? d.id}
          </div>
          {/* Always rendered, at a fixed height, whether or not there's a badge to show —
              confirmed live (screen recording + manual retest across multiple debtors) that
              rows with a badge (taller, 3 lines) vs. without (2 lines) is the actual thing
              that triggers Chromium's sticky-cell ghosting bug here, not row position — a
              spacer row and transform-gpu on the cell both failed to stop it, but this cell's
              own height varying between rows is the one variable that correlated with every
              reproduction. Reserving the same height on every row removes that variable. */}
          <div className="mt-0.5 flex h-[15px] items-center gap-1 text-[11px]">
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
      {/* Raw CSV columns — same key set/order as the header; "—" where this debtor's own
          upload didn't carry that column (different portfolios in one queue can differ). */}
      {extraColumns.map((col) => (
        <TableCell key={col} className="text-xs text-foreground/80 whitespace-nowrap">
          {uploadedExtra?.[col] || "—"}
        </TableCell>
      ))}
      {/* Fixed right column — Call/WA stay put while the row scrolls sideways too. Same
          opaque-background fix as the left sticky cell above — see that comment. */}
      <TableCell
        className={cn(
          "sticky right-0 z-10 shadow-[-1px_0_0_0_var(--border)]",
          loggedOutcome ? "bg-[color-mix(in_oklch,var(--success)_5%,var(--card))]" : "bg-card",
        )}
      >
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
