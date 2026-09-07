import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  getPortfolios,
  refreshPortfolios,
  assignDebtors,
  updatePortfolioMeta,
  setPortfolioAgentTargets,
  mergePortfolioRows,
  remapPortfolioFields,
  dpd2bucket,
  applyBulkPaidFile,
  closePortfolio,
  PRODUCT_LABEL_TO_ENUM,
  DEFAULT_PORTFOLIO_SETTINGS,
  minPortfolioEndDate,
  type UploadedPortfolio,
  type UploadedDebtor,
  type PortfolioSettings,
  type AgentTarget,
  type BulkPaidRow,
  type BulkPaidResult,
} from "@/lib/portfolio-store";
import {
  STD_FIELDS,
  slotsFromDebtor,
  leftoverExtraKeys,
  extraRemapSource,
  resolveRemapSource,
  type StdFieldKey,
} from "@/lib/csv-fields";
import {
  Briefcase,
  TrendingUp,
  Users,
  Eye,
  IndianRupee,
  FileDown,
  Shuffle,
  Loader2,
  Pencil,
  Target,
  Upload,
  UserPlus,
  Wand2,
  Landmark,
  Trash2,
  BarChart2,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv-export";
import { saveTemplate } from "@/lib/mapping-template-store";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn, parseCsvText } from "@/lib/utils";
import { normHeader } from "@/lib/column-mapper";
import { BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import { useTeamAgents, withSelf, type AgentRef } from "@/lib/team-store";
import { useActiveTeam } from "@/lib/active-team-store";
import { refreshDispositions } from "@/lib/disposition-store";
import { refreshPayments } from "@/lib/payments-store";
import { useAuth } from "@/lib/auth";
import { useStorageSync } from "@/lib/storage-sync";
import { AssignAgentsStep } from "@/components/assign-agents-step";
import { PortfolioSettingsStep } from "@/components/portfolio-settings-step";
import { CsvImportStep, type CsvImportResult } from "@/components/csv-import-step";

export const Route = createFileRoute("/manager/portfolio")({
  head: () => ({ meta: [{ title: "Portfolio Overview · SamvadX" }] }),
  component: PortfolioOverviewPage,
});

// Portfolio dashboard — types, data-shaping (toPortfolio), and the full-screen detail view are
// all in one shared module now (extracted 2026-08-20) since admin.portfolio.tsx needs the same
// PortfolioDetail/toPortfolio this page uses. Re-exported here too so nothing that previously
// imported these from this route file breaks.
export {
  type Portfolio,
  BUCKET_ORDER,
  STATUS_META,
  formatINR,
  toPortfolio,
  StatCard,
  PortfolioDetail,
} from "@/components/portfolio/portfolio-dashboard";
import {
  type Portfolio,
  BUCKET_ORDER,
  STATUS_META,
  formatINR,
  toPortfolio,
  StatCard,
  PortfolioDetail,
} from "@/components/portfolio/portfolio-dashboard";

/* ─── Reassign dialog ───────────────────────────────────────────────────── */

function ReassignDialog({
  portfolio,
  onClose,
}: {
  portfolio: UploadedPortfolio | null;
  onClose: () => void;
}) {
  // Scoped by the portfolio's own team, not whatever the manager currently has "active" —
  // a manager reassigning an older portfolio should still see that portfolio's actual team's
  // agents even if they've since switched their working context to a different team.
  const teamAgents = useTeamAgents(portfolio?.teamId);
  const { user } = useAuth();
  const selfId = user?.email ?? user?.id;
  // The manager themself is assignable too, alongside the portfolio's team agents — see withSelf.
  const agents = useMemo(() => withSelf(teamAgents, selfId), [teamAgents, selfId]);
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

function identityRemap(): Record<StdFieldKey, string> {
  const m = {} as Record<StdFieldKey, string>;
  for (const f of STD_FIELDS) m[f.key] = f.key;
  return m;
}

function EditPortfolioDialog({
  portfolio,
  agents,
  onClose,
  onArchived,
}: {
  portfolio: UploadedPortfolio | null;
  agents: AgentRef[];
  onClose: () => void;
  /** Fired after the portfolio is successfully archived (see the Delete Portfolio danger zone
   * below) — the page closes this dialog and, if the same portfolio's detail drawer happens to
   * be open, closes that too. */
  onArchived: () => void;
}) {
  const [name, setName] = useState("");
  const [lender, setLender] = useState("");
  const [product, setProduct] = useState("");
  const [endDate, setEndDate] = useState("");
  const [settings, setSettings] = useState<PortfolioSettings>(DEFAULT_PORTFOLIO_SETTINGS);
  const [targets, setTargets] = useState<Record<string, AgentTarget>>({});
  const [saving, setSaving] = useState(false);
  const [csvKey, setCsvKey] = useState(0); // bumped to remount CsvImportStep after a successful import
  const [csvResult, setCsvResult] = useState<CsvImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [remap, setRemap] = useState<Record<StdFieldKey, string>>(identityRemap);
  const [remapConfirmOpen, setRemapConfirmOpen] = useState(false);
  const [remapping, setRemapping] = useState(false);
  const [addMode, setAddMode] = useState<"csv" | "manual">("csv");
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [manualLoanRef, setManualLoanRef] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualPrincipal, setManualPrincipal] = useState("");
  const [manualEmi, setManualEmi] = useState("");
  const [manualProductCode, setManualProductCode] = useState("");
  const [manualDpd, setManualDpd] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [addingManual, setAddingManual] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-seed local state whenever a different portfolio is opened for editing
  useEffect(() => {
    if (!portfolio) return;
    setName(portfolio.name);
    setLender(portfolio.lender);
    setProduct(portfolio.product);
    setEndDate(portfolio.endDate ?? "");
    setSettings(portfolio.settings);
    // Falls back to {} for a portfolio cached in localStorage before agentTargets existed
    setTargets(portfolio.agentTargets ?? {});
    setCsvResult(null);
    setCsvKey((k) => k + 1);
    setRemap(identityRemap());
    setAddMode("csv");
    setRemoveMissing(false);
    setDeleteConfirmOpen(false);
    setManualName("");
    setManualPhone("");
    setManualLoanRef("");
    setManualAmount("");
    setManualDpd("");
    setManualEmail("");
  }, [portfolio]);

  // Original file columns that never landed on one of our 12 fields — still sitting untouched
  // in `extra` under their literal header name (see leftoverExtraKeys). Offered as remap
  // sources alongside our own fields so a manager can pick the *actual* file column instead of
  // only swapping between our canonical labels. Hooks must run unconditionally on every render
  // of this always-mounted dialog, so this has to sit above the `!portfolio` early return.
  const extraKeys = useMemo(() => leftoverExtraKeys(portfolio?.rows ?? []), [portfolio]);

  if (!portfolio) return null;

  const setTarget = (agentId: string, patch: Partial<AgentTarget>) => {
    setTargets((prev) => ({ ...prev, [agentId]: { ...prev[agentId], ...patch } }));
  };

  const minEndDate = minPortfolioEndDate(portfolio.uploadedAt);

  const handleSave = async () => {
    if (!name.trim() || !lender.trim()) {
      toast.error("Portfolio name and lender can't be empty");
      return;
    }
    if (endDate && endDate < minEndDate) {
      toast.error(
        `A portfolio has to run at least one month — the earliest end date here is ${new Date(minEndDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`,
      );
      return;
    }
    setSaving(true);
    try {
      await Promise.all([
        updatePortfolioMeta(portfolio.id, {
          name,
          lender,
          product,
          settings,
          endDate: endDate || null,
        }),
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
      const { updated, added, skipped, removed } = await mergePortfolioRows(
        portfolio.id,
        csvResult.rows,
        { removeMissing },
      );
      // Learn this bank's mapping so a future upload/re-upload auto-applies it, same as the wizard.
      await saveTemplate(lender, csvResult.rawHeaders, csvResult.mapping);
      toast.success(
        `${updated} account${updated === 1 ? "" : "s"} updated, ${added} added` +
          (removed > 0 ? `, ${removed} removed (not in this file)` : "") +
          (skipped > 0 ? `, ${skipped} skipped (missing name or phone)` : ""),
        { description: portfolio.name },
      );
      setCsvResult(null);
      setCsvKey((k) => k + 1);
      setRemoveMissing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to import accounts");
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async () => {
    setDeleteConfirmOpen(false);
    setDeleting(true);
    try {
      await closePortfolio(portfolio.id);
      toast.success(`"${portfolio.name}" closed`, {
        description: "Still listed in Portfolio Overview, tagged Closed — all history is kept.",
      });
      onArchived();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to archive portfolio");
    } finally {
      setDeleting(false);
    }
  };

  const handleAddManual = async () => {
    if (!manualName.trim() || !manualPhone.trim()) {
      toast.error("Borrower name and phone are required");
      return;
    }
    setAddingManual(true);
    try {
      const dpd = parseInt(manualDpd, 10) || 0;
      const row: UploadedDebtor = {
        id: crypto.randomUUID(),
        loanReference: manualLoanRef.trim(),
        name: manualName.trim(),
        phone: manualPhone.trim(),
        loanAmount: parseFloat(manualAmount.replace(/[,₹\s]/g, "")) || 0,
        principalAmount: parseFloat(manualPrincipal.replace(/[,₹\s]/g, "")) || 0,
        emiAmount: parseFloat(manualEmi.replace(/[,₹\s]/g, "")) || 0,
        productCode: manualProductCode.trim(),
        dpd,
        bucket: dpd2bucket(dpd),
        email: manualEmail.trim(),
        extra: {},
        altPhones: [],
      };
      const { added } = await mergePortfolioRows(portfolio.id, [row]);
      if (added > 0) {
        toast.success("Account added", { description: `${row.name} · ${portfolio.name}` });
        setManualName("");
        setManualPhone("");
        setManualLoanRef("");
        setManualAmount("");
        setManualPrincipal("");
        setManualEmi("");
        setManualProductCode("");
        setManualDpd("");
        setManualEmail("");
      } else {
        toast.error("An account with this Loan / Account ID already exists in this portfolio");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add account");
    } finally {
      setAddingManual(false);
    }
  };

  const remapChanged = STD_FIELDS.some((f) => remap[f.key] !== f.key);

  const handleRemap = async () => {
    setRemapConfirmOpen(false);
    setRemapping(true);
    try {
      const count = await remapPortfolioFields(portfolio.id, remap);
      toast.success(`${count} account${count === 1 ? "" : "s"} remapped`, {
        description: portfolio.name,
      });
      setRemap(identityRemap());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remap fields");
    } finally {
      setRemapping(false);
    }
  };

  return (
    <>
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
                <div className="space-y-1.5">
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
                <div className="space-y-1.5">
                  <Label htmlFor="edit-end-date">End Date</Label>
                  <Input
                    id="edit-end-date"
                    type="date"
                    min={minEndDate}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    A target only — nothing closes automatically, but past this date the portfolio's
                    accounts stop showing in the active call queue. Must be at least one month after
                    upload.
                  </p>
                </div>
              </div>
            </div>

            {/* Remap fields (no re-upload) */}
            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <Wand2 className="h-3.5 w-3.5" />
                Remap Fields
              </div>
              <p className="-mt-1 text-[11px] text-muted-foreground">
                Fix a wrong original column mapping on the {portfolio.rows.length} account
                {portfolio.rows.length === 1 ? "" : "s"} already here — no re-upload needed. For
                each field, pick which column's data should actually be treated as it — one of the
                fields below, or an original file column that wasn't mapped the first time.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {STD_FIELDS.map(({ key, label }) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-xs">{label}</Label>
                    <Select
                      value={remap[key]}
                      onValueChange={(v) => setRemap((prev) => ({ ...prev, [key]: v }))}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STD_FIELDS.map((f) => (
                          <SelectItem key={f.key} value={f.key}>
                            {f.key === key ? `${f.label} (unchanged)` : f.label}
                          </SelectItem>
                        ))}
                        {extraKeys.length > 0 && (
                          <>
                            <SelectSeparator />
                            {extraKeys.map((h) => (
                              <SelectItem key={h} value={extraRemapSource(h)}>
                                <span className="font-mono">{h}</span>
                                <span className="ml-1.5 text-[10px] text-muted-foreground">
                                  from file
                                </span>
                              </SelectItem>
                            ))}
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              {remapChanged && portfolio.rows.length > 0 && (
                <div className="space-y-2 rounded-md border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-xs">
                  <p className="font-medium text-amber-700">
                    Preview — {portfolio.rows.length} account
                    {portfolio.rows.length === 1 ? "" : "s"} will be rewritten:
                  </p>
                  {portfolio.rows.slice(0, 3).map((r) => {
                    const oldSlots = slotsFromDebtor(r);
                    return (
                      <div key={r.id} className="space-y-0.5">
                        <p className="text-[11px] font-medium text-foreground">
                          {r.name || r.loanReference}
                        </p>
                        {STD_FIELDS.filter((f) => remap[f.key] !== f.key).map((f) => (
                          <p key={f.key} className="text-[11px] text-muted-foreground">
                            {f.label}:{" "}
                            <span className="line-through">{oldSlots[f.key] || "—"}</span> →{" "}
                            <span className="text-foreground">
                              {resolveRemapSource(remap[f.key], oldSlots, r.extra) || "—"}
                            </span>
                          </p>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!remapChanged}
                  onClick={() => setRemap(identityRemap())}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={!remapChanged || remapping}
                  onClick={() => setRemapConfirmOpen(true)}
                >
                  {remapping && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Apply Remap
                </Button>
              </div>
            </div>

            {/* Add / re-upload accounts */}
            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <Upload className="h-3.5 w-3.5" />
                  Add / Re-upload Accounts
                </div>
                <div className="flex gap-1 rounded-md border border-border p-0.5">
                  <button
                    type="button"
                    onClick={() => setAddMode("csv")}
                    className={cn(
                      "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                      addMode === "csv"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    CSV Upload
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddMode("manual")}
                    className={cn(
                      "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                      addMode === "manual"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Add One
                  </button>
                </div>
              </div>

              {addMode === "csv" ? (
                <>
                  <p className="-mt-1 text-[11px] text-muted-foreground">
                    Upload a CSV to add new accounts or update existing ones — matched by Loan /
                    Account ID. Nothing is reassigned, and nothing is removed unless you turn that
                    on below.
                  </p>
                  <CsvImportStep key={csvKey} lenderName={lender} onChange={setCsvResult} />
                  {csvResult && csvResult.rows.length > 0 && (
                    <>
                      <label className="flex items-start gap-2 rounded-md border border-border p-2.5">
                        <Checkbox
                          checked={removeMissing}
                          onCheckedChange={(c) => setRemoveMissing(c === true)}
                          className="mt-0.5"
                        />
                        <span className="text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground">
                            Also remove accounts not in this file
                          </span>{" "}
                          — treats this upload as the full, authoritative list. Any existing account
                          here whose Loan / Account ID doesn't appear in it (including one added by
                          hand via "Add One") gets soft-removed — recoverable from Removed Accounts,
                          not permanently deleted.
                        </span>
                      </label>
                      <Button
                        size="sm"
                        className="gap-1.5"
                        disabled={!csvResult.valid || importing}
                        onClick={handleImport}
                      >
                        {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Import {csvResult.rows.length} Account
                        {csvResult.rows.length === 1 ? "" : "s"}
                      </Button>
                    </>
                  )}
                </>
              ) : (
                <>
                  <p className="-mt-1 text-[11px] text-muted-foreground">
                    Add a single new account by hand — it lands unassigned, same as a new row from a
                    CSV.
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Borrower Name <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        value={manualName}
                        onChange={(e) => setManualName(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Phone Number <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        value={manualPhone}
                        onChange={(e) => setManualPhone(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Loan / Account ID</Label>
                      <Input
                        value={manualLoanRef}
                        onChange={(e) => setManualLoanRef(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Outstanding Amount</Label>
                      <Input
                        type="number"
                        min={0}
                        value={manualAmount}
                        onChange={(e) => setManualAmount(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Principal Amount</Label>
                      <Input
                        type="number"
                        min={0}
                        value={manualPrincipal}
                        onChange={(e) => setManualPrincipal(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">EMI Amount</Label>
                      <Input
                        type="number"
                        min={0}
                        value={manualEmi}
                        onChange={(e) => setManualEmi(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Product Code</Label>
                      <Input
                        value={manualProductCode}
                        onChange={(e) => setManualProductCode(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Days Past Due</Label>
                      <Input
                        type="number"
                        min={0}
                        value={manualDpd}
                        onChange={(e) => setManualDpd(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Email Address</Label>
                      <Input
                        type="email"
                        value={manualEmail}
                        onChange={(e) => setManualEmail(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={!manualName.trim() || !manualPhone.trim() || addingManual}
                    onClick={handleAddManual}
                  >
                    {addingManual ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <UserPlus className="h-3.5 w-3.5" />
                    )}
                    Add Account
                  </Button>
                </>
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
                {/* This is load-bearing, not decoration. DRR on the agent and manager
                    dashboards divides this figure by the days left in the month, and the
                    column (portfolio_agent_targets.target_amount) has no period of its own to
                    enforce the convention. A portfolio-lifetime number entered here silently
                    distorts every DRR on the platform — no error, just wrong figures. */}
                <p className="-mt-1 text-[11px] font-medium text-amber-500">
                  Enter a MONTHLY figure. These feed the Daily Run Rate (DRR) on the dashboards,
                  which divides the target by the days remaining in the month.
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
                          <Label className="text-[10px] text-muted-foreground">
                            ₹ Target / month
                          </Label>
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
                          <Label className="text-[10px] text-muted-foreground">
                            Accounts / month
                          </Label>
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

          <div className="space-y-1.5 rounded-md border border-destructive/30 p-3">
            <div className="text-xs font-semibold text-destructive uppercase tracking-wider">
              Danger Zone
            </div>
            <p className="text-[11px] text-muted-foreground">
              Closes {portfolio.name} — drops its remaining accounts from the active call queue, but
              it stays listed in Portfolio Overview (tagged Closed) for reporting and history. All
              debtor, call, and payment history is kept and this is reversible; it does not
              permanently delete anything.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={deleting}
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete Portfolio
            </Button>
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
      <AlertDialog open={remapConfirmOpen} onOpenChange={setRemapConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remap {portfolio.rows.length} accounts?</AlertDialogTitle>
            <AlertDialogDescription>
              This rewrites the changed field
              {STD_FIELDS.filter((f) => remap[f.key] !== f.key).length === 1 ? "" : "s"} on every
              account in {portfolio.name}. This cannot be undone — check the preview above before
              confirming.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemap}>
              Yes, remap {portfolio.rows.length} accounts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{portfolio.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This closes the portfolio — its remaining accounts stop being called, but it stays
              listed in Portfolio Overview (tagged Closed) and nothing is permanently deleted. All
              debtor, call, and payment history stays intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Yes, delete portfolio</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ─── Bulk Paid File dialog ───────────────────────────────────────────────── */
// The bank's daily paid-status file — just Loan/Account ID + amount, nothing else (see
// applyBulkPaidFile in portfolio-store.ts). Deliberately a much lighter mapper than
// CsvImportStep's 12-field grid: 2 columns, auto-detected by header name, editable if the
// guess is wrong.

const LOAN_ID_ALIASES = [
  "loan_id",
  "id",
  "account_id",
  "loanid",
  "acc_id",
  "loan_no",
  "account_no",
  "lan",
];
const PAID_AMOUNT_ALIASES = ["amount", "paid_amount", "paidamount", "paid", "settled_amount"];
/** Sentinel for "this file has no amount column" — Radix Select cannot hold an empty value. */
const NO_AMOUNT_COL = "__none__";

function guessColumn(headers: string[], aliases: string[]): string {
  const normed = headers.map((h) => [h, normHeader(h)] as const);
  for (const alias of aliases) {
    const hit = normed.find(([, n]) => n === alias);
    if (hit) return hit[0];
  }
  for (const alias of aliases) {
    const hit = normed.find(([, n]) => n.includes(alias) || alias.includes(n));
    if (hit) return hit[0];
  }
  return "";
}

function BulkPaidUploadDialog({
  portfolio,
  onClose,
}: {
  portfolio: UploadedPortfolio | null;
  onClose: () => void;
}) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [loanIdCol, setLoanIdCol] = useState("");
  const [amountCol, setAmountCol] = useState(NO_AMOUNT_COL);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<BulkPaidResult | null>(null);

  const reset = () => {
    setFileName("");
    setHeaders([]);
    setRows([]);
    setLoanIdCol("");
    setAmountCol(NO_AMOUNT_COL);
    setResult(null);
  };

  useEffect(() => {
    reset();
  }, [portfolio]);

  if (!portfolio) return null;

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".csv")) {
      toast.error("Only CSV files are accepted");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      // See parseCsvText — line-splitting first corrupts any quoted field with a newline.
      const lines = parseCsvText(text);
      if (lines.length < 2) {
        toast.error("CSV must have a header row and at least one data row");
        return;
      }
      const h = lines[0];
      // Every row. This was capped at 20,000 and silently dropped the rest — on a paid-file
      // reconciliation that means payments the bank reported are never applied, and nothing
      // says so.
      const r = lines.slice(1);
      setHeaders(h);
      setRows(r);
      setLoanIdCol(guessColumn(h, LOAN_ID_ALIASES));
      setAmountCol(guessColumn(h, PAID_AMOUNT_ALIASES) || NO_AMOUNT_COL);
      setFileName(file.name);
      setResult(null);
      toast.success(`Parsed ${r.length} rows from ${file.name}`);
    };
    reader.readAsText(file);
  };

  const handleUpload = async () => {
    if (!loanIdCol) {
      toast.error("Pick the Loan/Account ID column");
      return;
    }
    const idIdx = headers.indexOf(loanIdCol);
    // Amount is optional: the bank's file is often just the list of loan IDs that paid.
    const amtIdx = amountCol === NO_AMOUNT_COL ? -1 : headers.indexOf(amountCol);
    const parsed: BulkPaidRow[] = rows
      .map((r) => {
        const raw = amtIdx >= 0 ? (r[amtIdx] ?? "").replace(/[,₹\s]/g, "") : "";
        const amount = raw ? parseFloat(raw) : NaN;
        return {
          loanReference: (r[idIdx] ?? "").trim(),
          // undefined, not 0 — a blank or unparseable cell means "amount unknown", and
          // applyBulkPaidFile writes no payments row for it rather than a ₹0 one.
          amount: Number.isFinite(amount) && amount > 0 ? amount : undefined,
        };
      })
      .filter((r) => r.loanReference);

    setUploading(true);
    try {
      const res = await applyBulkPaidFile(portfolio.id, parsed);
      setResult(res);
      toast.success(
        `${res.matched} debtor${res.matched === 1 ? "" : "s"} marked paid` +
          (res.withAmount ? ` · ${res.withAmount} with an amount` : "") +
          (res.withoutAmount ? ` · ${res.withoutAmount} without` : "") +
          (res.alreadyPaid ? ` · ${res.alreadyPaid} already paid` : "") +
          (res.notFound ? ` · ${res.notFound} not found in this portfolio` : ""),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to apply the paid file");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={!!portfolio} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Landmark className="h-4 w-4 text-primary" />
            Upload Paid File · {portfolio.name}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          The bank's daily paid-status file, matched against this portfolio's debtors by
          Loan/Account ID. <strong>Only list the accounts that actually paid</strong> — matched
          debtors move to <strong>Paid</strong> and drop out of the active call queue.
          <br />
          The amount column is optional: leave it as &ldquo;No amount column&rdquo; and the file can
          be nothing but loan IDs. A row without an amount is still marked paid, it just records no
          payment figure — rows with a blank or ₹0 amount no longer create ₹0 payment entries.
          Bank-reported payments are never credited to an agent, and already-paid debtors are
          skipped, so re-uploading the same file is safe.
        </p>

        {!headers.length ? (
          <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border py-10 text-center cursor-pointer hover:border-primary/40 transition-colors">
            <Upload className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm text-foreground font-medium">Click to upload CSV</span>
            <span className="text-xs text-muted-foreground">
              Two columns: Loan/Account ID, Paid Amount
            </span>
            <input
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </label>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-foreground font-medium">{fileName}</span>
              <button
                type="button"
                onClick={reset}
                className="text-muted-foreground hover:text-foreground"
              >
                Choose a different file
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Loan / Account ID column</Label>
                <Select value={loanIdCol} onValueChange={setLoanIdCol}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Select column…" />
                  </SelectTrigger>
                  <SelectContent>
                    {headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Paid Amount column (optional)</Label>
                <Select value={amountCol} onValueChange={setAmountCol}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Select column…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_AMOUNT_COL}>No amount column</SelectItem>
                    {headers.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{rows.length} rows ready to match.</p>

            {result && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
                <div className="text-success font-medium">{result.matched} marked paid</div>
                {result.fileTotal > 0 && (
                  <div className="mt-1.5 border-t border-border pt-1.5 space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">File total</span>
                      <span className="tabular-nums text-foreground">
                        {formatINR(result.fileTotal)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Recorded as payments</span>
                      <span className="tabular-nums text-success">
                        {formatINR(result.recorded)}
                      </span>
                    </div>
                    {result.skippedAlreadyPaid > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Skipped — already marked paid</span>
                        <span className="tabular-nums text-warning-foreground">
                          −{formatINR(result.skippedAlreadyPaid)}
                        </span>
                      </div>
                    )}
                    {result.skippedNotFound > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          Skipped — loan ID not in this portfolio
                        </span>
                        <span className="tabular-nums text-destructive">
                          −{formatINR(result.skippedNotFound)}
                        </span>
                      </div>
                    )}
                    {result.duplicateRefs > 0 && (
                      <div className="text-warning-foreground">
                        {result.duplicateRefs} duplicate loan ID
                        {result.duplicateRefs === 1 ? "" : "s"} in the file — each occurrence was
                        recorded separately, so the total above is inflated by the repeats.
                      </div>
                    )}
                    {result.recorded !== result.fileTotal && (
                      <p className="text-[11px] text-muted-foreground pt-1">
                        The portal will show {formatINR(result.recorded)} for this upload, not the
                        spreadsheet&apos;s {formatINR(result.fileTotal)} — the lines above are the
                        difference.
                      </p>
                    )}
                  </div>
                )}
                {result.withAmount > 0 && (
                  <div className="text-muted-foreground">
                    {result.withAmount} recorded a payment amount
                  </div>
                )}
                {result.withoutAmount > 0 && (
                  <div className="text-muted-foreground">
                    {result.withoutAmount} marked paid with no amount — no payment row written
                  </div>
                )}
                {result.alreadyPaid > 0 && (
                  <div className="text-muted-foreground">
                    {result.alreadyPaid} were already paid — skipped
                  </div>
                )}
                {result.notFound > 0 && (
                  <div className="text-amber-600">
                    {result.notFound} loan IDs not found in this portfolio
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              size="sm"
              onClick={handleUpload}
              disabled={!headers.length || !loanIdCol || uploading}
              className="gap-1.5"
            >
              {uploading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Mark Debtors Paid
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── page ───────────────────────────────────────────────────────────────── */

/** Which portfolios Portfolio Overview shows: every one of the active team's, open or closed.
 *
 * Deliberately does NOT also require portfolios.manager_id to equal the signed-in manager.
 * That extra condition disagreed with the team picker's own count of a team's OPEN portfolios
 * (`p.teamId === t.id && !isPortfolioEnded(p)`) — so the picker would advertise "3 portfolios"
 * and this page would then show fewer. Worse, a portfolio assigned to a team but with
 * manager_id left unset was invisible to every manager; 7 such rows existed live on
 * 2026-08-22, including one uploaded that morning. Team membership is the real scope here —
 * RLS already limits getPortfolios() to what this user may see at all.
 *
 * Closed/ended portfolios used to be filtered out entirely here (same `!isPortfolioEnded`
 * check the team picker still uses) — changed 2026-09-05 because a continuation upload closing
 * the old portfolio made it disappear from this page even though its history is exactly what
 * Reports and the debtor dashboard still need; toPortfolio() tags it "Closed" (STATUS_META)
 * instead, and the status filter row below has a "Closed" pill to isolate them on demand.
 */
function visibleToTeam(teamId: string | undefined) {
  return (p: UploadedPortfolio) => p.teamId === teamId;
}

// A colored left-border accent per row status — the table used to be identical rows of text and
// a small badge; this gives it the same at-a-glance color coding STATUS_META's badge already
// carries, just visible without reading the badge text.
const STATUS_BORDER: Record<Portfolio["status"], string> = {
  active: "border-l-primary/50",
  completed: "border-l-success/60",
  stale: "border-l-orange-400/60",
  closed: "border-l-muted-foreground/25",
};

// Same color language as the Reports charts (dashboard.reports.tsx's CHART_COLORS/
// TOOLTIP_STYLE) — kept local rather than imported since that file doesn't export them and the
// two pages aren't meant to be coupled.
const RECOVERY_CHART_TOOLTIP = {
  contentStyle: {
    background: "oklch(0.15 0.025 258)",
    border: "1px solid oklch(0.25 0.03 258)",
    borderRadius: 6,
    fontSize: 11,
  },
};

/** Outstanding vs. Recovered per portfolio — the graph this page never had. Capped to the
 * biggest 8 by outstanding so a manager with a long portfolio list still gets a readable chart
 * instead of an unreadably cramped one; the table below still lists everything. */
function PortfolioRecoveryChart({ portfolios }: { portfolios: Portfolio[] }) {
  const data = [...portfolios]
    .sort((a, b) => b.totalOutstanding - a.totalOutstanding)
    .slice(0, 8)
    .map((p) => ({
      name: p.name.length > 16 ? `${p.name.slice(0, 15)}…` : p.name,
      fullName: p.name,
      outstanding: p.totalOutstanding,
      recovered: p.recovered,
    }));

  return (
    <Card>
      <CardHeader className="border-b border-border py-2.5 px-4">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          <BarChart2 className="h-3.5 w-3.5" />
          Recovery by Portfolio
          {portfolios.length > 8 && (
            <span className="normal-case font-normal text-[10px] opacity-70">
              (top 8 by outstanding)
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <ResponsiveContainer width="100%" height={Math.max(180, data.length * 34)}>
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 16, top: 4 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              horizontal={false}
              stroke="oklch(0.25 0.03 258 / 0.4)"
            />
            <XAxis
              type="number"
              tickFormatter={(v: number) => formatINR(v)}
              tick={{ fontSize: 10 }}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={110}
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              {...RECOVERY_CHART_TOOLTIP}
              formatter={(v: number, key: string) => [
                formatINR(v),
                key === "outstanding" ? "Outstanding" : "Recovered",
              ]}
              labelFormatter={(_, payload) =>
                (payload?.[0]?.payload as { fullName?: string } | undefined)?.fullName ?? ""
              }
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              dataKey="outstanding"
              name="Outstanding"
              fill="oklch(0.58 0.18 258 / 0.3)"
              radius={[0, 3, 3, 0]}
            />
            <Bar
              dataKey="recovered"
              name="Recovered"
              fill="oklch(0.65 0.16 152)"
              radius={[0, 3, 3, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function PortfolioOverviewPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const { activeTeam } = useActiveTeam(managerId);
  const teamAgents = useTeamAgents(activeTeam?.id);
  // The manager themself is assignable too, alongside their team's agents — see withSelf. Feeds
  // the per-account transfer dropdown (AccountsTable) and the Edit Portfolio agent-targets list.
  const agents = useMemo(() => withSelf(teamAgents, managerId), [teamAgents, managerId]);

  const [statusFilter, setStatusFilter] = useState<Portfolio["status"] | "all">("all");
  const [selected, setSelected] = useState<Portfolio | null>(null);
  const [reassignTarget, setReassignTarget] = useState<UploadedPortfolio | null>(null);
  const [editTarget, setEditTarget] = useState<UploadedPortfolio | null>(null);
  const [bulkPaidTarget, setBulkPaidTarget] = useState<UploadedPortfolio | null>(null);
  const [rawPortfolios, setRawPortfolios] = useState<UploadedPortfolio[]>(() =>
    getPortfolios().filter(visibleToTeam(activeTeam?.id)),
  );

  const reload = () => setRawPortfolios(getPortfolios().filter(visibleToTeam(activeTeam?.id)));
  useEffect(() => {
    reload();
    window.addEventListener("portfolios-updated", reload);
    window.addEventListener("dispositions-updated", reload);
    // The Recovered KPI now reads the payments cache (toPortfolio → getPortfolioRecovered),
    // so this page has to populate and listen to it like the other two.
    window.addEventListener("payments-updated", reload);
    refreshPortfolios();
    refreshDispositions();
    refreshPayments();
    return () => {
      window.removeEventListener("portfolios-updated", reload);
      window.removeEventListener("dispositions-updated", reload);
      window.removeEventListener("payments-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerId, activeTeam?.id]);
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

  const openBulkPaid = (p: Portfolio) => {
    const raw = rawPortfolios.find((r) => r.id === p.id);
    if (raw) setBulkPaidTarget(raw);
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
          {/* Summary stats — a distinct accent color per card so the row reads at a glance
              instead of four identical blue boxes. */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              icon={Briefcase}
              label="Total Portfolios"
              value={String(allPortfolios.length)}
              sub={`${unassigned} need assignment`}
              accent="bg-primary"
            />
            <StatCard
              icon={Users}
              label="Total Accounts"
              value={totalAccounts.toLocaleString()}
              accent="bg-violet-500"
            />
            <StatCard
              icon={IndianRupee}
              label="Total Outstanding"
              value={formatINR(totalOutstanding)}
              accent="bg-orange-500"
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
              accent="bg-success"
            />
          </div>

          {/* Recovery by portfolio — the graph this page never had; a manager scanning ten
              portfolios can spot the laggards in one glance instead of reading a column of
              numbers top to bottom. */}
          {filtered.length > 0 && <PortfolioRecoveryChart portfolios={filtered} />}

          {/* Filter row */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex gap-1.5">
              {(["all", "active", "stale", "completed", "closed"] as const).map((s) => (
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
                        <tr
                          key={p.id}
                          className={cn(
                            "border-l-2 hover:bg-muted/20 transition-colors",
                            STATUS_BORDER[p.status],
                          )}
                        >
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
          onUploadPaid={() => {
            openBulkPaid(selected);
            setSelected(null);
          }}
        />
      )}
      <ReassignDialog portfolio={reassignTarget} onClose={() => setReassignTarget(null)} />
      <EditPortfolioDialog
        portfolio={editTarget}
        agents={agents}
        onClose={() => setEditTarget(null)}
        onArchived={() => {
          if (selected && editTarget && selected.id === editTarget.id) setSelected(null);
          setEditTarget(null);
        }}
      />
      <BulkPaidUploadDialog portfolio={bulkPaidTarget} onClose={() => setBulkPaidTarget(null)} />
    </div>
  );
}
