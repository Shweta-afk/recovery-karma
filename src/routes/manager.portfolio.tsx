import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  getPortfolios,
  refreshPortfolios,
  assignDebtors,
  transferDebtor,
  updatePortfolioMeta,
  setPortfolioAgentTargets,
  mergePortfolioRows,
  PRODUCT_LABEL_TO_ENUM,
  DEFAULT_PORTFOLIO_SETTINGS,
  type UploadedPortfolio,
  type UploadedDebtor,
  type PortfolioSettings,
  type AgentTarget,
} from "@/lib/portfolio-store";
import {
  Briefcase,
  TrendingUp,
  Users,
  AlertTriangle,
  Eye,
  IndianRupee,
  FileDown,
  Shuffle,
  Loader2,
  ArrowLeftRight,
  Pencil,
  Target,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv-export";
import { saveTemplate } from "@/lib/mapping-template-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import { useManagerTeamAgents, getAgentById, type AgentRef } from "@/lib/team-store";
import { getAgentDispositions, refreshDispositions, calcStats } from "@/lib/disposition-store";
import { useAuth } from "@/lib/auth";
import { useStorageSync } from "@/lib/storage-sync";
import { AssignAgentsStep } from "@/components/assign-agents-step";
import { PortfolioSettingsStep } from "@/components/portfolio-settings-step";
import { CsvImportStep, type CsvImportResult } from "@/components/csv-import-step";

export const Route = createFileRoute("/manager/portfolio")({
  head: () => ({ meta: [{ title: "Portfolio Overview · SamvadX" }] }),
  component: PortfolioOverviewPage,
});

/* ─── types ─────────────────────────────────────────────────────────────── */

interface Portfolio {
  id: string;
  name: string;
  lender: string;
  uploadedOn: string;
  totalAccounts: number;
  assignedAccounts: number;
  buckets: Record<DPDBucket, number>;
  totalOutstanding: number;
  recovered: number;
  ptpCount: number;
  contactRate: number;
  agents: string[];
  status: "active" | "completed" | "stale";
}

const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

const STATUS_META = {
  active: { label: "Partially Assigned", bg: "bg-primary/8 text-primary/80 border-primary/15" },
  completed: { label: "Fully Assigned", bg: "bg-success/8 text-success/80 border-success/15" },
  stale: { label: "Unassigned", bg: "bg-orange-500/8 text-orange-600/80 border-orange-400/15" },
};

/* ─── helpers ────────────────────────────────────────────────────────────── */

function formatINR(n: number) {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
}

// Real assignment + recovery stats for a portfolio, computed from each debtor's
// assigned_agent_id (folded into portfolio-store.ts) + dispositions
function toPortfolio(u: UploadedPortfolio): Portfolio {
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

  const disps = Array.from(debtorIdsByAgent.entries()).flatMap(([agentId, debtorIds]) =>
    getAgentDispositions(agentId).filter((d) => debtorIds.includes(d.debtorId)),
  );
  const stats = calcStats(disps);

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
    recovered: stats.paidAmount,
    ptpCount: stats.ptps,
    contactRate: stats.contactRate,
    agents,
    status,
  };
}

/* ─── summary stat card ─────────────────────────────────────────────────── */

