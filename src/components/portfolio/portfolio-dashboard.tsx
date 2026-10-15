import { useEffect, useMemo, useRef, useState } from "react";
import { ListPager, usePaged } from "@/components/list-pager";
import {
  transferDebtor,
  transferDebtors,
  removeDebtor,
  restoreDebtor,
  getRemovedDebtors,
  isPortfolioEnded,
  fetchPortfolioRows,
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
import { CopyButton } from "@/components/ui/copy-button";
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
import {
  getDispositionsByPortfolio,
  getLatestDispositionByDebtor,
  calcStats,
  type CallOutcome,
} from "@/lib/disposition-store";
import { getPortfolioRecovered, getPayments } from "@/lib/payments-store";
import { errorText } from "@/lib/app-error";

export interface Portfolio {
  id: string;
  name: string;
  lender: string;
  uploadedOn: string;
  totalAccounts: number;
  assignedAccounts: number;
  buckets: Record<DPDBucket, number>;
  totalOutstanding: number;
  // Sum of each row's principalAmount — distinct from totalOutstanding, which sums loanAmount.
  // 0 when nobody in the file has a principal figure (most files still only carry one amount).
  totalPrincipal: number;
  recovered: number;
  /** The slice of `recovered` that arrived via a bank paid-file upload rather than an agent
   * collection. Surfaced on the Recovered KPI so an upload is visibly reflected. */
  recoveredBankReported: number;
  ptpCount: number;
  contactRate: number;
  // Accounts carried forward from a prior cycle (debtor.retained_from_portfolio_id) that are
  // still live in THIS portfolio — count and their combined loan amount, so a manager reviewing
  // a continuation upload can see how much of the book is retained vs. freshly uploaded.
  retainedAccounts: number;
  retainedAmount: number;
  agents: string[];
  // "closed" covers both a manually-closed/replaced portfolio (closedAt set) and one past its
  // manager-set end date (see isPortfolioEnded in portfolio-store.ts) — both stop being actively
  // worked the same way, so they share one badge here rather than a separate "overdue" state.
  status: "active" | "completed" | "stale" | "closed";
  endDate?: string;
}

export const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

// Solid bar-fill classes matching each bucket's own semantic color in BUCKET_META (text-only
// there, since it's used on a badge/label) — literal strings, not built with template
// interpolation, so Tailwind's static scanner actually picks them up.
const BUCKET_BAR_FILL: Record<DPDBucket, string> = {
  X: "bg-success",
  "1": "bg-primary",
  "2": "bg-warning",
  NPA: "bg-destructive",
  WriteOff: "bg-muted-foreground/60",
};

export const STATUS_META = {
  active: { label: "Partially Assigned", bg: "bg-primary/8 text-primary/80 border-primary/15" },
  completed: { label: "Fully Assigned", bg: "bg-success/8 text-success/80 border-success/15" },
  stale: { label: "Unassigned", bg: "bg-orange-500/8 text-orange-600/80 border-orange-400/15" },
  closed: { label: "Closed", bg: "bg-muted text-muted-foreground border-border" },
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
  // A closed portfolio's `rows` are deliberately emptied in the cache (localStorage quota —
  // see refreshPortfolios in portfolio-store.ts), which would read every row-derived stat below
  // as zero. portfolio_debtor_aggregates() (migrations/20260908_portfolio_debtor_aggregates.sql)
  // computes the same numbers straight from the DB instead, so a closed portfolio's dashboard
  // still shows its real last-known state rather than an empty one. Falls back to the rows-based
  // computation when the aggregate hasn't loaded yet (migration not applied, or still fetching).
  const agg = u.rows.length === 0 ? u.closedAggregate : undefined;

  const buckets = agg
    ? agg.buckets
    : u.rows.reduce<Record<DPDBucket, number>>(
        (acc, r) => {
          acc[r.bucket] = (acc[r.bucket] ?? 0) + 1;
          return acc;
        },
        { X: 0, "1": 0, "2": 0, NPA: 0, WriteOff: 0 },
      );
  const totalOutstanding = agg
    ? agg.totalOutstanding
    : u.rows.reduce((s, r) => s + r.loanAmount, 0);
  const totalPrincipal = agg
    ? agg.totalPrincipal
    : u.rows.reduce((s, r) => s + r.principalAmount, 0);

  const retainedRows = u.rows.filter((r) => r.retained);
  const retainedAccounts = agg ? agg.retainedAccounts : retainedRows.length;
  const retainedAmount = agg
    ? agg.retainedAmount
    : retainedRows.reduce((s, r) => s + r.loanAmount, 0);

  let assignedAccounts: number;
  let agents: string[];
  if (agg) {
    assignedAccounts = agg.assignedAccounts;
    agents = agg.agentEmails.map((email) => getAgentById(email)?.name ?? email);
  } else {
    const debtorIdsByAgent = new Map<string, string[]>();
    for (const r of u.rows) {
      if (!r.assignedAgentId) continue;
      const arr = debtorIdsByAgent.get(r.assignedAgentId) ?? [];
      arr.push(r.id);
      debtorIdsByAgent.set(r.assignedAgentId, arr);
    }
    assignedAccounts = Array.from(debtorIdsByAgent.values()).reduce((s, ids) => s + ids.length, 0);
    agents = Array.from(debtorIdsByAgent.keys()).map((email) => getAgentById(email)?.name ?? email);
  }

  // Group by portfolio rather than walking each assigned agent's dispositions. The per-agent
  // walk kept a call only when the caller IS the debtor's currently-assigned agent, so it
  // dropped calls on since-unassigned debtors, calls by an agent since moved off the account,
  // and calls by a manager (who has no debtors assigned to them at all). Observed live on
  // 2026-08-22: it hid two of nine calls on portfolio 04f1fdec — including a ₹1,000 payment —
  // reading 71% contact where the real figure was 78%.
  const stats = calcStats(getDispositionsByPortfolio(u.id));
  const recoveredSplit = getPortfolioRecovered(u.id);

  // A closed portfolio's rows are deliberately emptied in the cache (see refreshPortfolios in
  // portfolio-store.ts) to protect the localStorage quota — that would read as "0 accounts,
  // unassigned" here, so closed takes priority over the assignment-based statuses below rather
  // than being computed from rows that no longer exist.
  const status: Portfolio["status"] = isPortfolioEnded(u)
    ? "closed"
    : assignedAccounts === 0
      ? "stale"
      : assignedAccounts >= u.rows.length
        ? "completed"
        : "active";

  return {
    id: u.id,
    name: u.name,
    lender: u.lender,
    uploadedOn: u.uploadedAt.slice(0, 10),
    // Closed portfolios carry [] in `rows` (quota protection), so fall back to the DB's own
    // total_accounts snapshot rather than reporting 0 for a portfolio that plainly has accounts.
    totalAccounts: agg
      ? agg.totalAccounts
      : u.closedAt
        ? (u.storedTotalAccounts ?? u.rows.length)
        : u.rows.length,
    assignedAccounts,
    buckets,
    totalOutstanding,
    totalPrincipal,
    // From the payments table, not stats.paidAmount — see getPortfolioRecovered. A call-logged
    // "paid" writes a payments row too, so this covers agent collections *and* bank-reported
    // paid-file uploads without double-counting either.
    recovered: recoveredSplit.total,
    recoveredBankReported: recoveredSplit.bankReported,
    ptpCount: stats.ptps,
    contactRate: stats.contactRate,
    retainedAccounts,
    retainedAmount,
    agents,
    status,
    endDate: u.endDate,
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
const ALL_MARKS = "__all__";
const UNCONTACTED = "__uncontacted__";

/** Per-account transfer control — moves one debtor to a different agent (or unassigns them)
 * without re-splitting the rest of the portfolio, unlike the bulk Reassign dialog. */
/** The account's most recent call outcome — what an agent last marked it as. Distinct from
 * DebtorStatusBadge below, which shows debtors.status (a lifecycle state set by a paid-file
 * upload or a settlement, not by a call). */
function MarkedAsBadge({ outcome }: { outcome?: CallOutcome }) {
  if (!outcome) return <span className="text-[10px] text-muted-foreground">Not contacted</span>;
  const meta = OUTCOME_META[outcome];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        meta?.cls ?? "bg-muted text-muted-foreground border-border",
      )}
    >
      {meta?.label ?? outcome}
    </span>
  );
}

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

