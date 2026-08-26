import React, { useState } from "react";
import {
  Phone,
  PhoneCall,
  MessageCircle,
  HandCoins,
  Maximize2,
  Minimize2,
  Minus,
  MicOff,
  Mic,
  PauseCircle,
  PhoneOff,
  UserRoundCog,
  CalendarClock,
  IndianRupee,
  AlertTriangle,
  Clock,
  CheckCheck,
  FileText,
  Banknote,
  ShieldAlert,
  Send,
  Flag,
  EarOff,
  Ear,
  GitMerge,
  PhoneForwarded,
  ArrowRightLeft,
  Hash,
  FileDown,
  Loader2,
  Plus,
  Anchor,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { bucketOf, formatINR, type DPDBucket, BUCKET_META } from "@/lib/mock-debtors";

import {
  OUTCOME_META,
  QUEUE_STATUS_META,
  type CallOutcome,
  type DispositionForm,
  type QueueDebtor,
  type CallControlProps,
} from "@/lib/call-queue/types";
import { exportCSV } from "@/lib/call-queue/mock-data";

import { saveEscalation } from "@/lib/escalation-store";
import { requestRetention, getRetentionRequestsFor } from "@/lib/retention-store";
import type { PtpFollowup } from "@/lib/disposition-store";
import { leftoverExtraKeys } from "@/lib/csv-fields";
import { buildDispositionSms } from "@/lib/sms-templates";

import { toast } from "sonner";
import { TraceSummary } from "@/components/profilex/trace-summary";
import { AssignedAgentLine } from "@/components/assigned-agent";
import { TracePanel } from "@/components/profilex/trace-panel";

// Active-call UI cluster extracted from dashboard.call-queue.tsx: the live-call panel/modal,
// disposition form, PTP tracker, debtor profile sheet, script/recording panels, and the
// escalation modal. Prop-driven presentational components — the route wires them to state.

// ─── Active Call Components ───────────────────────────────────────────────────

// Sub-reasons offered once an agent picks an outcome — free text on the backend
// (call_logs.outcome_reason, requires migrations/20260811_call_logs_outcome_reason.sql), this
// list is what's actually shown, not a schema-enforced enum. Keep in sync with any new
// CallOutcome — an outcome with no entry here just shows no reason dropdown at all.
const OUTCOME_REASONS: Record<CallOutcome, string[]> = {
  paid: [
    "Full payment",
    "Partial payment",
    "Paid via UPI",
    "Paid via bank transfer",
    "Paid in cash",
    "Paid at branch",
  ],
  promised: [
    "Will pay on salary day",
    "Will pay after selling asset",
    "Family will arrange funds",
    "Waiting on reimbursement",
    "Short-term hardship, will clear soon",
  ],
  callback: [
    "Busy at work",
    "Driving / can't talk",
    "In a meeting",
    "Asked to call back later",
    "Bad network, call dropped",
    "Family member requested callback",
  ],
  settlement: [
    "Wants lump-sum discount",
    "Cannot pay full amount",
    "Financial hardship",
    "Job loss",
    "Medical emergency",
  ],
  refused: [
    "Disputes the debt",
    "Claims already paid",
    "Refuses due to harassment claim",
    "Financial inability",
    "Hung up / hostile",
    "Unwilling to discuss",
  ],
  no_answer: [
    "Ringing, no pickup",
    "Switched off",
    "Out of coverage area",
    "Rang twice, no answer",
    "Call got cut",
    "Number busy",
  ],
  voicemail: [
    "Left voicemail",
    "Mailbox full",
    "No voicemail option",
    "Auto-attendant only, no human",
  ],
  dispute: [
    "Wrong amount claimed",
    "Says not their loan",
    "Claims already settled",
    "Fraud / identity theft claim",
    "KYC mismatch",
    "Disputes interest/charges",
  ],
};

function fmtElapsed(s: number) {
  const m = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

/** Inline "add a number" control for the Contact Details card — lets an agent record a number
 * they just learned (from the debtor or a family member) against the debtor's file. Keeps
 * whatever was typed if the save fails (e.g. duplicate number) instead of clearing it. */
function AddPhoneRow({ onAdd }: { onAdd: (phone: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    const trimmed = value.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onAdd(trimmed);
      setValue("");
    } catch {
      // caller already surfaced a toast — leave the input as-is so the agent can fix it
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2 pt-1">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleAdd();
        }}
        placeholder="Add another number…"
        className="h-8 text-sm"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1 flex-shrink-0"
        disabled={!value.trim() || saving}
        onClick={handleAdd}
      >
        {saving ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        Add
      </Button>
    </div>
  );
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
  onAddPhone,
  onCallNumber,
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

  // Every uploaded CSV column that isn't one of our named/mapped fields (loan_id, name, phone,
  // loan_amount, dpd, email, address, city, state, dob, employer, income, language) — shown
  // generically below the mapped Loan Details so nothing from the source file is ever silently
  // dropped mid-call. Empty for mock/demo debtors, which have no _uploadedExtra bag.
  const uploadedExtra =
    (debtor as QueueDebtor & { _uploadedExtra?: Record<string, string> })._uploadedExtra ?? {};
  const otherFields = leftoverExtraKeys([{ extra: uploadedExtra }])
    .map((key) => [key, uploadedExtra[key]] as const)
    .filter(([, value]) => !!value?.trim());

  // Declared before the ringing early-return below so hook count/order stays identical across
  // phase transitions — React can otherwise reuse this component instance (rather than
  // remounting it) between the ringing and connected renders, and a hook declared after an
  // early return would then violate the Rules of Hooks ("Rendered more hooks than during the
  // previous render").
  const [infoTab, setInfoTab] = useState<
    "loan" | "personal" | "insights" | "payments" | "contacts"
  >("loan");
  // Gates Save & Close behind a preview of the SMS that outcome will trigger (PTP/callback
  // only — buildDispositionSms returns null for outcomes that don't send one), so the agent
  // sees exactly what the debtor is about to receive before it actually goes out.
  const [smsPreviewOpen, setSmsPreviewOpen] = useState(false);

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

  // Disposition picker — outcomes grouped into pools (Positive / Difficult), radio-style, with
  // a reason dropdown that appears once an outcome is picked (options depend on which outcome —
  // see OUTCOME_REASONS). `pools` lets the connected-call panel show only the Positive pool
  // (mid-call, "no answer" etc. don't make sense yet) while the ended panel shows both.
  const dispositionPools = (pools: { label: string; cls: string; outcomes: CallOutcome[] }[]) => (
    <div className="space-y-3">
      {pools.map((pool) => (
        <div key={pool.label} className="space-y-2">
          <div
            className={cn(
              "rounded-md py-1 text-center text-[11px] font-bold uppercase tracking-wider",
              pool.cls,
            )}
          >
            {pool.label}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
            {pool.outcomes.map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="radio"
                  name="disposition-outcome"
                  checked={disposition.outcome === o}
                  onChange={() => up({ outcome: o, reason: "" })}
                  className="h-4 w-4 accent-primary cursor-pointer flex-shrink-0"
                />
                <span
                  className={
                    disposition.outcome === o
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {OUTCOME_META[o].label}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {disposition.outcome && OUTCOME_REASONS[disposition.outcome].length > 0 && (
        <div className="space-y-1 pt-1">
          <label className="text-xs text-muted-foreground">Reason</label>
          <Select value={disposition.reason} onValueChange={(v) => up({ reason: v })}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select a reason…" />
            </SelectTrigger>
            <SelectContent>
              {OUTCOME_REASONS[disposition.outcome].map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );

  const POSITIVE_POOL = { label: "Positive Pool", cls: "bg-success/15 text-success" };
  const DIFFICULT_POOL = { label: "Difficult Pool", cls: "bg-destructive/15 text-destructive" };

  // Outcome-specific inputs, shared between the in-call and post-call disposition panels
  const outcomeFields = () => (
    <>
      {disposition.outcome === "promised" && (
        <div className="grid grid-cols-3 gap-3">
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
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Call Back At
            </label>
            <Input
              type="time"
              value={disposition.ptpTime}
              onChange={(e) => up({ ptpTime: e.target.value })}
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

  // What Save & Close is about to trigger — null for outcomes that don't send an SMS at all.
  const smsPreview = buildDispositionSms(disposition.outcome, debtor.name, disposition);
  const handleSaveClose = () => {
    if (smsPreview) setSmsPreviewOpen(true);
    else onSubmit();
  };

  return (
    <>
      <div className="flex flex-col h-full animate-in fade-in slide-in-from-bottom-4 duration-300">
        {/* ── TOP BAR ── */}
        <div className="flex items-center justify-between gap-4 px-6 py-3 border-b border-border bg-card flex-shrink-0 flex-wrap">
          {/* Identity + status */}
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative flex-shrink-0">
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
            <div className="min-w-0">
              <div className="font-semibold text-foreground text-base leading-tight truncate">
                {debtor.name}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {debtor.loanReference ?? debtor.id} · {debtor.phone}
                {debtor.altPhones && debtor.altPhones.length > 0
                  ? ` · ${debtor.altPhones.length} alt number${debtor.altPhones.length === 1 ? "" : "s"}`
                  : ""}
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
              <span className="text-muted-foreground font-medium">
                Ended · {fmtElapsed(elapsed)}
              </span>
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
                  {dispositionPools([{ ...POSITIVE_POOL, outcomes: PRODUCTIVE_OUTCOMES }])}
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
                {dispositionPools([
                  { ...POSITIVE_POOL, outcomes: PRODUCTIVE_OUTCOMES },
                  { ...DIFFICULT_POOL, outcomes: NON_PRODUCTIVE_OUTCOMES },
                ])}
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
                    <span className="text-sm text-destructive font-medium">
                      Escalate to manager
                    </span>
                  </label>
                  <Button
                    className="gap-1.5 px-6"
                    onClick={handleSaveClose}
                    disabled={!disposition.outcome}
                  >
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
                  { key: "insights", label: "Insights" },
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
                        [
                          "Interest Rate",
                          debtor.interestRate ? `${debtor.interestRate}% p.a.` : "—",
                        ],
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
                          <span className="text-foreground font-medium">
                            {debtor.guarantorName}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Other Details — every uploaded column that isn't one of our named/mapped
                    fields above, still under its own literal source-file header. */}
                  {otherFields.length > 0 && (
                    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Other Details{" "}
                        <span className="normal-case font-normal text-muted-foreground/70">
                          (from uploaded file, unmapped)
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                        {otherFields.map(([key, value]) => (
                          <div key={key} className="flex items-center justify-between gap-3">
                            <span className="text-muted-foreground capitalize truncate">
                              {key.replace(/_/g, " ")}
                            </span>
                            <span className="text-foreground font-medium text-right break-all">
                              {value}
                            </span>
                          </div>
                        ))}
                      </div>
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
                    <div className="space-y-1.5">
                      {[
                        { label: "Primary", number: debtor.phone },
                        ...(debtor.altPhones ?? []).map((number, i) => ({
                          label: `Alt ${i + 1}`,
                          number,
                        })),
                      ].map(({ label, number }) => (
                        <div key={label} className="flex items-center justify-between text-sm">
                          <div className="min-w-0">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="ml-2 font-mono text-foreground font-medium">
                              {number}
                            </span>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className="h-7 w-7 flex-shrink-0"
                            disabled={phase !== "ended"}
                            title={
                              phase !== "ended"
                                ? "End the current call to call this number"
                                : `Call ${number}`
                            }
                            onClick={() => onCallNumber(number)}
                          >
                            <Phone className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    <AddPhoneRow onAdd={onAddPhone} />
                    <div className="flex items-center justify-between text-sm pt-1 border-t border-border">
                      <span className="text-muted-foreground">Email</span>
                      <span className="font-mono text-foreground font-medium text-right">
                        {debtor.email ?? "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Last Contacted</span>
                      <span className="font-mono text-foreground font-medium text-right">
                        {debtor.lastContacted ?? "Never"}
                      </span>
                    </div>
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
              {/* Trace — read-only here. An agent mid-call needs the employer and UAN at a
                  glance; running a lookup costs money and stays a manager action. */}
              {infoTab === "insights" && (
                <div className="space-y-4">
                  <TraceSummary debtorId={debtor.id} variant="bare" />
                </div>
              )}

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

      {/* SMS preview — shown before Save & Close for any outcome that triggers one (PTP /
        callback today), so the agent sees exactly what the debtor is about to receive.
        buildDispositionSms is the same function that generates the text actually sent on
        confirm, so this can never drift from reality. */}
      <Dialog open={smsPreviewOpen} onOpenChange={setSmsPreviewOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="h-4 w-4 text-primary" />
              SMS to {debtor.name}
            </DialogTitle>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground leading-relaxed">
            {smsPreview}
          </div>
          <p className="text-xs text-muted-foreground">
            Sent automatically once you confirm and save this disposition.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSmsPreviewOpen(false)}>
              Back
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => {
                setSmsPreviewOpen(false);
                onSubmit();
              }}
            >
              <Send className="h-3.5 w-3.5" />
              Confirm &amp; Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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

export function SectionLabel({ children }: { children: React.ReactNode }) {
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

/** "Today" / "Tomorrow" / "3d overdue" / "25 Jun" — matches the display format the tracker
 * used when its dates were hand-authored mock strings. */
function formatPtpDate(daysLeft: number, iso: string): string {
  if (daysLeft === 0) return "Today";
  if (daysLeft === 1) return "Tomorrow";
  if (daysLeft < 0) return `${Math.abs(daysLeft)}d overdue`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function PTPTracker({
  onCall,
  onView,
  queue,
  followups,
  bucketFilter,
  search,
}: {
  onCall: (d: QueueDebtor) => void;
  onView: (d: QueueDebtor) => void;
  queue: QueueDebtor[];
  followups: PtpFollowup[];
  bucketFilter: DPDBucket | "all";
  search: string;
}) {
  const [filter, setFilter] = useState<"all" | "overdue" | "today" | "tomorrow" | "later">("all");

  // Find the matching QueueDebtor for each PTP follow-up to apply search + display its loan ref
  const rows = followups.filter((p) => {
    const dateOk =
      filter === "all"
        ? true
        : filter === "overdue"
          ? p.daysLeft < 0
          : filter === "today"
            ? p.daysLeft === 0
            : filter === "tomorrow"
              ? p.daysLeft === 1
              : p.daysLeft >= 2;
    if (!dateOk) return false;
    const loanRef = queue.find((d) => d.id === p.debtorId)?.loanReference ?? p.debtorId;
    // Apply search
    const q = search.trim().toLowerCase();
    if (
      q &&
      !p.debtorName.toLowerCase().includes(q) &&
      !loanRef.toLowerCase().includes(q) &&
      !p.phone.includes(q)
    )
      return false;
    // Apply bucket filter — dpd is captured on the disposition itself, no queue lookup needed
    if (bucketFilter !== "all" && p.dpd != null && bucketOf(p.dpd) !== bucketFilter) return false;
    return true;
  });

  const overdueCount = followups.filter((p) => p.daysLeft < 0).length;
  const todayCount = followups.filter((p) => p.daysLeft === 0).length;
  const tomorrowCount = followups.filter((p) => p.daysLeft === 1).length;
  const laterCount = followups.filter((p) => p.daysLeft >= 2).length;
  const totalAmount = followups.reduce((s, p) => s + p.ptpAmount, 0);

  return (
    <section>
      <SectionLabel>PTP Follow-up Tracker</SectionLabel>

      <div className="mt-3 space-y-3">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Overdue", value: overdueCount, cls: "text-destructive" },
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
              { key: "all", label: "All", count: followups.length },
              { key: "overdue", label: "Overdue", count: overdueCount },
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
                rows.map((p) => [
                  p.debtorName,
                  queue.find((q) => q.id === p.debtorId)?.loanReference ?? p.debtorId,
                  p.phone,
                  p.ptpAmount,
                  formatPtpDate(p.daysLeft, p.ptpDateIso),
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
                    const matched = queue.find((q) => q.id === p.debtorId);
                    const loanRef = matched?.loanReference ?? p.debtorId;
                    return (
                      <TableRow key={p.id} className="hover:bg-primary/5">
                        <TableCell>
                          <div className="font-medium text-sm">{p.debtorName}</div>
                          <div className="text-[11px] text-muted-foreground">{loanRef}</div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {p.phone}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-blue-600 text-sm">
                          {formatINR(p.ptpAmount)}
                        </TableCell>
                        <TableCell>
                          <span className={cn("text-xs font-semibold", urgency)}>
                            {formatPtpDate(p.daysLeft, p.ptpDateIso)}
                            {p.ptpTime && (
                              <span className="ml-1 font-normal text-muted-foreground">
                                · {p.ptpTime}
                              </span>
                            )}
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
                                const d: QueueDebtor = matched ?? {
                                  id: p.debtorId,
                                  name: p.debtorName,
                                  phone: p.phone,
                                  loanAmount: p.ptpAmount,
                                  dpd: p.dpd ?? 0,
                                  aiScore: 7,
                                  scoreReason: p.notes,
                                  lastContacted: null,
                                  portfolio: "PTP Follow-up",
                                  language: "English",
                                  queueStatus: "ptp",
                                  scheduledAt: p.ptpDateIso,
                                  ptpAmount: p.ptpAmount,
                                  loanReference: p.debtorId,
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

export function DebtorProfileSheet({
  debtor,
  onCall,
}: {
  debtor: QueueDebtor;
  onCall: (d: QueueDebtor) => void;
}) {
  const extra = getDebtorExtra(debtor.id);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retentionReason, setRetentionReason] = useState("");
  const [retentionSubmitting, setRetentionSubmitting] = useState(false);
  // Cached from Supabase (retention-store.ts), newest first — reflects the debtor's own last
  // known state, refreshed whenever a request is raised/reviewed, so this stays accurate
  // without a live query. Only the LATEST request matters: an older rejected/not_honored one
  // shouldn't block a fresh ask, but an in-flight one (still pending, or already approved/sent
  // and just waiting on the bank's next file) should — no point letting an agent duplicate it.
  const latestRetentionRequest = getRetentionRequestsFor(debtor.id)[0];
  const inFlightRetention =
    latestRetentionRequest &&
    (["pending_manager", "approved", "sent_to_bank"] as const).includes(
      latestRetentionRequest.status as "pending_manager" | "approved" | "sent_to_bank",
    )
      ? latestRetentionRequest
      : undefined;
  const RETENTION_STATUS_LABEL: Record<string, string> = {
    pending_manager: "Retention requested · awaiting manager",
    approved: "Retention approved · awaiting export to bank",
    sent_to_bank: "Retention sent to bank · awaiting next cycle",
  };

  const submitRetention = async () => {
    if (!debtor.portfolioId) {
      toast.error("This debtor isn't tied to a portfolio — nothing to request retention for.");
      return;
    }
    setRetentionSubmitting(true);
    try {
      await requestRetention({
        debtorId: debtor.id,
        portfolioId: debtor.portfolioId,
        reason: retentionReason.trim(),
      });
      toast.success("Retention requested — awaiting manager review");
      setRetentionOpen(false);
      setRetentionReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to request retention");
    } finally {
      setRetentionSubmitting(false);
    }
  };

  // debtorFromRow() (portfolio-store.ts) stashes every raw CSV column here for real debtors —
  // rendered generically below the named fields, same approach as the debtor profile page.
  // getDebtorExtra()'s DEBTOR_EXTRA table only ever matches a couple of hardcoded mock IDs, so
  // without this every real debtor fell into its fallback and showed a fabricated "Axis Bank /
  // Personal Loan" as if it were their actual lender.
  const csvFields =
    (debtor as QueueDebtor & { _uploadedExtra?: Record<string, string> })._uploadedExtra ?? {};
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
        {/* SheetContent already renders its own top-right close (×) — no second one here */}
        <div className="flex items-center gap-3 pr-8">
          <div className="h-11 w-11 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
            {initials}
          </div>
          <div>
            <SheetTitle className="text-base">{debtor.name}</SheetTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {debtor.loanReference ?? debtor.id} · {debtor.phone} · {debtor.language}
            </p>
            <AssignedAgentLine debtorId={debtor.id} />
          </div>
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
          {
            label: "Principal Amount",
            value: csvFields["pos"] || csvFields["Principal"] || "—",
            cls: "text-foreground truncate",
          },
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
            {["overview", "calls", "insights", "messages", "payments", "disputes"].map((t) => (
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
                  ["Lender", debtor.lender || "—"],
                  ["Product", debtor.loanType || "—"],
                  ["Portfolio", debtor.portfolio],
                  ["DPD", String(debtor.dpd)],
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
                {/* Every other raw CSV column, same generic dump as the debtor profile page */}
                {Object.entries(csvFields).map(([col, val]) => (
                  <div key={col}>
                    <div className="text-xs text-muted-foreground capitalize">
                      {col.replace(/_/g, " ")}
                    </div>
                    <div className="font-medium text-foreground mt-0.5 break-all">{val || "—"}</div>
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
          {/* Trace — the full panel, same as the debtors page: a manager opening a debtor from
              the call queue can run a lookup here, an agent sees the result read-only. */}
          <TabsContent value="insights" className="flex-1 overflow-y-auto px-6 py-4 mt-0">
            <TracePanel debtorId={debtor.id} debtorName={debtor.name} />
          </TabsContent>

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
        {debtor.retained ? (
          <Badge
            variant="outline"
            className="h-8 gap-1.5 border-violet-400/40 bg-violet-500/10 px-3 text-violet-500"
          >
            <Anchor className="h-3.5 w-3.5" />
            Retained · from {debtor.retainedFrom ?? "previous cycle"}
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
        )}
      </div>

      {/* Request Retention dialog — asks the manager to keep this account into the next
          portfolio cycle instead of it being recalled by the bank. See retention-store.ts. */}
      <Dialog open={retentionOpen} onOpenChange={setRetentionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request Retention</DialogTitle>
            <DialogDescription>
              Ask your manager to request the bank keep <strong>{debtor.name}</strong> in the next
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

export function EscalationModal({
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
