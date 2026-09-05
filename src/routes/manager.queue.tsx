import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Phone,
  Users,
  ShieldAlert,
  Hash,
  PhoneOff,
  Loader2,
  Zap,
  Square,
  ListOrdered,
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
import { TELEPHONY_CALLER_IDS } from "@/lib/telephony/caller-ids";
import { formatINR, bucketOf, BUCKET_META, type Debtor } from "@/lib/mock-debtors";
import { useTeamAgents, type AgentRef } from "@/lib/team-store";
import { useActiveTeam } from "@/lib/active-team-store";
import {
  QUEUE_STATUS_META,
  OUTCOME_META,
  EMPTY_DISPOSITION,
  type QueueDebtor,
  type ActiveCall,
  type DispositionForm,
} from "@/lib/call-queue/types";
import { CallQueueContent } from "./dashboard.call-queue";
import { DebtorProfile } from "./dashboard.debtors";
import { ActiveCallPanel, ActiveCallModal } from "@/components/call-queue/active-call";
import {
  DialerModeBar,
  LiveCallsPanel,
  DialingBoard,
  ProductiveDialBoard,
} from "@/components/call-queue/dialer-boards";
import { useDialerRun } from "@/lib/dialer/use-dialer-run";
import { useSingleCall } from "@/lib/dialer/use-single-call";
import { fetchDialerAgentNumbers } from "@/lib/dialer/agent-pool";
import type { DialTarget } from "@/lib/dialer/engine";
import {
  getOpenEscalations,
  getOpenEscalationsForAgents,
  resolveEscalation,
  refreshEscalations,
  type Escalation,
} from "@/lib/escalation-store";
import {
  saveDisposition,
  refreshDispositions,
  type DispositionRecord,
  type CallOutcome as StoredOutcome,
} from "@/lib/disposition-store";
import { saveReminder, type Reminder } from "@/lib/reminder-store";
import { buildDispositionSms } from "@/lib/sms-templates";
import {
  createAdHocDebtor,
  getPortfolios,
  addDebtorPhone,
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
        content:
          "Live per-agent or combined whole-team queues, and the manager's own escalation queue.",
      },
    ],
  }),
  component: ManagerQueuePage,
});

/* ─── Agent Live View (read-only) ─────────────────────────────────────────── */

// Sentinel for "every team member's queue, merged" — not a real agent id, so it can never
// collide with one and never needs resetting just because the roster changed underneath it.
const ALL_AGENTS = "__all__";

function AgentLiveViewTab({ agents }: { agents: AgentRef[] }) {
  const [selected, setSelected] = useState<string>(ALL_AGENTS);
  useEffect(() => {
    if (selected !== ALL_AGENTS && !agents.some((a) => a.id === selected)) {
      setSelected(ALL_AGENTS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  if (!agents.length) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        You don't have a team yet — ask an admin to add you to a team in Admin → Teams.
      </p>
    );
  }

  const viewingAll = selected === ALL_AGENTS;
  const selectedAgent = agents.find((a) => a.id === selected);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-foreground">Viewing:</span>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="h-9 w-64 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_AGENTS}>All — whole team combined</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        {viewingAll ? (
          <>
            Every account assigned to your {agents.length} team member
            {agents.length === 1 ? "" : "s"}, merged into one queue — same screen, same filters.
            Productive/Progressive bulk dial is turned off here since accounts can span different
            portfolios' settings; call a row directly instead. Disposition/PTP logging still credits{" "}
            <strong>you</strong>, not whoever the account is assigned to.
          </>
        ) : (
          <>
            {selectedAgent?.name ?? "This agent"}&apos;s Call Queue — the same screen they work,
            with every filter, column and panel they have. You can call any account directly from
            here; the call, its disposition and any PTP are logged as <strong>your</strong> work,
            not theirs.
          </>
        )}
      </div>
      <CallQueueContent
        agentId={viewingAll ? agents.map((a) => a.id) : selected}
        agentName={viewingAll ? "Whole Team" : selectedAgent?.name}
      />
    </div>
  );
}

/* ─── My Queue (manager's own assigned accounts + escalations + manual dial) ─── */