function AccountsTable({
  rows,
  agents,
  readOnly = false,
}: {
  rows: UploadedDebtor[];
  agents: AgentRef[];
  // A closed portfolio's accounts are a historical record, not something to keep editing —
  // transferring/removing accounts out of a superseded cycle, or re-editing who worked them,
  // reads as live portfolio management on data that's already over. Drops the checkboxes, the
  // "Assigned to" dropdown and the remove button in favour of plain read-only cells.
  readOnly?: boolean;
}) {
  const [transferringId, setTransferringId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<UploadedDebtor | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAgent, setBulkAgent] = useState<string>(UNASSIGNED);
  const [bulkMoving, setBulkMoving] = useState(false);
  // "Marked as" filter. Managers and admins previously had no way at all to see, let alone
  // filter by, what an account had been dispositioned as — that only existed on the agent's
  // own call queue.
  const [markedFilter, setMarkedFilter] = useState<string>(ALL_MARKS);

  const latestByDebtor = useMemo(() => getLatestDispositionByDebtor(), []);
  const markOf = (id: string) => latestByDebtor.get(id)?.outcome;

  const visibleRows = useMemo(() => {
    if (markedFilter === ALL_MARKS) return rows;
    if (markedFilter === UNCONTACTED) return rows.filter((r) => !markOf(r.id));
    return rows.filter((r) => markOf(r.id) === markedFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, markedFilter, latestByDebtor]);

  const markCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows)
      counts[markOf(r.id) ?? UNCONTACTED] = (counts[markOf(r.id) ?? UNCONTACTED] ?? 0) + 1;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, latestByDebtor]);

  const handleTransfer = async (debtorId: string, value: string) => {
    setTransferringId(debtorId);
    try {
      await transferDebtor(debtorId, value === UNASSIGNED ? null : value);
      toast.success("Account transferred");
    } catch (e) {
      toast.error(errorText(e, "Failed to transfer account"));
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
      toast.error(errorText(e, "Failed to remove account"));
    } finally {
      setRemovingId(null);
      setConfirmRemove(null);
    }
  };

  // Paged rendering (list-pager.tsx): every row carries a Select, a Checkbox and a copy button,
  // and one portfolio holds up to ~2,750 accounts. Select-all and bulk move still cover every
  // row, not just the page on screen.
  const accountsPaged = usePaged(visibleRows, markedFilter);
  const accountsScrollRef = useRef<HTMLDivElement>(null);

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
      toast.error(errorText(e, "Failed to transfer accounts"));
    } finally {
      setBulkMoving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <ArrowLeftRight className="h-3.5 w-3.5" />
          {readOnly
            ? "Accounts · read-only historical record"
            : "Accounts · transfer individually or select several"}
        </div>
        <Select value={markedFilter} onValueChange={setMarkedFilter}>
          <SelectTrigger className="h-7 w-52 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_MARKS}>All accounts ({rows.length})</SelectItem>
            <SelectItem value={UNCONTACTED}>
              Not yet contacted ({markCounts[UNCONTACTED] ?? 0})
            </SelectItem>
            {(Object.keys(OUTCOME_META) as CallOutcome[])
              .filter((o) => (markCounts[o] ?? 0) > 0)
              .map((o) => (
                <SelectItem key={o} value={o}>
                  {OUTCOME_META[o].label} ({markCounts[o]})
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {!readOnly && selected.size > 0 && (
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
        <div ref={accountsScrollRef} className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-border">
                {!readOnly && (
                  <th className="py-2 pl-3 w-8">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                  </th>
                )}
                <th
                  className={cn(
                    "py-2 text-left font-medium text-muted-foreground",
                    readOnly && "pl-3",
                  )}
                >
                  Debtor
                </th>
                <th className="py-2 text-right font-medium text-muted-foreground">Outstanding</th>
                <th className="py-2 text-right font-medium text-muted-foreground">Principal</th>
                <th className="py-2 pl-3 text-left font-medium text-muted-foreground">Marked as</th>
                <th className="py-2 pl-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="py-2 pr-3 text-left font-medium text-muted-foreground">
                  Assigned to
                </th>
                {!readOnly && <th className="py-2 pr-3 w-8" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {accountsPaged.pageItems.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? "bg-primary/5" : undefined}>
                  {!readOnly && (
                    <td className="py-2 pl-3">
                      <Checkbox
                        checked={selected.has(r.id)}
                        onCheckedChange={() => toggleRow(r.id)}
                      />
                    </td>
                  )}
                  <td className={readOnly ? "py-2 pl-3" : "py-2"}>
                    <div className="font-medium text-foreground">{r.name}</div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      {r.loanReference}
                      <CopyButton value={r.loanReference} label="Loan ID" />
                      {r.retained && (
                        <span className="text-violet-500"> · retained from {r.retainedFrom}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatINR(r.loanAmount)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {r.principalAmount > 0 ? formatINR(r.principalAmount) : "—"}
                  </td>
                  <td className="py-2 pl-3">
                    <MarkedAsBadge outcome={markOf(r.id)} />
                  </td>
                  <td className="py-2 pl-3">
                    <DebtorStatusBadge status={r.status} />
                  </td>
                  <td className="py-2 pr-3">
                    {readOnly ? (
                      <span className="text-muted-foreground">
                        {agents.find((a) => a.id === r.assignedAgentId)?.name ?? "Unassigned"}
                      </span>
                    ) : (
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
                    )}
                  </td>
                  {!readOnly && (
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
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListPager
          paged={accountsPaged}
          scrollTo={accountsScrollRef}
          noun="accounts"
          className="border-t border-border px-3"
        />
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
      toast.error(errorText(e, "Failed to load removed accounts"));
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
      toast.error(errorText(e, "Failed to restore account"));
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
      toast.error(errorText(e, "Failed to load retention requests"));
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
      toast.error(errorText(e, "Failed to update request"));
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
      toast.error(errorText(e, "Exported, but failed to mark as sent"));
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
  replacedByName,
}: {
  p: Portfolio;
  raw: UploadedPortfolio | null;
  agents: AgentRef[];
  onClose: () => void;
  onReassign?: () => void;
  onEdit?: () => void;
  onUploadPaid?: () => void;
  // Name of the portfolio that superseded this one (its `replaces_portfolio_id` points back at
  // `p.id`) — the caller looks this up across the full portfolio list, since a single closed
  // portfolio's own record has no forward pointer to its successor. Only meaningful once closed.
  replacedByName?: string;
}) {
  const recoveryPct =
    p.totalOutstanding > 0 ? ((p.recovered / p.totalOutstanding) * 100).toFixed(1) : "0.0";
  const assignPct =
    p.totalAccounts > 0 ? Math.round((p.assignedAccounts / p.totalAccounts) * 100) : 0;

  // A closed portfolio's `raw.rows` is deliberately [] (localStorage quota — see the `rows:`
  // comment in refreshPortfolios). The account-level table still needs real rows to show
  // anything, so fetch them on demand for just this one portfolio, kept in local state only —
  // never written to the shared cache, so none of the quota risk that emptied them returns.
  const [closedRows, setClosedRows] = useState<UploadedDebtor[] | null>(null);
  const [closedRowsLoading, setClosedRowsLoading] = useState(false);
  const needsClosedRows = p.status === "closed" && (raw?.rows.length ?? 0) === 0;
  useEffect(() => {
    setClosedRows(null);
    if (!needsClosedRows) return;
    setClosedRowsLoading(true);
    fetchPortfolioRows(p.id)
      .then(setClosedRows)
      .catch(() => setClosedRows([]))
      .finally(() => setClosedRowsLoading(false));
  }, [p.id, needsClosedRows]);
  const accountRows = needsClosedRows ? (closedRows ?? []) : (raw?.rows ?? []);

  // Who collected how much on this portfolio, and against their own target on it
  // (raw.agentTargets, keyed by email — same identity payments-store already uses for
  // PaymentRecord.agentId). Bank-reported payments (agentId null) have no collector and no
  // target to compare against, so they're kept separate rather than attributed to nobody.
  const agentCollections = (() => {
    const completed = getPayments().filter(
      (pay) => pay.portfolioId === p.id && pay.status === "completed",
    );
    const byAgent = new Map<string, { name: string; amount: number }>();
    let bankReported = 0;
    for (const pay of completed) {
      if (!pay.agentId) {
        bankReported += pay.amount;
        continue;
      }
      const entry = byAgent.get(pay.agentId) ?? { name: pay.agentName, amount: 0 };
      entry.amount += pay.amount;
      byAgent.set(pay.agentId, entry);
    }
    const rows = Array.from(byAgent.entries())
      .map(([email, v]) => ({
        email,
        name: v.name,
        amount: v.amount,
        target: raw?.agentTargets[email]?.targetAmount,
      }))
      .sort((a, b) => b.amount - a.amount);
    return { rows, bankReported };
  })();

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
              {p.status === "closed" && (
                <>
                  {raw?.closedAt
                    ? ` · Closed ${raw.closedAt.slice(0, 10)}`
                    : p.endDate
                      ? ` · End date ${p.endDate} passed`
                      : ""}
                  {replacedByName && ` · continues as "${replacedByName}"`}
                </>
              )}
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
          {/* KPI row — big numbers with a colored edge, not a wall of same-size text */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              {
                label: "Total Outstanding",
                val: formatINR(p.totalOutstanding),
                sub: `across ${p.totalAccounts} account${p.totalAccounts === 1 ? "" : "s"}`,
                bar: "border-l-primary",
              },
              // Only shown once the file actually carried a distinct principal figure — most
              // still don't, and a permanent "Principal ₹0" tile would just be noise.
              ...(p.totalPrincipal > 0
                ? [
                    {
                      label: "Total Principal",
                      val: formatINR(p.totalPrincipal),
                      bar: "border-l-violet-500",
                    },
                  ]
                : []),
              {
                label: "Recovered",
                val: formatINR(p.recovered),
                sub:
                  p.recoveredBankReported > 0
                    ? `${recoveryPct}% of total · ${formatINR(p.recoveredBankReported)} via bank file`
                    : `${recoveryPct}% of total`,
                bar: "border-l-success",
              },
              { label: "PTPs Secured", val: String(p.ptpCount), bar: "border-l-warning" },
              { label: "Contact Rate", val: `${p.contactRate}%`, bar: "border-l-violet-500" },
              // Only shown once this portfolio actually has carried-forward accounts — most
              // portfolios never do, and a permanent "Retained ₹0" tile would just be noise.
              ...(p.retainedAccounts > 0
                ? [
                    {
                      label: "Retained",
                      val: formatINR(p.retainedAmount),
                      sub: `${p.retainedAccounts} account${p.retainedAccounts === 1 ? "" : "s"} carried forward`,
                      bar: "border-l-violet-500",
                    },
                  ]
                : []),
            ].map(({ label, val, sub, bar }) => (
              <div
                key={label}
                className={cn(
                  "relative overflow-hidden rounded-lg border border-border border-l-[3px] bg-card px-3.5 py-3 shadow-sm",
                  bar,
                )}
              >
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </div>
                <div className="text-2xl font-extrabold tabular-nums leading-tight tracking-tight text-foreground">
                  {val}
                </div>
                {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
              </div>
            ))}
          </div>

          {/* Recovery / assignment meters — labelled scale + the raw numbers underneath, not
              just a bare percentage on a thin bar. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="mb-2.5 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-foreground">Recovery progress</span>
                <span className="text-xl font-extrabold tabular-nums text-foreground">
                  {recoveryPct}%
                </span>
              </div>
              <Progress value={parseFloat(recoveryPct)} className="h-2.5" />
              <div className="mt-1 flex justify-between text-[9.5px] tabular-nums text-muted-foreground">
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <span key={f}>{formatINR(Math.round(p.totalOutstanding * f))}</span>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>
                  Recovered <b className="text-foreground">{formatINR(p.recovered)}</b>
                </span>
                <span>
                  Remaining{" "}
                  <b className="text-foreground">
                    {formatINR(Math.max(0, p.totalOutstanding - p.recovered))}
                  </b>
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="mb-2.5 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-foreground">Accounts assigned</span>
                <span
                  className={cn(
                    "text-xl font-extrabold tabular-nums",
                    assignPct < 50 ? "text-orange-500" : "text-success",
                  )}
                >
                  {assignPct}%
                </span>
              </div>
              <Progress
                value={assignPct}
                className="h-2.5"
                indicatorClassName={assignPct < 50 ? "bg-orange-500/70" : undefined}
              />
              <div className="mt-1 flex justify-between text-[9.5px] tabular-nums text-muted-foreground">
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <span key={f}>{Math.round(p.totalAccounts * f)}</span>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>
                  Assigned <b className="text-foreground">{p.assignedAccounts}</b>
                </span>
                <span>
                  Unassigned{" "}
                  <b className="text-foreground">{p.totalAccounts - p.assignedAccounts}</b>
                </span>
              </div>
            </div>
          </div>

          {/* Call activity & AI performance */}
          <CallActivitySection portfolioId={p.id} dialerMode={raw?.settings.dialerMode} />

          {/* Bucket breakdown — each bucket in its own semantic color (BUCKET_META), not one
              flat bar color for all five, with a shared scale under the tallest bar. */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
            <div className="text-xs font-semibold text-foreground mb-3">Bucket breakdown</div>
            <div className="space-y-2.5">
              {BUCKET_ORDER.filter((b) => p.buckets[b] > 0).map((b) => {
                const meta = BUCKET_META[b];
                const pct = Math.round((p.buckets[b] / p.totalAccounts) * 100);
                return (
                  <div key={b} className="grid grid-cols-[86px_1fr_50px] items-center gap-2.5">
                    <span
                      className={cn(
                        "text-[11px] font-semibold",
                        meta.color.split(" ").find((c) => c.startsWith("text-")),
                      )}
                    >
                      {meta.label}
                    </span>
                    <div className="h-3.5 rounded-md bg-muted overflow-hidden">
                      <div
                        className={cn("h-full min-w-[3px] rounded-md", BUCKET_BAR_FILL[b])}
                        style={{ width: `${Math.max(pct, 0.5)}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-bold tabular-nums text-right text-foreground">
                      {p.buckets[b]}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 grid grid-cols-[86px_1fr_50px] gap-2.5 border-t border-dashed border-border pt-1.5">
              <div />
              <div className="flex justify-between text-[9.5px] tabular-nums text-muted-foreground">
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <span key={f}>{Math.round(p.totalAccounts * f)}</span>
                ))}
              </div>
              <div />
            </div>
          </div>

          {/* Collections by agent — who actually collected how much on this portfolio, and how
              that compares to their monthly target on it (portfolio_agent_targets). */}
          {agentCollections.rows.length > 0 || agentCollections.bankReported > 0 ? (
            <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-baseline justify-between">
                <div className="text-xs font-semibold text-foreground">Collections by Agent</div>
                <span className="text-[11px] text-muted-foreground">
                  vs. this cycle&apos;s monthly target
                </span>
              </div>
              <div className="space-y-2.5">
                {agentCollections.rows.map((r) => {
                  const targetPct = r.target ? Math.round((r.amount / r.target) * 100) : null;
                  return (
                    <div key={r.email} className="flex items-center gap-2.5">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-bold text-primary/80">
                        {r.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[12.5px] font-semibold text-foreground">
                            {r.name}
                          </span>
                          <span className="shrink-0 text-[13.5px] font-bold tabular-nums text-foreground">
                            {formatINR(r.amount)}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              targetPct === null
                                ? "bg-primary/50"
                                : targetPct >= 100
                                  ? "bg-success"
                                  : targetPct >= 60
                                    ? "bg-warning"
                                    : "bg-destructive",
                            )}
                            style={{ width: `${Math.min(100, targetPct ?? 60)}%` }}
                          />
                        </div>
                      </div>
                      {targetPct !== null && (
                        <span
                          className={cn(
                            "shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold",
                            targetPct >= 100
                              ? "border-success/40 bg-success/10 text-success"
                              : targetPct >= 60
                                ? "border-warning/40 bg-warning/15 text-warning-foreground"
                                : "border-destructive/35 bg-destructive/10 text-destructive",
                          )}
                        >
                          {targetPct}% of {formatINR(r.target ?? 0)}
                        </span>
                      )}
                    </div>
                  );
                })}
                {agentCollections.bankReported > 0 && (
                  <div className="flex items-center gap-2.5 border-t border-dashed border-border pt-2.5">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px]">
                      🏦
                    </div>
                    <div className="min-w-0 flex-1 text-[12px] text-muted-foreground">
                      Bank-reported (paid file, no collector)
                    </div>
                    <span className="shrink-0 text-[13px] font-bold tabular-nums text-muted-foreground">
                      {formatINR(agentCollections.bankReported)}
                    </span>
                  </div>
                )}
              </div>
              <div className="mt-3 flex justify-between border-t border-border pt-2.5 text-[12px] font-semibold">
                <span className="text-muted-foreground">Total recovered on this portfolio</span>
                <span className="tabular-nums text-foreground">{formatINR(p.recovered)}</span>
              </div>
            </div>
          ) : null}

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

          {/* Per-account transfer. For a closed portfolio, `accountRows` is fetched on demand
              (see the effect above) since `raw.rows` is deliberately empty in the cache. */}
          {closedRowsLoading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Loading this closed portfolio's accounts…
            </p>
          ) : (
            raw &&
            agents.length > 0 && (
              <AccountsTable rows={accountRows} agents={agents} readOnly={p.status === "closed"} />
            )
          )}

          {/* Removed accounts */}
          <RemovedAccountsPanel portfolioId={p.id} />

          {/* Retention requests */}
          <RetentionRequestsPanel portfolioId={p.id} />
        </div>
      </div>
    </div>
  );
}
