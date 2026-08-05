import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Phone,
  Users,
  ListChecks,
  ShieldAlert,
  Hash,
  PhoneOff,
  Loader2,
  Zap,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { SMARTFLO_DIDS } from "@/lib/telephony/caller-ids";
import { formatINR, bucketOf, BUCKET_META } from "@/lib/mock-debtors";
import { useManagerTeamAgents, type AgentRef } from "@/lib/team-store";
import {
  buildAssignedQueue,
  QUEUE_STATUS_META,
  OUTCOME_META,
  EMPTY_DISPOSITION,
  ActiveCallPanel,
  ActiveCallModal,
  DialerModeBar,
  LiveCallsPanel,
  type QueueDebtor,
  type ActiveCall,
  type DispositionForm,
} from "@/routes/dashboard.call-queue";
import { useDialerRun } from "@/lib/dialer/use-dialer-run";
import { useSingleCall } from "@/lib/dialer/use-single-call";
import { fetchDialerAgentNumbers } from "@/lib/dialer/agent-pool";
import {
  getOpenEscalations,
  resolveEscalation,
  refreshEscalations,
  type Escalation,
} from "@/lib/escalation-store";
import {
  saveDisposition,
  type DispositionRecord,
  type CallOutcome as StoredOutcome,
} from "@/lib/disposition-store";
import {
  createAdHocDebtor,
  getPortfolios,
  DEFAULT_PORTFOLIO_SETTINGS,
  type CallMode,
} from "@/lib/portfolio-store";
import { useStorageSync } from "@/lib/storage-sync";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/manager/queue")({
  head: () => ({
    meta: [
      { title: "Call Queue · SamvadX" },
      {
        name: "description",
        content: "Live per-agent queues, team overview, and the manager's own escalation queue.",
      },
    ],
  }),
  component: ManagerQueuePage,
});

/* ─── Agent Live View (read-only) ─────────────────────────────────────────── */

