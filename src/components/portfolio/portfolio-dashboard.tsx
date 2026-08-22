import { useState } from "react";
import {
  transferDebtor,
  transferDebtors,
  removeDebtor,
  restoreDebtor,
  getRemovedDebtors,
  type UploadedPortfolio,
  type UploadedDebtor,
  type PortfolioSettings,
  type RemovedDebtor,
} from "@/lib/portfolio-store";
import {
  Briefcase,
  AlertTriangle,
  Shuffle,
  Loader2,
  ArrowLeftRight,
  Pencil,
  Trash2,
  RotateCcw,
  Upload,
  Landmark,
  Anchor,
  Send,
  Check,
  X,
  Bot,
  PhoneCall,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv-export";
import {
  getRetentionRequests,
  refreshRetentionRequests,
  reviewRetentionRequest,
  markRetentionRequestsSent,
  type RetentionRequest,
} from "@/lib/retention-store";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import { OUTCOME_META } from "@/lib/call-queue/types";
import { getAgentById, type AgentRef } from "@/lib/team-store";
import { getDispositionsByPortfolio, calcStats, type CallOutcome } from "@/lib/disposition-store";
import { getPortfolioRecovered } from "@/lib/payments-store";

export interface Portfolio {
  id: string;
  name: string;
  lender: string;
  uploadedOn: string;
  totalAccounts: number;
  assignedAccounts: number;
  buckets: Record<DPDBucket, number>;
  totalOutstanding: number;
  recovered: number;
  /** The slice of `recovered` that arrived via a bank paid-file upload rather than an agent
   * collection. Surfaced on the Recovered KPI so an upload is visibly reflected. */
  recoveredBankReported: number;
  ptpCount: number;
  contactRate: number;
  agents: string[];
  status: "active" | "completed" | "stale";
}

export const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

export const STATUS_META = {
  active: { label: "Partially Assigned", bg: "bg-primary/8 text-primary/80 border-primary/15" },
  completed: { label: "Fully Assigned", bg: "bg-success/8 text-success/80 border-success/15" },
  stale: { label: "Unassigned", bg: "bg-orange-500/8 text-orange-600/80 border-orange-400/15" },
};

// Display labels for PortfolioSettings.dialerMode — matches the rename in dashboard.call-queue
// (internal values "predictive"/"productive" kept as-is; only the on-screen label changed).
const DIALER_MODE_LABEL: Record<string, string> = {
  predictive: "Productive Dial",
  productive: "Progressive Dial",
  preview: "Preview Dial",
  power: "Power Dial",
  manual: "Manual",
};

/* ─── helpers ────────────────────────────────────────────────────────────── */

export function formatINR(n: number) {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
}

// Real assignment + recovery stats for a portfolio, computed from each debtor's
// assigned_agent_id (folded into portfolio-store.ts) + dispositions
export function toPortfolio(u: UploadedPortfolio): Portfolio {
  const buckets = u.rows.reduce<Record<DPDBucket, number>>(
    (acc, r) => {
      acc[r.bucket] = (acc[r.bucket] ?? 0) + 1;
      return acc;
    },
    { X: 0, "1": 0, "2": 0, NPA: 0, WriteOff: 0 },
  );
  const totalOutstanding = u.rows.reduce((s, r) => s + r.loanAmount, 0);

  const debtorIdsByAgent = new Map<string, string[]>();
  for (const r of u.rows) {
    if (!r.assignedAgentId) continue;
    const arr = debtorIdsByAgent.get(r.assignedAgentId) ?? [];
    arr.push(r.id);
    debtorIdsByAgent.set(r.assignedAgentId, arr);
  }
  const assignedAccounts = Array.from(debtorIdsByAgent.values()).reduce(
    (s, ids) => s + ids.length,
    0,
  );
  const agents = Array.from(debtorIdsByAgent.keys()).map(
    (email) => getAgentById(email)?.name ?? email,
  );

  // Group by portfolio rather than walking each assigned agent's dispositions. The per-agent
  // walk kept a call only when the caller IS the debtor's currently-assigned agent, so it
  // dropped calls on since-unassigned debtors, calls by an agent since moved off the account,
  // and calls by a manager (who has no debtors assigned to them at all). Observed live on
  // 2026-08-22: it hid two of nine calls on portfolio 04f1fdec — including a ₹1,000 payment —
  // reading 71% contact where the real figure was 78%.
  const stats = calcStats(getDispositionsByPortfolio(u.id));
  const recoveredSplit = getPortfolioRecovered(u.id);

  const status: Portfolio["status"] =
    assignedAccounts === 0 ? "stale" : assignedAccounts >= u.rows.length ? "completed" : "active";

  return {
    id: u.id,
    name: u.name,
    lender: u.lender,
    uploadedOn: u.uploadedAt.slice(0, 10),
    totalAccounts: u.rows.length,
    assignedAccounts,
    buckets,
    totalOutstanding,
    // From the payments table, not stats.paidAmount — see getPortfolioRecovered. A call-logged
    // "paid" writes a payments row too, so this covers agent collections *and* bank-reported
    // paid-file uploads without double-counting either.
    recovered: recoveredSplit.total,
    recoveredBankReported: recoveredSplit.bankReported,
    ptpCount: stats.ptps,
    contactRate: stats.contactRate,
    agents,
    status,
  };
}

/* ─── summary stat card ─────────────────────────────────────────────────── */

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof Briefcase;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0",
            accent ?? "bg-primary/8",
          )}
        >
          <Icon className={cn("h-4 w-4", accent ? "text-white/80" : "text-primary/70")} />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold text-foreground leading-tight">{value}</div>
          {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── portfolio detail drawer ───────────────────────────────────────────── */

const UNASSIGNED = "__unassigned__";

/** Per-account transfer control — moves one debtor to a different agent (or unassigns them)
 * without re-splitting the rest of the portfolio, unlike the bulk Reassign dialog. */
/** debtors.status in the Accounts table. Without this column a debtor marked paid — by a
 * disposition or by the bank's paid-file upload (applyBulkPaidFile) — looked identical to an
 * active one, which is most of why a paid-file upload appeared to do nothing at all. */
function DebtorStatusBadge({ status }: { status?: string }) {
  const meta: Record<string, { label: string; cls: string }> = {
    paid: { label: "Paid", cls: "bg-success/10 text-success border-success/20" },
    settled: { label: "Settled", cls: "bg-success/10 text-success border-success/20" },
    disputed: { label: "Disputed", cls: "bg-orange-500/10 text-orange-600 border-orange-400/20" },
  };
  const m = meta[status ?? ""];
  if (!m) return <span className="text-[10px] text-muted-foreground">Active</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

function AccountsTable({ rows, agents }: { rows: UploadedDebtor[]; agents: AgentRef[] }) {
  const [transferringId, setTransferringId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<UploadedDebtor | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAgent, setBulkAgent] = useState<string>(UNASSIGNED);
  const [bulkMoving, setBulkMoving] = useState(false);

  const handleTransfer = async (debtorId: string, value: string) => {
    setTransferringId(debtorId);
    try {
      await transferDebtor(debtorId, value === UNASSIGNED ? null : value);
      toast.success("Account transferred");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to transfer account");
    } finally {
      setTransferringId(null);
    }
  };

  const handleRemove = async () => {
    if (!confirmRemove) return;
    setRemovingId(confirmRemove.id);
    try {
      await removeDebtor(confirmRemove.id);
      toast.success("Account removed", {
        description: `${confirmRemove.name} — restore it any time from Removed Accounts`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove account");
    } finally {
      setRemovingId(null);
      setConfirmRemove(null);
    }
  };

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  };

  const handleBulkMove = async () => {
    setBulkMoving(true);
    try {
      const ids = Array.from(selected);
      await transferDebtors(ids, bulkAgent === UNASSIGNED ? null : bulkAgent);
      toast.success(`${ids.length} account${ids.length === 1 ? "" : "s"} transferred`);
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to transfer accounts");
    } finally {
      setBulkMoving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <ArrowLeftRight className="h-3.5 w-3.5" />
          Accounts · transfer individually or select several
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">{selected.size} selected</span>
            <Select value={bulkAgent} onValueChange={setBulkAgent}>
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-7 gap-1 text-[11px]"
              disabled={bulkMoving}
              onClick={handleBulkMove}
            >
              {bulkMoving && <Loader2 className="h-3 w-3 animate-spin" />}
              Move
            </Button>
          </div>
        )}
      </div>
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-border">
                <th className="py-2 pl-3 w-8">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                </th>
                <th className="py-2 text-left font-medium text-muted-foreground">Debtor</th>
                <th className="py-2 text-right font-medium text-muted-foreground">Outstanding</th>
                <th className="py-2 pl-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="py-2 pr-3 text-left font-medium text-muted-foreground">
                  Assigned to
                </th>
                <th className="py-2 pr-3 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? "bg-primary/5" : undefined}>
                  <td className="py-2 pl-3">
                    <Checkbox
                      checked={selected.has(r.id)}
                      onCheckedChange={() => toggleRow(r.id)}
                    />
                  </td>
                  <td className="py-2">
                    <div className="font-medium text-foreground">{r.name}</div>
                    <div className="text-[10px] text-muted-foreground">{r.loanReference}</div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatINR(r.loanAmount)}</td>
                  <td className="py-2 pl-3">
                    <DebtorStatusBadge status={r.status} />
                  </td>
                  <td className="py-2 pr-3">
                    <Select
                      value={r.assignedAgentId ?? UNASSIGNED}
                      disabled={transferringId === r.id}
                      onValueChange={(v) => handleTransfer(r.id, v)}
                    >
                      <SelectTrigger className="h-7 w-40 text-xs">
                        {transferringId === r.id ? (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Saving…
                          </span>
                        ) : (
                          <SelectValue />
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                        {agents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      type="button"
                      title="Remove account"
                      disabled={removingId === r.id}
                      onClick={() => setConfirmRemove(r)}
                      className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                    >
                      {removingId === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmRemove?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This takes them out of the call queue, portfolio counts, and assignment — but keeps
              their call/payment/message history intact. You can bring them back any time from
              Removed Accounts below.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove}>Yes, remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Lists soft-removed debtors for one portfolio, on demand, with a one-click Restore. */
function RemovedAccountsPanel({ portfolioId }: { portfolioId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [removed, setRemoved] = useState<RemovedDebtor[] | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setRemoved(await getRemovedDebtors(portfolioId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load removed accounts");
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && removed === null) load();
      return next;
    });
  };

  const handleRestore = async (d: RemovedDebtor) => {
    setRestoringId(d.id);
    try {
      await restoreDebtor(d.id);
      toast.success("Account restored", { description: d.name });
      setRemoved((prev) => (prev ? prev.filter((x) => x.id !== d.id) : prev));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to restore account");
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground uppercase tracking-wider transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Removed Accounts
      </button>
      {expanded && (
        <div className="mt-2 rounded-lg border border-border overflow-hidden">
          {loading ? (
            <div className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : removed && removed.length > 0 ? (
            <div className="max-h-48 overflow-y-auto divide-y divide-border">
              {removed.map((d) => (
                <div key={d.id} className="flex items-center justify-between px-3 py-2 text-xs">
                  <div>
                    <div className="font-medium text-foreground">{d.name}</div>
                    <div className="text-[10px] text-muted-foreground">{d.loanReference}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 gap-1 text-[11px]"
                    disabled={restoringId === d.id}
                    onClick={() => handleRestore(d)}
                  >
                    {restoringId === d.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="p-3 text-xs text-muted-foreground">No removed accounts.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Manager review for retention requests raised against this portfolio (see
 * src/lib/retention-store.ts). Mirrors RemovedAccountsPanel's collapsible shape: pending
 * requests get Approve/Reject, approved ones get bundled into a CSV export that also marks
 * them sent_to_bank, and sent/resolved ones are shown read-only — 'carried'/'not_honored'
 * only ever get set automatically, by reconcileRetainedDebtors() at the next upload. */
function RetentionRequestsPanel({ portfolioId }: { portfolioId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<RetentionRequest[]>(() =>
    getRetentionRequests().filter((r) => r.portfolioId === portfolioId),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      await refreshRetentionRequests();
      setRequests(getRetentionRequests().filter((r) => r.portfolioId === portfolioId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load retention requests");
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      if (next) load();
      return next;
    });
  };

  const pending = requests.filter((r) => r.status === "pending_manager");
  const approved = requests.filter((r) => r.status === "approved");
  const sent = requests.filter((r) => r.status === "sent_to_bank");
  const resolved = requests.filter((r) => r.status === "carried" || r.status === "not_honored");

  const handleReview = async (r: RetentionRequest, decision: "approved" | "rejected") => {
    setBusyId(r.id);
    try {
      await reviewRetentionRequest(r.id, decision);
      setRequests(getRetentionRequests().filter((x) => x.portfolioId === portfolioId));
      toast.success(decision === "approved" ? "Retention approved" : "Retention rejected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update request");
    } finally {
      setBusyId(null);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportAndSend = async () => {
    const toSend = approved.filter((r) => selected.has(r.id));
    if (!toSend.length) return;
    downloadCsv(
      `retention-requests-${portfolioId}.csv`,
      ["Loan Reference", "Debtor Name", "Phone", "Reason", "Requested On"],
      toSend.map((r) => [
        r.loanReference ?? r.debtorId,
        r.debtorName,
        r.debtorPhone,
        r.reason,
        new Date(r.createdAt).toLocaleDateString("en-IN"),
      ]),
    );
    try {
      await markRetentionRequestsSent(toSend.map((r) => r.id));
      setRequests(getRetentionRequests().filter((x) => x.portfolioId === portfolioId));
      setSelected(new Set());
      toast.success(
        `Exported ${toSend.length} account${toSend.length === 1 ? "" : "s"} — marked as sent to bank`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Exported, but failed to mark as sent");
    }
  };

  const total = requests.length;

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground uppercase tracking-wider transition-colors"
      >
        <Anchor className="h-3.5 w-3.5" />
        Retention Requests
        {total > 0 && <span className="text-[10px] normal-case tracking-normal">({total})</span>}
      </button>
      {expanded && (
        <div className="mt-2 rounded-lg border border-border overflow-hidden">
          {loading ? (
            <div className="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : total === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">No retention requests yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {pending.length > 0 && (
                <div className="p-3 space-y-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Awaiting your review · {pending.length}
                  </p>
                  {pending.map((r) => (
                    <div key={r.id} className="flex items-start justify-between gap-3 text-xs">
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate">{r.debtorName}</div>
                        <div className="text-[10px] text-muted-foreground truncate">
                          {r.loanReference} · requested by {r.requestedBy || "—"}
                        </div>
                        {r.reason && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 italic">
                            "{r.reason}"
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 text-[11px] border-success/40 text-success"
                          disabled={busyId === r.id}
                          onClick={() => handleReview(r, "approved")}
                        >
                          <Check className="h-3 w-3" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 text-[11px] border-destructive/40 text-destructive"
                          disabled={busyId === r.id}
                          onClick={() => handleReview(r, "rejected")}
                        >
                          <X className="h-3 w-3" /> Reject
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {approved.length > 0 && (
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Approved — ready to send to bank · {approved.length}
                    </p>
                    <Button
                      size="sm"
                      className="h-6 gap-1 text-[11px] flex-shrink-0"
                      disabled={!selected.size}
                      onClick={exportAndSend}
                    >
                      <Send className="h-3 w-3" /> Export & Mark Sent ({selected.size})
                    </Button>
                  </div>
                  {approved.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 text-xs cursor-pointer">
                      <Checkbox
                        checked={selected.has(r.id)}
                        onCheckedChange={() => toggleSelected(r.id)}
                      />
                      <span className="font-medium text-foreground">{r.debtorName}</span>
                      <span className="text-[10px] text-muted-foreground">{r.loanReference}</span>
                    </label>
                  ))}
                </div>
              )}

              {sent.length > 0 && (
                <div className="p-3 space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Sent to bank — awaiting next cycle · {sent.length}
                  </p>
                  {sent.map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-xs">
                      <span className="text-foreground">{r.debtorName}</span>
                      <span className="text-[10px] text-muted-foreground">
                        sent{" "}
                        {r.sentToBankAt
                          ? new Date(r.sentToBankAt).toLocaleDateString("en-IN")
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {resolved.length > 0 && (
                <div className="p-3 space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Resolved · {resolved.filter((r) => r.status === "carried").length} carried
                    forward, {resolved.filter((r) => r.status === "not_honored").length} not honored
                  </p>
                  {resolved.map((r) => (
                    <div key={r.id} className="flex items-center justify-between text-xs">
                      <span className="text-foreground">{r.debtorName}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          r.status === "carried"
                            ? "border-success/40 text-success"
                            : "border-muted-foreground/40 text-muted-foreground",
                        )}
                      >
                        {r.status === "carried" ? "Carried forward" : "Not honored"}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** AI call agent involvement + dialing mode, computed from this portfolio's own call log
 * dispositions (getDispositionsByPortfolio) — real per-call data, not a portfolio setting.
 * Works the same for an old/closed portfolio: dispositions are never deleted, so this always
 * reflects the portfolio's actual last-known call history, whatever its current status. */
function CallActivitySection({
  portfolioId,
  dialerMode,
}: {
  portfolioId: string;
  dialerMode?: string;
}) {
  const disps = getDispositionsByPortfolio(portfolioId);
  const total = disps.length;
  const aiHandled = disps.filter(
    (d) => d.callType === "ai" || d.callType === "ivr" || d.callType === "bot",
  ).length;
  const humanHandled = total - aiHandled;
  const aiPct = total > 0 ? Math.round((aiHandled / total) * 100) : 0;

  const outcomeCounts = disps.reduce<Partial<Record<CallOutcome, number>>>((acc, d) => {
    acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
        Call Activity &amp; AI Performance
      </div>
      <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-4">
        {total === 0 ? (
          <p className="text-xs text-muted-foreground">
            No calls logged against this portfolio yet.
          </p>
        ) : (
          <>
            {/* AI vs human handling */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Bot className="h-3.5 w-3.5" />
                  AI Call Agent handled
                </span>
                <span className="font-medium text-foreground">
                  {aiHandled} / {total} calls ({aiPct}%)
                </span>
              </div>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-violet-500" style={{ width: `${aiPct}%` }} />
                <div
                  className="h-full bg-primary/50"
                  style={{ width: `${total > 0 ? 100 - aiPct : 0}%` }}
                />
              </div>
              <div className="mt-1 flex items-center gap-4 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                  AI / IVR — {aiHandled}
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary/50" />
                  Human agent — {humanHandled}
                </span>
              </div>
            </div>

            {/* Outcome breakdown */}
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
                Outcomes logged
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(outcomeCounts) as CallOutcome[]).map((outcome) => (
                  <span
                    key={outcome}
                    className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-foreground"
                  >
                    {OUTCOME_META[outcome].label} {outcomeCounts[outcome]}
                    <span className="ml-1 text-muted-foreground">
                      ({Math.round(((outcomeCounts[outcome] ?? 0) / total) * 100)}%)
                    </span>
                  </span>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Configured dialing mode — a portfolio-level setting, not a per-call percentage:
            individual calls don't record which dial mode placed them yet. */}
        {dialerMode && (
          <div className="flex items-center gap-2 border-t border-border pt-3 text-xs">
            <PhoneCall className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              Dialing mode configured for this portfolio:
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 font-medium text-foreground">
              <Activity className="h-3 w-3" />
              {DIALER_MODE_LABEL[dialerMode] ?? dialerMode}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Full-screen portfolio dashboard — shared by Manager Portfolio Overview and Admin Portfolio
// Assignment, so opening a portfolio looks and behaves the same in both portals. The
// edit/reassign/upload-paid actions are manager-only workflows: pass the handlers to enable
// them (manager) or omit them to render a read-only view (admin). Reads whatever is currently
// stored for the portfolio, so an old/completed portfolio shows its real last-known state —
// nothing here depends on the portfolio still being "active".
export function PortfolioDetail({
  p,
  raw,
  agents,
  onClose,
  onReassign,
  onEdit,
  onUploadPaid,
}: {
  p: Portfolio;
  raw: UploadedPortfolio | null;
  agents: AgentRef[];
  onClose: () => void;
  onReassign?: () => void;
  onEdit?: () => void;
  onUploadPaid?: () => void;
}) {
  const recoveryPct =
    p.totalOutstanding > 0 ? ((p.recovered / p.totalOutstanding) * 100).toFixed(1) : "0.0";
  const assignPct =
    p.totalAccounts > 0 ? Math.round((p.assignedAccounts / p.totalAccounts) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background animate-in fade-in duration-150">
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-5 py-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  STATUS_META[p.status].bg,
                )}
              >
                {STATUS_META[p.status].label}
              </span>
              <div className="text-sm font-semibold text-foreground">{p.name}</div>
            </div>
            <div className="text-xs text-muted-foreground">
              {p.lender} · {p.id} · Uploaded {p.uploadedOn}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {onUploadPaid && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={onUploadPaid}
                title="Upload the bank's daily paid-status file for this portfolio"
              >
                <Landmark className="h-3 w-3" />
                Upload Paid File
              </Button>
            )}
            {onEdit && (
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onEdit}>
                <Pencil className="h-3 w-3" />
                Edit
              </Button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground text-xs border border-border rounded px-2 py-1"
            >
              ✕ Close
            </button>
          </div>
        </div>

        <div className="mx-auto max-w-5xl p-5 space-y-5">
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total Outstanding", val: formatINR(p.totalOutstanding) },
              {
                label: "Recovered",
                val: formatINR(p.recovered),
                sub:
                  p.recoveredBankReported > 0
                    ? `${recoveryPct}% of total · ${formatINR(p.recoveredBankReported)} via bank file`
                    : `${recoveryPct}% of total`,
              },
              { label: "PTPs Secured", val: String(p.ptpCount) },
              { label: "Contact Rate", val: `${p.contactRate}%` },
            ].map(({ label, val, sub }) => (
              <div key={label} className="rounded-lg border border-border bg-muted/10 p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {label}
                </div>
                <div className="text-base font-semibold text-foreground">{val}</div>
                {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
              </div>
            ))}
          </div>

          {/* Recovery progress */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">Recovery progress</span>
              <span className="font-medium text-foreground">{recoveryPct}%</span>
            </div>
            <Progress value={parseFloat(recoveryPct)} className="h-2" />
          </div>

          {/* Assignment progress */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">Accounts assigned</span>
              <span className="font-medium text-foreground">
                {p.assignedAccounts} / {p.totalAccounts}
              </span>
            </div>
            <Progress
              value={assignPct}
              className="h-2"
              indicatorClassName={assignPct < 50 ? "bg-orange-500/70" : undefined}
            />
          </div>

          {/* Call activity & AI performance */}
          <CallActivitySection portfolioId={p.id} dialerMode={raw?.settings.dialerMode} />

          {/* Bucket breakdown */}
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
              Bucket breakdown
            </div>
            <div className="space-y-2">
              {BUCKET_ORDER.filter((b) => p.buckets[b] > 0).map((b) => {
                const meta = BUCKET_META[b];
                const pct = Math.round((p.buckets[b] / p.totalAccounts) * 100);
                return (
                  <div key={b} className="flex items-center gap-3">
                    <span
                      className={cn(
                        "text-[10px] font-medium w-20 flex-shrink-0",
                        meta.color.split(" ").find((c) => c.startsWith("text-")),
                      )}
                    >
                      {meta.label}
                    </span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary/50"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground w-16 text-right flex-shrink-0">
                      {p.buckets[b]} ({pct}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Assigned agents */}
          {p.agents.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Assigned Agents
                </div>
                {onReassign && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={onReassign}
                  >
                    <Shuffle className="h-3 w-3" />
                    Reassign
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {p.agents.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground"
                  >
                    <div className="h-4 w-4 rounded-full bg-primary/15 flex items-center justify-center text-[9px] font-semibold text-primary/80">
                      {name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")}
                    </div>
                    {name}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-orange-400/20 bg-orange-500/5 px-4 py-3 flex items-center justify-between gap-3 text-xs text-orange-600/80">
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                No agents assigned yet.
              </span>
              {onReassign && (
                <Button size="sm" className="h-7 gap-1 text-xs flex-shrink-0" onClick={onReassign}>
                  <Shuffle className="h-3 w-3" />
                  Assign Now
                </Button>
              )}
            </div>
          )}

          {/* Per-account transfer */}
          {raw && agents.length > 0 && <AccountsTable rows={raw.rows} agents={agents} />}

          {/* Removed accounts */}
          <RemovedAccountsPanel portfolioId={p.id} />

          {/* Retention requests */}
          <RetentionRequestsPanel portfolioId={p.id} />
        </div>
      </div>
    </div>
  );
}