function StatCard({
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
function AccountsTable({ rows, agents }: { rows: UploadedDebtor[]; agents: AgentRef[] }) {
  const [transferringId, setTransferringId] = useState<string | null>(null);

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

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
        <ArrowLeftRight className="h-3.5 w-3.5" />
        Accounts · transfer individually
      </div>
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-border">
                <th className="py-2 pl-3 text-left font-medium text-muted-foreground">Debtor</th>
                <th className="py-2 text-right font-medium text-muted-foreground">Outstanding</th>
                <th className="py-2 pr-3 text-left font-medium text-muted-foreground">
                  Assigned to
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pl-3">
                    <div className="font-medium text-foreground">{r.name}</div>
                    <div className="text-[10px] text-muted-foreground">{r.loanReference}</div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatINR(r.loanAmount)}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PortfolioDetail({
  p,
  raw,
  agents,
  onClose,
  onReassign,
  onEdit,
}: {
  p: Portfolio;
  raw: UploadedPortfolio | null;
  agents: AgentRef[];
  onClose: () => void;
  onReassign: () => void;
  onEdit: () => void;
}) {
  const recoveryPct =
    p.totalOutstanding > 0 ? ((p.recovered / p.totalOutstanding) * 100).toFixed(1) : "0.0";
  const assignPct =
    p.totalAccounts > 0 ? Math.round((p.assignedAccounts / p.totalAccounts) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-t-2xl sm:rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-bottom-4 duration-200 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-card border-b border-border px-5 py-4 flex items-start justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">{p.name}</div>
            <div className="text-xs text-muted-foreground">
              {p.lender} · {p.id} · Uploaded {p.uploadedOn}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onEdit}>
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground text-xs border border-border rounded px-2 py-1"
            >
              ✕ Close
            </button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total Outstanding", val: formatINR(p.totalOutstanding) },
              { label: "Recovered", val: formatINR(p.recovered), sub: `${recoveryPct}% of total` },
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
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-xs"
                  onClick={onReassign}
                >
                  <Shuffle className="h-3 w-3" />
                  Reassign
                </Button>
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
              <Button size="sm" className="h-7 gap-1 text-xs flex-shrink-0" onClick={onReassign}>
                <Shuffle className="h-3 w-3" />
                Assign Now
              </Button>
            </div>
          )}

          {/* Per-account transfer */}
          {raw && agents.length > 0 && <AccountsTable rows={raw.rows} agents={agents} />}
        </div>
      </div>
    </div>
  );
}

/* ─── Reassign dialog ───────────────────────────────────────────────────── */