function MyQueueTab({
  managerId,
  managerName,
  startCall,
  hasActiveCall,
  teamAgentIds,
}: {
  /** The signed-in manager's own operational id (email) — a manager can now be assigned debtor
   * accounts directly (see withSelf in team-store.ts), same as any agent, so their own queue
   * belongs here too rather than only escalations/manual dial. */
  managerId: string;
  managerName: string;
  startCall: (debtor: QueueDebtor, escalationId: string | null, callerId?: string) => void;
  hasActiveCall: boolean;
  /** Emails of the agents this manager is responsible for; undefined for an admin, who is
   * org-wide on purpose. Scopes the queue so a manager only sees escalations raised by their
   * own agents. */
  teamAgentIds: string[] | undefined;
}) {
  const [escalations, setEscalations] = useState<Escalation[]>(() =>
    getOpenEscalationsForAgents(teamAgentIds),
  );
  const [profileDebtor, setProfileDebtor] = useState<Debtor | null>(null);
  const reload = useCallback(
    () => setEscalations(getOpenEscalationsForAgents(teamAgentIds)),
    [teamAgentIds],
  );
  useEffect(() => {
    reload();
    window.addEventListener("escalations-updated", reload);
    refreshEscalations();
    return () => window.removeEventListener("escalations-updated", reload);
  }, [reload]);
  useStorageSync(reload);

  const [manualNumber, setManualNumber] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualCallerId, setManualCallerId] = useState<string>(TELEPHONY_CALLER_IDS[0] ?? "");
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
      {/* Accounts assigned directly to the manager — same queue screen an agent works */}
      <div>
        <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          My Assigned Accounts
        </div>
        <CallQueueContent agentId={managerId} agentName={managerName} />
      </div>

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
            <label className="text-xs text-muted-foreground">Caller ID</label>
            <Select value={manualCallerId} onValueChange={setManualCallerId}>
              <SelectTrigger className="h-9 w-40 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TELEPHONY_CALLER_IDS.map((did) => (
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
                  {/* The whole account block opens the debtor profile — the same one the agent
                      sees — so a manager can read the history before deciding to call. */}
                  <button
                    type="button"
                    onClick={() => setProfileDebtor(e.debtor as unknown as Debtor)}
                    className="flex-1 min-w-0 text-left rounded-md -mx-1 px-1 py-0.5 transition-colors hover:bg-muted/50 focus:outline-none focus:ring-1 focus:ring-primary"
                    title={`Open ${e.debtor.name}'s profile`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground underline-offset-2 hover:underline">
                        {e.debtor.name}
                      </span>
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
                  </button>
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
      {profileDebtor && <DebtorProfile d={profileDebtor} onClose={() => setProfileDebtor(null)} />}
    </div>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function ManagerQueuePage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const managerName = user?.name ?? "Manager";
  const { activeTeam } = useActiveTeam(managerId);
  const agents = useTeamAgents(activeTeam?.id);
  const [tab, setTab] = useState("live");
  // Admins are org-wide by design; a manager is scoped to their own agents so the badge
  // matches what My Queue actually lists.
  const teamAgentIds = useMemo(
    () => (user?.role === "admin" ? undefined : agents.map((a) => a.id)),
    [user?.role, agents],
  );
  const [openEscalations, setOpenEscalations] = useState(
    () => getOpenEscalationsForAgents(teamAgentIds).length,
  );
  useEffect(() => {
    const reload = () => setOpenEscalations(getOpenEscalationsForAgents(teamAgentIds).length);
    window.addEventListener("escalations-updated", reload);
    refreshEscalations();
    return () => window.removeEventListener("escalations-updated", reload);
  }, []);
  useStorageSync(() => setOpenEscalations(getOpenEscalationsForAgents(teamAgentIds).length));

  // Active-call state lives here (not inside a single tab) so a call started from Agent
  // Live View or My Queue keeps its panel visible even if the manager switches tabs mid-call.
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [activeEscalationId, setActiveEscalationId] = useState<string | null>(null);
  const [disposition, setDisposition] = useState<DispositionForm>(EMPTY_DISPOSITION);
  // Places a real call through the telephony provider (mode: "server") — this used to be a fake
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

  const handleAddPhone = async (phone: string) => {
    if (!activeCall) return;
    try {
      await addDebtorPhone(activeCall.debtor.id, phone);
      setActiveCall((c) =>
        c
          ? { ...c, debtor: { ...c.debtor, altPhones: [...(c.debtor.altPhones ?? []), phone] } }
          : c,
      );
      toast.success("Number added");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add number");
      throw e;
    }
  };

  const handleCallNumber = (phone: string) => {
    if (!activeCall) return;
    startCall({ ...activeCall.debtor, phone }, activeEscalationId);
  };

  const submitDisposition = () => {
    if (!disposition.outcome) {
      toast.error("Select an outcome before submitting");
      return;
    }
    if (activeCall) {
      const debtor = activeCall.debtor;
      const now = new Date();
      const record: DispositionRecord = {
        id: crypto.randomUUID(),
        debtorId: debtor.id,
        debtorName: debtor.name,
        phone: debtor.phone,
        agentId: managerId,
        agentName: managerName,
        portfolioName: debtor.portfolio,
        outcome: disposition.outcome as StoredOutcome,
        reason: disposition.reason || undefined,
        notes: disposition.notes,
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
        dialMode: activeCall.dialMode ?? "single",
        recordingUrl: activeCall.recordingUrl,
        providerCallId: activeCall.providerCallId,
        time: now.toISOString(),
      };
      saveDisposition(record).catch((e) =>
        toast.error(e instanceof Error ? e.message : "Failed to save call outcome"),
      );
      if (activeEscalationId) {
        resolveEscalation(activeEscalationId).catch((e) =>
          toast.error(e instanceof Error ? e.message : "Failed to resolve escalation"),
        );
      }

      // PTP / callback: SMS the debtor and set a reminder, same as the agent-side Call Queue —
      // the shared call modal now previews this SMS before Save & Close, so it has to actually
      // happen here too or the preview would be a lie.
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
            agentId: managerId,
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
        }
      } else {
        toast.success(`Call logged — ${disposition.outcome}`);
      }
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
          <AgentLiveViewTab agents={agents} />
        </TabsContent>
        <TabsContent value="my" className="mt-4">
          <MyQueueTab
            managerId={managerId}
            managerName={managerName}
            startCall={startCall}
            hasActiveCall={!!activeCall}
            teamAgentIds={teamAgentIds}
          />
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
          onMinimize={() => setActiveCall((c) => (c ? { ...c, view: "modal" } : null))}
          onAddPhone={handleAddPhone}
          onCallNumber={handleCallNumber}
        />
      )}
    </div>
  );
}