function AgentQueueView({
  agentId,
  onCall,
  disabled,
}: {
  agentId: string;
  onCall: (debtor: QueueDebtor) => void;
  disabled: boolean;
}) {
  const [queue, setQueue] = useState<QueueDebtor[]>(() => buildAssignedQueue(agentId));
  // Predictive dialer driven by the real engine + simulated provider (src/lib/dialer). Legs
  // progress through the actual call state machine; swapping to server-side background
  // dialing later is `mode: "server"` in the hook — no change here.
  const dialer = useDialerRun();
  const reload = () => setQueue(buildAssignedQueue(agentId));
  useEffect(() => {
    reload();
    // Switching to a different agent resets the dialer for the new queue.
    dialer.stop();
    window.addEventListener("assignments-updated", reload);
    window.addEventListener("portfolios-updated", reload);
    return () => {
      window.removeEventListener("assignments-updated", reload);
      window.removeEventListener("portfolios-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  useStorageSync(reload);

  if (!queue.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No accounts assigned to this agent yet.
      </p>
    );
  }

  // Portfolio settings (call mode + dialer config) come from the agent's primary (first)
  // assigned portfolio — the same source that drives the agent's own queue.
  const primaryPortfolio = queue[0]?.portfolioId
    ? getPortfolios().find((p) => p.id === queue[0].portfolioId)
    : undefined;
  const settings = primaryPortfolio?.settings ?? DEFAULT_PORTFOLIO_SETTINGS;
  const portfolioMode: CallMode = settings.callMode;
  const portfolioName = primaryPortfolio?.name ?? "No portfolio assigned";

  const toggleDialer = async () => {
    if (dialer.running) {
      dialer.stop();
      return;
    }
    // One click-to-call leg per agent — the pool size is the concurrency ceiling.
    const agentNumbers = await fetchDialerAgentNumbers();
    if (!agentNumbers.length) {
      toast.error(
        "No agents with a phone number configured — set one in Admin → Users before dialing.",
      );
      return;
    }
    dialer.start({
      settings,
      targets: queue.map((d) => ({
        id: d.id,
        name: d.name,
        phone: d.phone,
        portfolioId: d.portfolioId,
        aiScore: d.aiScore,
      })),
      agentNumbers,
    });
    toast.success(
      `Predictive dialing this agent's queue — ${queue.length} account${queue.length === 1 ? "" : "s"}`,
    );
  };

  return (
    <div className="space-y-3">
      {/* Mode status bar — identical to the agent's, driven by this agent's portfolio */}
      <DialerModeBar
        portfolioMode={portfolioMode}
        portfolioName={portfolioName}
        dialerRunning={dialer.running}
      />

      {/* Predictive dialer toggle */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          {dialer.running
            ? "Dialer running — live lines progress through the real call state machine (simulated carrier)."
            : "Start the predictive dialer to preview the agent's live call activity (simulated)."}
        </p>
        <Button
          size="sm"
          onClick={toggleDialer}
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

      <div className="rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                <TableHead>Debtor</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-center">DPD</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>PTP</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.map((d) => {
                const b = bucketOf(d.dpd);
                const statusMeta = QUEUE_STATUS_META[d.queueStatus];
                return (
                  <TableRow key={d.id}>
                    <TableCell>
                      <div className="font-medium text-sm">{d.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {d.id} · {d.portfolio}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.phone}</TableCell>
                    <TableCell className="text-right text-sm">{formatINR(d.loanAmount)}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline" className={cn("text-[10px]", BUCKET_META[b].color)}>
                        {d.dpd}d
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("text-xs", statusMeta.cls)}>
                        {statusMeta.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {d.ptpAmount ? (
                        <span className="font-semibold text-blue-600">
                          {formatINR(d.ptpAmount)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{d.scheduledAt}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs"
                        disabled={disabled}
                        onClick={() => onCall(d)}
                      >
                        <Phone className="h-3 w-3" />
                        Call
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Floating live-calls panel — same component the agent sees, now fed by engine legs */}
      {dialer.running && dialer.legs.length > 0 && (
        <LiveCallsPanel
          liveCalls={dialer.legs}
          onDismiss={() => dialer.stop()}
          onTake={(lc) => {
            const d = queue.find((x) => x.id === lc.loanId);
            if (d && !disabled) onCall(d);
          }}
          onTransfer={(lc) => toast.success(`${lc.debtor} redirected to next available agent`)}
        />
      )}
    </div>
  );
}

function AgentLiveViewTab({
  agents,
  onCall,
  hasActiveCall,
}: {
  agents: AgentRef[];
  onCall: (debtor: QueueDebtor) => void;
  hasActiveCall: boolean;
}) {
  const [selected, setSelected] = useState(agents[0]?.id ?? "");
  useEffect(() => {
    if (!agents.some((a) => a.id === selected)) setSelected(agents[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  if (!agents.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        You don't have a team yet — ask an admin to add you to a team in Admin → Teams.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">Viewing:</span>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="h-9 w-64 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          Exactly what this agent sees — call any account directly on their behalf.
        </span>
      </div>
      {selected && <AgentQueueView agentId={selected} onCall={onCall} disabled={hasActiveCall} />}
    </div>
  );
}

/* ─── Overview (aggregate) ─────────────────────────────────────────────────── */

function OverviewTab({
  agents,
  onViewAgent,
}: {
  agents: AgentRef[];
  onViewAgent: (agentId: string, tab: string) => void;
}) {
  const [queues, setQueues] = useState<Record<string, QueueDebtor[]>>(() =>
    Object.fromEntries(agents.map((a) => [a.id, buildAssignedQueue(a.id)])),
  );
  const reload = () =>
    setQueues(Object.fromEntries(agents.map((a) => [a.id, buildAssignedQueue(a.id)])));
  useEffect(() => {
    reload();
    window.addEventListener("assignments-updated", reload);
    window.addEventListener("portfolios-updated", reload);
    return () => {
      window.removeEventListener("assignments-updated", reload);
      window.removeEventListener("portfolios-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);
  useStorageSync(reload);

  const all = Object.values(queues).flat();
  const counts = useMemo(
    () => ({
      total: all.length,
      ptp: all.filter((d) => d.queueStatus === "ptp").length,
      callback: all.filter((d) => d.queueStatus === "callback").length,
      escalated: all.filter((d) => d.queueStatus === "escalated").length,
      fresh: all.filter((d) => d.queueStatus === "fresh").length,
      no_answer: all.filter((d) => d.queueStatus === "no_answer").length,
    }),
    [all],
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Total in Queue", value: counts.total, cls: "text-foreground" },
          { label: "PTP", value: counts.ptp, cls: "text-blue-500" },
          { label: "Callback", value: counts.callback, cls: "text-amber-500" },
          { label: "Escalated", value: counts.escalated, cls: "text-destructive" },
          { label: "Fresh", value: counts.fresh, cls: "text-success" },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="p-3.5">
              <div className={cn("text-xl font-bold tabular-nums", s.cls)}>{s.value}</div>
              <div className="text-[11px] font-medium text-muted-foreground mt-0.5">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {agents.map((a) => {
          const q = queues[a.id] ?? [];
          const ptp = q.filter((d) => d.queueStatus === "ptp").length;
          const esc = q.filter((d) => d.queueStatus === "escalated").length;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onViewAgent(a.id, "live")}
              className="text-left rounded-xl border border-border bg-card p-4 transition-all hover:border-foreground/30 hover:shadow-sm"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-foreground">{a.name}</span>
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-2xl font-bold text-foreground">{q.length}</div>
              <div className="text-[11px] text-muted-foreground mb-2">accounts in queue</div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-blue-500 font-medium">{ptp} PTP</span>
                {esc > 0 && <span className="text-destructive font-medium">{esc} escalated</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─── My Queue (manager's own escalations + manual dial) ──────────────────── */

function MyQueueTab({
  startCall,
  hasActiveCall,
}: {
  startCall: (debtor: QueueDebtor, escalationId: string | null, callerId?: string) => void;
  hasActiveCall: boolean;
}) {
  const [escalations, setEscalations] = useState<Escalation[]>(() => getOpenEscalations());
  const reload = () => setEscalations(getOpenEscalations());
  useEffect(() => {
    reload();
    window.addEventListener("escalations-updated", reload);
    refreshEscalations();
    return () => window.removeEventListener("escalations-updated", reload);
  }, []);
  useStorageSync(reload);

  const [manualNumber, setManualNumber] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualCallerId, setManualCallerId] = useState<string>(SMARTFLO_DIDS[0]);
  const [dialingManual, setDialingManual] = useState(false);

  const callEscalation = (e: Escalation) => {
    startCall({ ...e.debtor, retained: false }, e.id);
  };

  const callManual = async () => {
    if (!manualNumber) return;
    const name = manualName || manualNumber;
    setDialingManual(true);
    try {
      // A manual dial isn't in any uploaded portfolio, so it needs its own debtors row —
      // otherwise logging a disposition against it would fail the call_logs FK constraint.
      const debtorId = await createAdHocDebtor(name, manualNumber);
      startCall(
        {
          id: debtorId,
          name,
          phone: manualNumber,
          loanAmount: 0,
          dpd: 0,
          aiScore: 0,
          scoreReason: "Manual dial by manager",
          lastContacted: null,
          portfolio: "Manual Dial",
          language: "English",
          queueStatus: "fresh",
          scheduledAt: "—",
        },
        null,
        manualCallerId,
      );
      setManualNumber("");
      setManualName("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start manual dial");
    } finally {
      setDialingManual(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Manual dial */}
      <Card>
        <CardHeader className="pb-3 border-b border-border">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Hash className="h-4 w-4 text-primary" />
            Manual Dial
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Name (optional)</label>
            <Input
              placeholder="Debtor name"
              value={manualName}
              onChange={(e) => setManualName(e.target.value)}
              className="h-9 w-48"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Phone number</label>
            <Input
              placeholder="+91 XXXXX XXXXX"
              value={manualNumber}
              onChange={(e) => setManualNumber(e.target.value)}
              className="h-9 w-48 font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Caller ID (SmartFlo DID)</label>
            <Select value={manualCallerId} onValueChange={setManualCallerId}>
              <SelectTrigger className="h-9 w-40 text-sm">
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
            className="h-9 gap-1.5"
            disabled={!manualNumber || dialingManual || hasActiveCall}
            onClick={callManual}
          >
            {dialingManual ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Phone className="h-3.5 w-3.5" />
            )}
            Call Now
          </Button>
        </CardContent>
      </Card>

      {/* Escalations */}
      <Card>
        <CardHeader className="pb-3 border-b border-border">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            Escalations
            <Badge variant="secondary" className="ml-auto text-[10px]">
              {escalations.length} open
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {escalations.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No open escalations — agent-escalated calls will appear here.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {escalations.map((e) => (
                <div key={e.id} className="flex items-center gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{e.debtor.name}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          e.priority === "critical"
                            ? "border-destructive/40 text-destructive bg-destructive/10"
                            : e.priority === "urgent"
                              ? "border-warning/40 text-warning-foreground bg-warning/10"
                              : "border-border text-muted-foreground",
                        )}
                      >
                        {e.priority}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {e.reason} · from {e.agentName} · {formatINR(e.debtor.loanAmount)} outstanding
                    </p>
                    {e.notes && <p className="text-xs text-foreground/80 mt-0.5">{e.notes}</p>}
                  </div>
                  <Button
                    size="sm"
                    className="gap-1.5 flex-shrink-0"
                    disabled={hasActiveCall}
                    onClick={() => callEscalation(e)}
                  >
                    <Phone className="h-3.5 w-3.5" />
                    Call
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function ManagerQueuePage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const managerName = user?.name ?? "Manager";
  const agents = useManagerTeamAgents(managerId);
  const [tab, setTab] = useState("live");
  const [openEscalations, setOpenEscalations] = useState(() => getOpenEscalations().length);
  useEffect(() => {
    const reload = () => setOpenEscalations(getOpenEscalations().length);
    window.addEventListener("escalations-updated", reload);
    refreshEscalations();
    return () => window.removeEventListener("escalations-updated", reload);
  }, []);
  useStorageSync(() => setOpenEscalations(getOpenEscalations().length));

  // Active-call state lives here (not inside a single tab) so a call started from Agent
  // Live View or My Queue keeps its panel visible even if the manager switches tabs mid-call.
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [activeEscalationId, setActiveEscalationId] = useState<string | null>(null);
  const [disposition, setDisposition] = useState<DispositionForm>(EMPTY_DISPOSITION);
  // Places a real call through Tata SmartFlo (mode: "server") — this used to be a fake
  // setTimeout(3000ms) that flipped straight to "connected" with no provider call at all,
  // which is why manager-initiated calls (manual dial, escalation calls) never actually rang.
  const singleCall = useSingleCall(setActiveCall, { mode: "server" });

  const startCall = (debtor: QueueDebtor, escalationId: string | null, callerId?: string) => {
    singleCall.reset();
    setActiveEscalationId(escalationId);
    setActiveCall({
      debtor,
      phase: "ringing",
      view: "panel",
      muted: false,
      held: false,
      elapsed: 0,
    });
    setDisposition(EMPTY_DISPOSITION);
    singleCall.dial(debtor, { callerId });
  };

  const endCall = () => singleCall.hangup();

  const submitDisposition = () => {
    if (!disposition.outcome) {
      toast.error("Select an outcome before submitting");
      return;
    }
    if (activeCall) {
      const debtor = activeCall.debtor;
      const record: DispositionRecord = {
        id: crypto.randomUUID(),
        debtorId: debtor.id,
        debtorName: debtor.name,
        phone: debtor.phone,
        agentId: managerId,
        agentName: managerName,
        portfolioName: debtor.portfolio,
        outcome: disposition.outcome as StoredOutcome,
        notes: disposition.notes,
        ptpAmount: disposition.ptpAmount ? parseFloat(disposition.ptpAmount) : undefined,
        ptpDate: disposition.ptpDate || undefined,
        paidAmount: disposition.paidAmount ? parseFloat(disposition.paidAmount) : undefined,
        paidRef: disposition.paidRef || undefined,
        loanAmount: debtor.loanAmount,
        dpd: debtor.dpd,
        recordingUrl: activeCall.recordingUrl,
        providerCallId: activeCall.providerCallId,
        time: new Date().toISOString(),
      };
      saveDisposition(record).catch((e) =>
        toast.error(e instanceof Error ? e.message : "Failed to save call outcome"),
      );
      if (activeEscalationId) {
        resolveEscalation(activeEscalationId).catch((e) =>
          toast.error(e instanceof Error ? e.message : "Failed to resolve escalation"),
        );
      }
      toast.success(`Call logged — ${disposition.outcome}`);
    }
    setActiveCall(null);
    setActiveEscalationId(null);
  };

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Queue</h1>
        <p className="text-sm text-muted-foreground">
          Live per-agent queues, a team-wide overview, and your own escalation queue.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="live" className="gap-1.5">
            <Users className="h-3.5 w-3.5" />
            Agent Live View
          </TabsTrigger>
          <TabsTrigger value="overview" className="gap-1.5">
            <ListChecks className="h-3.5 w-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="my" className="gap-1.5">
            <PhoneOff className="h-3.5 w-3.5" />
            My Queue
            {openEscalations > 0 && (
              <Badge variant="destructive" className="ml-1 h-4 px-1.5 text-[10px]">
                {openEscalations}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="live" className="mt-4">
          <AgentLiveViewTab
            agents={agents}
            onCall={(d) => startCall(d, null)}
            hasActiveCall={!!activeCall}
          />
        </TabsContent>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab agents={agents} onViewAgent={(_agentId, t) => setTab(t)} />
        </TabsContent>
        <TabsContent value="my" className="mt-4">
          <MyQueueTab startCall={startCall} hasActiveCall={!!activeCall} />
        </TabsContent>
      </Tabs>

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
          onMinimize={() => setActiveCall((c) => (c ? { ...c, view: "modal" } : null))}
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
          onMinimize={() => setActiveCall((c) => (c ? { ...c, view: "modal" } : null))}
        />
      )}
    </div>
  );
}