function ReassignDialog({
  portfolio,
  onClose,
}: {
  portfolio: UploadedPortfolio | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const agents = useManagerTeamAgents(managerId);
  const [allocation, setAllocation] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);

  const initialCounts = useMemo(() => {
    if (!portfolio) return undefined;
    const counts: Record<string, number> = {};
    portfolio.rows.forEach((r) => {
      if (r.assignedAgentId) counts[r.assignedAgentId] = (counts[r.assignedAgentId] ?? 0) + 1;
    });
    return Object.keys(counts).length ? counts : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio?.id]);

  if (!portfolio) return null;
  const totalAllocated = Object.values(allocation).reduce((s, ids) => s + ids.length, 0);

  const handleSave = async () => {
    setSaving(true);
    try {
      await assignDebtors(portfolio.id, allocation);
      toast.success("Assignment saved");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save assignment");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!portfolio}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Reassign · {portfolio.name}</DialogTitle>
        </DialogHeader>
        <AssignAgentsStep
          agents={agents}
          rows={portfolio.rows}
          initialCounts={initialCounts}
          onAllocationChange={setAllocation}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={totalAllocated !== portfolio.rows.length || saving}
            className="gap-1.5"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Assignment
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Edit Portfolio dialog ──────────────────────────────────────────────── */

function EditPortfolioDialog({
  portfolio,
  agents,
  onClose,
}: {
  portfolio: UploadedPortfolio | null;
  agents: AgentRef[];
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [lender, setLender] = useState("");
  const [product, setProduct] = useState("");
  const [settings, setSettings] = useState<PortfolioSettings>(DEFAULT_PORTFOLIO_SETTINGS);
  const [targets, setTargets] = useState<Record<string, AgentTarget>>({});
  const [saving, setSaving] = useState(false);
  const [csvKey, setCsvKey] = useState(0); // bumped to remount CsvImportStep after a successful import
  const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const [importing, setImporting] = useState(false);

  // Re-seed local state whenever a different portfolio is opened for editing
  useEffect(() => {
    if (!portfolio) return;
    setName(portfolio.name);
    setLender(portfolio.lender);
    setProduct(portfolio.product);
    setSettings(portfolio.settings);
    // Falls back to {} for a portfolio cached in localStorage before agentTargets existed
    setTargets(portfolio.agentTargets ?? {});
    setCsvResult(null);
    setCsvKey((k) => k + 1);
  }, [portfolio]);

  if (!portfolio) return null;

  const setTarget = (agentId: string, patch: Partial<AgentTarget>) => {
    setTargets((prev) => ({ ...prev, [agentId]: { ...prev[agentId], ...patch } }));
  };

  const handleSave = async () => {
    if (!name.trim() || !lender.trim()) {
      toast.error("Portfolio name and lender can't be empty");
      return;
    }
    setSaving(true);
    try {
      await Promise.all([
        updatePortfolioMeta(portfolio.id, { name, lender, product, settings }),
        setPortfolioAgentTargets(portfolio.id, targets),
      ]);
      toast.success("Portfolio updated");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save portfolio");
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (!csvResult || !csvResult.valid || csvResult.rows.length === 0) return;
    setImporting(true);
    try {
      const { updated, added } = await mergePortfolioRows(portfolio.id, csvResult.rows);
      // Learn this bank's mapping so a future upload/re-upload auto-applies it, same as the wizard.
      await saveTemplate(lender, csvResult.rawHeaders, csvResult.mapping);
      toast.success(`${updated} account${updated === 1 ? "" : "s"} updated, ${added} added`, {
        description: portfolio.name,
      });
      setCsvResult(null);
      setCsvKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to import accounts");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog
      open={!!portfolio}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">Edit Portfolio · {portfolio.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Details */}
          <div className="space-y-3">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Details
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="edit-pname">Portfolio Name</Label>
                <Input id="edit-pname" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-lender">Lender / Client</Label>
                <Input
                  id="edit-lender"
                  value={lender}
                  onChange={(e) => setLender(e.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Product Type</Label>
                <Select value={product} onValueChange={setProduct}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select product" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(PRODUCT_LABEL_TO_ENUM).map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Add / re-upload accounts */}
          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Upload className="h-3.5 w-3.5" />
              Add / Re-upload Accounts
            </div>
            <p className="-mt-1 text-[11px] text-muted-foreground">
              Upload a CSV to add new accounts or update existing ones — matched by Loan / Account
              ID. Nothing is deleted or reassigned.
            </p>
            <CsvImportStep key={csvKey} lenderName={lender} onChange={setCsvResult} />
            {csvResult && csvResult.rows.length > 0 && (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={!csvResult.valid || importing}
                onClick={handleImport}
              >
                {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Import {csvResult.rows.length} Account{csvResult.rows.length === 1 ? "" : "s"}
              </Button>
            )}
          </div>

          {/* Dial settings */}
          <div className="space-y-3 border-t border-border pt-4">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Dial Settings
            </div>
            <PortfolioSettingsStep settings={settings} onChange={setSettings} />
          </div>

          {/* Agent targets */}
          {agents.length > 0 && (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <Target className="h-3.5 w-3.5" />
                Agent Targets
              </div>
              <p className="-mt-1 text-[11px] text-muted-foreground">
                Optional collection goal per agent for this portfolio — separate from account
                allocation.
              </p>
              <div className="divide-y divide-border rounded-lg border border-border">
                {agents.map((a) => {
                  const t = targets[a.id] ?? {};
                  return (
                    <div key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <div className="min-w-[100px] flex-1 text-sm font-medium text-foreground">
                        {a.name}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-[10px] text-muted-foreground">₹ Target</Label>
                        <Input
                          type="number"
                          min={0}
                          className="h-7 w-28 text-xs"
                          value={t.targetAmount ?? ""}
                          placeholder="—"
                          onChange={(e) =>
                            setTarget(a.id, {
                              targetAmount: e.target.value === "" ? undefined : +e.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-[10px] text-muted-foreground">Accounts</Label>
                        <Input
                          type="number"
                          min={0}
                          className="h-7 w-20 text-xs"
                          value={t.targetAccounts ?? ""}
                          placeholder="—"
                          onChange={(e) =>
                            setTarget(a.id, {
                              targetAccounts: e.target.value === "" ? undefined : +e.target.value,
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

function PortfolioOverviewPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const agents = useManagerTeamAgents(managerId);

  const [statusFilter, setStatusFilter] = useState<Portfolio["status"] | "all">("all");
  const [selected, setSelected] = useState<Portfolio | null>(null);
  const [reassignTarget, setReassignTarget] = useState<UploadedPortfolio | null>(null);
  const [editTarget, setEditTarget] = useState<UploadedPortfolio | null>(null);
  const [rawPortfolios, setRawPortfolios] = useState<UploadedPortfolio[]>(() =>
    getPortfolios().filter((p) => p.managerId === managerId),
  );

  const reload = () => setRawPortfolios(getPortfolios().filter((p) => p.managerId === managerId));
  useEffect(() => {
    reload();
    window.addEventListener("portfolios-updated", reload);
    window.addEventListener("dispositions-updated", reload);
    refreshPortfolios();
    refreshDispositions();
    return () => {
      window.removeEventListener("portfolios-updated", reload);
      window.removeEventListener("dispositions-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerId]);
  useStorageSync(reload);

  const allPortfolios = useMemo(() => rawPortfolios.map(toPortfolio), [rawPortfolios]);

  // Keep the open detail drawer in sync after a per-account transfer or bulk reassignment
  useEffect(() => {
    setSelected((prev) => (prev ? (allPortfolios.find((p) => p.id === prev.id) ?? prev) : prev));
  }, [allPortfolios]);

  const filtered =
    statusFilter === "all" ? allPortfolios : allPortfolios.filter((p) => p.status === statusFilter);

  const totalAccounts = allPortfolios.reduce((s, p) => s + p.totalAccounts, 0);
  const totalOutstanding = allPortfolios.reduce((s, p) => s + p.totalOutstanding, 0);
  const totalRecovered = allPortfolios.reduce((s, p) => s + p.recovered, 0);
  const unassigned = allPortfolios.filter((p) => p.assignedAccounts === 0).length;

  const openReassign = (p: Portfolio) => {
    const raw = rawPortfolios.find((r) => r.id === p.id);
    if (raw) setReassignTarget(raw);
  };

  const openEdit = (p: Portfolio) => {
    const raw = rawPortfolios.find((r) => r.id === p.id);
    if (raw) setEditTarget(raw);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Portfolio Overview
        </h1>
        <p className="text-sm text-muted-foreground">
          Portfolios you've uploaded and their recovery performance.
        </p>
      </div>

      {allPortfolios.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No portfolios yet. Upload one from Portfolio Upload to see it here.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              icon={Briefcase}
              label="Total Portfolios"
              value={String(allPortfolios.length)}
              sub={`${unassigned} need assignment`}
            />
            <StatCard icon={Users} label="Total Accounts" value={totalAccounts.toLocaleString()} />
            <StatCard
              icon={IndianRupee}
              label="Total Outstanding"
              value={formatINR(totalOutstanding)}
            />
            <StatCard
              icon={TrendingUp}
              label="Total Recovered"
              value={formatINR(totalRecovered)}
              sub={
                totalOutstanding > 0
                  ? `${((totalRecovered / totalOutstanding) * 100).toFixed(1)}% of AUM`
                  : "—"
              }
            />
          </div>

          {/* Filter row */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex gap-1.5">
              {(["all", "active", "stale", "completed"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium border transition-all",
                    statusFilter === s
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  {s === "all" ? "All" : STATUS_META[s].label}
                  <span className="ml-1.5 opacity-60">
                    {s === "all"
                      ? allPortfolios.length
                      : allPortfolios.filter((p) => p.status === s).length}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Portfolio table */}
          <Card>
            <CardHeader className="border-b border-border py-2 px-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {filtered.length} portfolios
                </span>
                <button
                  type="button"
                  onClick={() =>
                    downloadCsv(
                      "portfolios.csv",
                      [
                        "Portfolio",
                        "Status",
                        "Assigned",
                        "Outstanding (₹)",
                        "Recovery (₹)",
                        "Contact Rate %",
                      ],
                      filtered.map((p) => [
                        p.name,
                        p.status,
                        p.assignedAccounts,
                        p.totalOutstanding,
                        p.recovered,
                        p.contactRate,
                      ]),
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  <FileDown className="h-3 w-3" />
                  Export
                </button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20">
                      <th className="py-2 pl-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Portfolio
                      </th>
                      <th className="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-32">
                        Status
                      </th>
                      <th className="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Buckets
                      </th>
                      <th className="py-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-32">
                        Assigned
                      </th>
                      <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-32">
                        Outstanding
                      </th>
                      <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-36">
                        Recovery
                      </th>
                      <th className="py-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-28">
                        Contact Rate
                      </th>
                      <th className="py-2 pr-4 w-32" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filtered.map((p) => {
                      const assignPct =
                        p.totalAccounts > 0
                          ? Math.round((p.assignedAccounts / p.totalAccounts) * 100)
                          : 0;
                      const recPct =
                        p.totalOutstanding > 0 ? (p.recovered / p.totalOutstanding) * 100 : 0;
                      const sm = STATUS_META[p.status];
                      return (
                        <tr key={p.id} className="hover:bg-muted/20 transition-colors">
                          <td className="py-3 pl-4">
                            <div className="text-xs font-medium text-foreground">{p.name}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {p.lender} · {p.id}
                            </div>
                          </td>
                          <td className="py-3">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                sm.bg,
                              )}
                            >
                              {sm.label}
                            </span>
                          </td>
                          <td className="py-3">
                            <div className="flex flex-wrap gap-1">
                              {BUCKET_ORDER.filter((b) => p.buckets[b] > 0).map((b) => {
                                const meta = BUCKET_META[b];
                                return (
                                  <span
                                    key={b}
                                    className={cn(
                                      "rounded-full border px-1.5 py-0.5 text-[9px] font-medium",
                                      meta.color,
                                    )}
                                  >
                                    {meta.label} {p.buckets[b]}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-1.5">
                              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full",
                                    assignPct >= 100
                                      ? "bg-success"
                                      : assignPct >= 50
                                        ? "bg-primary/60"
                                        : "bg-orange-500/60",
                                  )}
                                  style={{ width: `${assignPct}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-muted-foreground w-8 flex-shrink-0">
                                {assignPct}%
                              </span>
                            </div>
                          </td>
                          <td className="py-3 pr-3 text-right">
                            <span className="text-xs font-medium text-foreground">
                              {formatINR(p.totalOutstanding)}
                            </span>
                          </td>
                          <td className="py-3 pr-3 text-right">
                            <div className="text-xs font-medium text-foreground">
                              {formatINR(p.recovered)}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {recPct.toFixed(1)}%
                            </div>
                          </td>
                          <td className="py-3 text-center">
                            <span
                              className={cn(
                                "text-xs font-semibold",
                                p.contactRate >= 70
                                  ? "text-success"
                                  : p.contactRate >= 40
                                    ? "text-primary/80"
                                    : "text-muted-foreground",
                              )}
                            >
                              {p.contactRate > 0 ? `${p.contactRate}%` : "—"}
                            </span>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => setSelected(p)}
                                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-all"
                              >
                                <Eye className="h-3 w-3" />
                                View
                              </button>
                              <button
                                type="button"
                                onClick={() => openReassign(p)}
                                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-all"
                              >
                                <Shuffle className="h-3 w-3" />
                                {p.assignedAccounts === 0 ? "Assign" : "Reassign"}
                              </button>
                              <button
                                type="button"
                                onClick={() => openEdit(p)}
                                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-muted-foreground hover:border-foreground/30 hover:text-foreground transition-all"
                              >
                                <Pencil className="h-3 w-3" />
                                Edit
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {selected && (
        <PortfolioDetail
          p={selected}
          raw={rawPortfolios.find((r) => r.id === selected.id) ?? null}
          agents={agents}
          onClose={() => setSelected(null)}
          onReassign={() => {
            openReassign(selected);
            setSelected(null);
          }}
          onEdit={() => {
            openEdit(selected);
            setSelected(null);
          }}
        />
      )}
      <ReassignDialog portfolio={reassignTarget} onClose={() => setReassignTarget(null)} />
      <EditPortfolioDialog
        portfolio={editTarget}
        agents={agents}
        onClose={() => setEditTarget(null)}
      />
    </div>
  );
}
