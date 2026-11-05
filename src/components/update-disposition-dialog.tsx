// "Update disposition" on the debtor profile: change an account's disposition WITHOUT calling
// the borrower — e.g. the call dropped and was saved as Callback, then the borrower confirms a
// PTP over another channel. Saved as a new call_logs row with dial_mode 'no_call' (agents have
// no UPDATE on call_logs, and the earlier disposition stays in the history as it was). Being
// the latest row, it becomes the account's current disposition for the queue, follow-ups and
// escalations.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { saveDisposition, type DispositionRecord } from "@/lib/disposition-store";
import { saveReminder } from "@/lib/reminder-store";
import { OUTCOME_META, OUTCOME_REASONS, type CallOutcome } from "@/lib/call-queue/types";
import { formatINR, type Debtor } from "@/lib/mock-debtors";
import { todayIstKey } from "@/lib/date-filter";
import { errorText } from "@/lib/app-error";

const OUTCOMES = Object.keys(OUTCOME_META) as CallOutcome[];

export function UpdateDispositionDialog({
  d,
  open,
  onOpenChange,
  current,
}: {
  d: Debtor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account's latest disposition, shown for reference. */
  current?: DispositionRecord;
}) {
  const { user } = useAuth();
  const [outcome, setOutcome] = useState<CallOutcome | "">("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setOutcome("");
    setReason("");
    setAmount("");
    setDate("");
    setTime("");
    setNotes("");
  };

  const needsDate = outcome === "promised" || outcome === "callback";
  const needsAmount = outcome === "promised" || outcome === "paid";
  const today = todayIstKey();

  const save = async () => {
    if (!user) return;
    if (!outcome) return toast.error("Pick the new disposition");
    const amt = amount ? parseFloat(amount) : undefined;
    if (needsAmount && !(amt && amt > 0)) return toast.error("Enter the amount");
    if (needsDate && !date) return toast.error("Enter the date");
    if (needsDate && date < today) return toast.error("The date can't be in the past");

    const auto =
      outcome === "promised"
        ? `PTP for ${formatINR(amt ?? 0)} on ${date}${time ? ` at ${time}` : ""}`
        : outcome === "callback"
          ? `Callback scheduled for ${date}${time ? ` at ${time}` : ""}`
          : outcome === "paid"
            ? `Paid ${formatINR(amt ?? 0)}`
            : OUTCOME_META[outcome].label;
    const note = ["Updated without a call", auto, reason, notes.trim()].filter(Boolean).join(" — ");
    const nowIso = new Date().toISOString();

    setSaving(true);
    try {
      await saveDisposition({
        id: crypto.randomUUID(),
        debtorId: d.id,
        debtorName: d.name,
        phone: d.phone,
        agentId: user.email,
        agentName: user.name,
        portfolioId: d.portfolioId,
        portfolioName: d.portfolio,
        outcome,
        reason: reason || undefined,
        notes: note,
        ptpAmount: outcome === "promised" ? amt : undefined,
        ptpDate: outcome === "promised" ? date : undefined,
        ptpTime: outcome === "promised" ? time || undefined : undefined,
        callbackDate: outcome === "callback" ? date : undefined,
        callbackTime: outcome === "callback" ? time || undefined : undefined,
        paidAmount: outcome === "paid" ? amt : undefined,
        loanAmount: d.loanAmount,
        dpd: d.dpd,
        dialMode: "no_call",
        time: nowIso,
      });
      if (needsDate) {
        const isPtp = outcome === "promised";
        await saveReminder({
          id: crypto.randomUUID(),
          agentId: user.email,
          debtorId: d.id,
          debtorName: d.name,
          phone: d.phone,
          kind: isPtp ? "ptp" : "callback",
          amount: isPtp ? amt : undefined,
          dueDate: date,
          dueTime: time || undefined,
          message: isPtp
            ? `PTP due — ${d.name} promised ${formatINR(amt ?? 0)} for ${date}${time ? ` at ${time}` : ""}`
            : `Callback due — ${d.name} on ${date}${time ? ` at ${time}` : ""}`,
          createdAt: nowIso,
        }).catch((e) => toast.error(errorText(e, "Disposition saved, but the reminder failed")));
      }
      toast.success(`Disposition updated to ${OUTCOME_META[outcome].label}`);
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorText(e, "Failed to update disposition"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update disposition</DialogTitle>
          <DialogDescription>
            For {d.name}, without calling. The earlier disposition stays in the call history; this
            one becomes the current one.
          </DialogDescription>
        </DialogHeader>

        {current && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Current:{" "}
            <span className="font-medium text-foreground">
              {OUTCOME_META[current.outcome as CallOutcome]?.label ?? current.outcome}
            </span>
            {current.reason && <> · {current.reason}</>} ·{" "}
            {new Date(current.time).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">New disposition</Label>
              <Select
                value={outcome}
                onValueChange={(v) => {
                  setOutcome(v as CallOutcome);
                  setReason("");
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {OUTCOMES.map((o) => (
                    <SelectItem key={o} value={o}>
                      {OUTCOME_META[o].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason</Label>
              <Select value={reason} onValueChange={setReason} disabled={!outcome}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  {(outcome ? OUTCOME_REASONS[outcome] : []).map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {needsAmount && (
            <div className="space-y-1">
              <Label className="text-xs">
                {outcome === "paid" ? "Amount paid" : "PTP amount"} (₹)
              </Label>
              <Input
                type="number"
                min={0}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-9"
              />
            </div>
          )}

          {needsDate && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">
                  {outcome === "promised" ? "PTP date" : "Callback date"}
                </Label>
                <Input
                  type="date"
                  min={today}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Time</Label>
                <Input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="h-9"
                />
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Note</Label>
            <Textarea
              rows={3}
              placeholder="e.g. Borrower confirmed PTP on WhatsApp"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !outcome}>
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
