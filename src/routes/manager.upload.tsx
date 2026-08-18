import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  X,
  Download,
  ArrowRight,
  RefreshCw,
  Sliders,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
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
import { cn, parseCsvLine } from "@/lib/utils";
import { BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import {
  createPortfolio,
  dpd2bucket,
  getPortfolios,
  refreshPortfolios,
  DEFAULT_PORTFOLIO_SETTINGS,
  type UploadedPortfolio,
  type UploadedDebtor,
  type PortfolioSettings,
  PRODUCT_LABEL_TO_ENUM,
} from "@/lib/portfolio-store";
import { useManagerTeamAgents, getTeamByManager } from "@/lib/team-store";
import {
  resolveMapping,
  confidenceLabel,
  type MappingResult,
  type FieldSuggestion,
} from "@/lib/column-mapper";
import { findTemplate, saveTemplate, refreshMappingTemplates } from "@/lib/mapping-template-store";
import { AssignAgentsStep } from "@/components/assign-agents-step";
import { PortfolioSettingsStep, CALL_MODE_META } from "@/components/portfolio-settings-step";
import {
  STD_FIELDS,
  REQUIRED_STD_FIELDS,
  mappingFromResult,
  type StdFieldKey,
} from "@/lib/csv-fields";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/manager/upload")({
  head: () => ({ meta: [{ title: "Portfolio Upload · SamvadX" }] }),
  component: PortfolioUploadPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = "meta" | "file" | "map" | "settings" | "assign" | "preview" | "done";

const STEP_ORDER: Step[] = ["meta", "file", "map", "settings", "assign", "preview"];
const STEP_LABELS: Record<Step, string> = {
  meta: "1. Details",
  file: "2. File",
  map: "3. Map Columns",
  settings: "4. Settings",
  assign: "5. Assign Agents",
  preview: "6. Review & Upload",
  done: "Done",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];

function BucketBreakdown({ rows }: { rows: UploadedDebtor[] }) {
  const counts = rows.reduce<Record<DPDBucket, number>>(
    (acc, r) => {
      acc[r.bucket] = (acc[r.bucket] ?? 0) + 1;
      return acc;
    },
    { X: 0, "1": 0, "2": 0, NPA: 0, WriteOff: 0 },
  );
  const total = rows.length;
  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {BUCKET_ORDER.map((b) => {
        const n = counts[b];
        const pct = total ? Math.round((n / total) * 100) : 0;
        const meta = BUCKET_META[b];
        return (
          <div key={b} className="flex items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className={cn("text-[10px] w-20 justify-center shrink-0", meta.color)}
            >
              {meta.label}
            </Badge>
            <Progress value={pct} className="h-1.5 flex-1" />
            <span className="text-muted-foreground w-8 text-right">{n}</span>
          </div>
        );
      })}
    </div>
  );
}

// Small confidence badge for an auto-mapped field
const CONF_TONE: Record<string, string> = {
  template: "bg-violet-500/10 text-violet-600 border-violet-400/30",
  high: "bg-success/10 text-success border-success/30",
  medium: "bg-amber-500/10 text-amber-600 border-amber-400/30",
  low: "bg-orange-500/10 text-orange-600 border-orange-400/30",
  none: "bg-muted text-muted-foreground border-border",
};

function ConfidenceBadge({ suggestion }: { suggestion?: FieldSuggestion }) {
  if (!suggestion || !suggestion.column) return null;
  const { label, tone } = confidenceLabel(suggestion);
  return (
    <Badge
      variant="outline"
      className={cn("text-[9px] h-4 px-1.5 font-medium capitalize", CONF_TONE[tone])}
    >
      {label}
    </Badge>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function PortfolioUploadPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const managerAgents = useManagerTeamAgents(managerId);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<Step>("meta");

  // Warm the mapping-template cache so findTemplate() has data by the time a file is dropped
  useEffect(() => {
    refreshMappingTemplates();
  }, []);

  // Meta
  const [portfolioName, setPortfolioName] = useState("");
  const [lenderName, setLenderName] = useState("");
  const [product, setProduct] = useState("");
  // "This continues portfolio X" — set, reconcileRetainedDebtors() in createPortfolio() carries
  // forward any 'sent_to_bank' retention request against that old portfolio, then closes it.
  const [replacesPortfolioId, setReplacesPortfolioId] = useState<string>("");
  const [existingPortfolios, setExistingPortfolios] = useState<UploadedPortfolio[]>(() =>
    getPortfolios(),
  );
  useEffect(() => {
    refreshPortfolios().then(() => setExistingPortfolios(getPortfolios()));
  }, []);
  // Open (not-yet-closed) portfolios, most recent first — defaults the picker toward whichever
  // one the manager most likely means once they've typed a lender name.
  const continuablePortfolios = useMemo(
    () =>
      existingPortfolios
        .filter((p) => !p.closedAt)
        .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1)),
    [existingPortfolios],
  );

  // CSV state
  const [fileName, setFileName] = useState("");
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<StdFieldKey, string>>(
    {} as Record<StdFieldKey, string>,
  );
  const [suggestions, setSuggestions] = useState<MappingResult>({});
  const [templateApplied, setTemplateApplied] = useState(false);

  // Portfolio settings (step 4)
  const [settings, setSettings] = useState<PortfolioSettings>(DEFAULT_PORTFOLIO_SETTINGS);

  // Agent allocation (step 5) — agentId -> debtor IDs
  const [allocation, setAllocation] = useState<Record<string, string[]>>({});

  // Upload progress
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadedSkipped, setUploadedSkipped] = useState(0);

  // Derive mapped rows from raw + mapping. Memoized so the array reference stays stable
  // across renders — AssignAgentsStep depends on `rows` identity in an effect, and an
  // unmemoized array here would recompute a new reference every render and infinite-loop it.
  const mappedRows: UploadedDebtor[] = useMemo(
    () =>
      rawRows.map((vals, i) => {
        const get = (key: StdFieldKey) => {
          const col = mapping[key];
          if (!col) return "";
          const idx = rawHeaders.indexOf(col);
          return idx !== -1 ? (vals[idx] ?? "").trim() : "";
        };
        const dpd = parseInt(get("dpd") || "0", 10);
        // Collect unmapped columns as "extra"
        const mappedCols = new Set(Object.values(mapping).filter(Boolean));
        const extra: Record<string, string> = {};
        rawHeaders.forEach((h, idx) => {
          if (!mappedCols.has(h)) extra[h] = vals[idx] ?? "";
        });
        return {
          id: crypto.randomUUID(),
          // No fallback placeholder — a blank required field (name/phone) is surfaced via
          // rowIssues below and skipped at upload (createPortfolio), not silently papered over.
          loanReference: get("loan_id"),
          name: get("name"),
          phone: get("phone"),
          loanAmount: parseFloat(get("loan_amount").replace(/[,₹\s]/g, "")) || 0,
          dpd,
          bucket: dpd2bucket(dpd),
          email: get("email"),
          extra: {
            address: get("address"),
            city: get("city"),
            state: get("state"),
            dob: get("dob"),
            employer: get("employer"),
            income: get("income"),
            ...extra,
          },
          altPhones: [],
        };
      }),
    [rawRows, rawHeaders, mapping],
  );

  // Per-row, per-field blanks for every *mapped* required column — a column being mapped
  // doesn't mean every cell in it is filled. 1-indexed CSV row numbers (header row + 1) so
  // managers can jump straight to the offending cell in their source file, and each entry
  // names which field(s) were blank rather than a single generic "something's empty".
  const requiredFields = REQUIRED_STD_FIELDS;
  const rowIssues = useMemo(
    () =>
      rawRows.reduce<{ row: number; fields: string[] }[]>((acc, vals, i) => {
        const missing: string[] = [];
        for (const f of requiredFields) {
          const col = mapping[f.key];
          if (!col) continue; // unmapped column is caught separately, before this ever runs
          const idx = rawHeaders.indexOf(col);
          const val = idx !== -1 ? (vals[idx] ?? "").trim() : "";
          if (!val) missing.push(f.label);
        }
        if (missing.length) acc.push({ row: i + 2, fields: missing });
        return acc;
      }, []),
    [rawRows, rawHeaders, mapping, requiredFields],
  );

  const processFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith(".csv")) {
        toast.error("Only CSV files are accepted");
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) {
          toast.error("CSV must have a header row and at least one data row");
          return;
        }
        // A blank header cell (e.g. a trailing comma in the header row, common from Excel
        // exports) parses to "" — Radix's <Select.Item> throws on an empty value, so give any
        // blank column a positional placeholder name instead. Keeps array length/position in
        // sync with rawRows, which is indexed via rawHeaders.indexOf(h) elsewhere.
        const headers = parseCsvLine(lines[0]).map((h, i) => (h.trim() ? h : `Column ${i + 1}`));
        const rows = lines.slice(1, 5001).map((l) => parseCsvLine(l));

        // Reuse a saved mapping for this bank if one exists, then resolve the rest
        const template = findTemplate(lenderName, headers);
        const result = resolveMapping(headers, rows, template?.mapping ?? null);

        setRawHeaders(headers);
        setRawRows(rows);
        setSuggestions(result);
        setMapping(mappingFromResult(result));
        setTemplateApplied(!!template);
        setFileName(file.name);
        setStep("map");

        if (template) {
          toast.success(`Applied saved mapping for ${template.lenderLabel}`, {
            description: `${rows.length} rows · review & confirm`,
          });
        } else {
          const autoCount = Object.values(result).filter((s) => s.column).length;
          toast.success(
            `Parsed ${rows.length} rows — auto-mapped ${autoCount} of ${STD_FIELDS.length} fields`,
            { description: file.name },
          );
        }
      };
      reader.readAsText(file);
    },
    [lenderName],
  );

  const totalAllocated = Object.values(allocation).reduce((s, ids) => s + ids.length, 0);
  const allocationComplete = managerAgents.length === 0 || totalAllocated === mappedRows.length;

  const handleUpload = async () => {
    // Unmapped required columns / blank required cells are surfaced as warnings elsewhere in
    // this step (not blocked here) — a row that's missing name or phone just gets skipped at
    // insert time (createPortfolio reports how many), rather than the whole batch being
    // refused over a handful of bad rows in an otherwise-good file.
    if (!portfolioName || !lenderName) {
      toast.error("Fill portfolio name and lender");
      return;
    }
    if (!allocationComplete) {
      toast.error("Allocate all accounts to agents before uploading, or adjust the split.");
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    const team = getTeamByManager(managerId);

    // Real progress isn't observable mid-batch-insert, so climb toward 90% while the
    // request is in flight and snap to 100% only once it actually resolves.
    const tick = setInterval(() => setUploadProgress((p) => Math.min(p + 8, 90)), 180);

    try {
      const portfolio: UploadedPortfolio = {
        id: crypto.randomUUID(),
        name: portfolioName,
        lender: lenderName,
        product,
        uploadedAt: new Date().toISOString(),
        rows: mappedRows,
        managerId,
        teamId: team?.id,
        settings,
        agentTargets: {},
        replacesPortfolioId: replacesPortfolioId || undefined,
      };
      const { uploaded, skipped, carried } = await createPortfolio(
        portfolio,
        team && managerAgents.length > 0 ? allocation : {},
      );
      // Learn this bank's mapping so future uploads auto-apply it
      await saveTemplate(lenderName, rawHeaders, mapping);

      clearInterval(tick);
      setUploadProgress(100);
      setUploadedCount(uploaded + carried);
      setUploadedSkipped(skipped);
      setUploading(false);
      setStep("done");
      const parts = [`${uploaded} new`];
      if (carried > 0) parts.push(`${carried} carried forward`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      toast.success(`${parts.join(", ")} accounts`, {
        description: `${portfolioName} · ${lenderName} · mapping saved for next time`,
      });
    } catch (e) {
      clearInterval(tick);
      setUploading(false);
      setUploadProgress(0);
      toast.error(e instanceof Error ? e.message : "Upload failed");
    }
  };

  const resetForm = () => {
    setStep("meta");
    setPortfolioName("");
    setLenderName("");
    setProduct("");
    setFileName("");
    setRawHeaders([]);
    setRawRows([]);
    setMapping({} as Record<StdFieldKey, string>);
    setSuggestions({});
    setTemplateApplied(false);
    setSettings(DEFAULT_PORTFOLIO_SETTINGS);
    setAllocation({});
    setUploadProgress(0);
  };

  const unmappedRequired = REQUIRED_STD_FIELDS.filter((f) => !mapping[f.key]);

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Portfolio Upload</h1>
        <p className="text-sm text-muted-foreground">
          Upload a CSV, map its columns, set how this portfolio should be worked, and assign it to
          your team — all in one flow.
        </p>
      </div>

      {/* ── Step indicator ── */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
        {STEP_ORDER.map((s, i) => {
          const passed = STEP_ORDER.indexOf(step) > i || step === "done";
          const active = step === s;
          return (
            <span key={s} className="flex items-center gap-1">
              {i > 0 && <ArrowRight className="h-3 w-3 opacity-40" />}
              <span
                className={cn(
                  "px-2 py-0.5 rounded-full font-medium transition-colors whitespace-nowrap",
                  active
                    ? "bg-primary text-primary-foreground"
                    : passed
                      ? "text-success"
                      : "text-muted-foreground",
                )}
              >
                {STEP_LABELS[s]}
              </span>
            </span>
          );
        })}
      </div>

      {step === "done" ? (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="pt-6 pb-6 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-success" />
            <h3 className="font-semibold text-foreground">Portfolio uploaded and assigned</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              <strong>{uploadedCount} accounts</strong> are now visible in the debtor list,
              portfolio overview, and each agent's queue.
              {uploadedSkipped > 0 && (
                <>
                  {" "}
                  <span className="text-orange-600">
                    {uploadedSkipped} row{uploadedSkipped === 1 ? "" : "s"} skipped
                  </span>{" "}
                  — missing a name or phone number.
                </>
              )}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Button onClick={resetForm} variant="outline" className="gap-2">
                <RefreshCw className="h-3.5 w-3.5" />
                Upload Another
              </Button>
              <Button asChild className="gap-2">
                <Link to="/manager/portfolio">View Portfolio Overview</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            {/* Step 1 — Portfolio details */}
            <Card className={cn(step !== "meta" && "opacity-70")}>
              <CardHeader className="border-b border-border pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">1 · Portfolio Details</CardTitle>
                  {step !== "meta" && (
                    <button
                      type="button"
                      onClick={() => setStep("meta")}
                      className="text-xs text-primary hover:underline"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pname">
                    Portfolio Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="pname"
                    placeholder="e.g. Personal Loan Q2 2026"
                    value={portfolioName}
                    onChange={(e) => setPortfolioName(e.target.value)}
                    disabled={step !== "meta"}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lender">
                    Lender / Client <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="lender"
                    placeholder="e.g. HDFC Bank"
                    value={lenderName}
                    onChange={(e) => setLenderName(e.target.value)}
                    disabled={step !== "meta"}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Product Type</Label>
                  <Select value={product} onValueChange={setProduct} disabled={step !== "meta"}>
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
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Continues portfolio (optional)</Label>
                  <Select
                    value={replacesPortfolioId || "none"}
                    onValueChange={(v) => setReplacesPortfolioId(v === "none" ? "" : v)}
                    disabled={step !== "meta"}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="This is a fresh portfolio, not a continuation" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not a continuation — fresh portfolio</SelectItem>
                      {continuablePortfolios.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} · {p.lender || "no lender set"} · uploaded{" "}
                          {new Date(p.uploadedAt).toLocaleDateString("en-IN")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    If the bank's next cycle for this lender is replacing an old portfolio, pick it
                    here — any account whose retention was requested and sent to the bank gets
                    carried forward automatically if it's in this file, and the old portfolio closes
                    out.
                  </p>
                </div>
                {step === "meta" && (
                  <div className="flex items-end">
                    <Button
                      className="w-full"
                      disabled={!portfolioName || !lenderName}
                      onClick={() => setStep("file")}
                    >
                      Continue <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Step 2 — CSV file */}
            {(step === "file" ||
              step === "map" ||
              step === "settings" ||
              step === "assign" ||
              step === "preview") && (
              <Card className={cn(step !== "file" && "opacity-70")}>
                <CardHeader className="border-b border-border pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">2 · Upload CSV File</CardTitle>
                    {fileName && step !== "file" && (
                      <span className="text-xs text-muted-foreground font-mono">{fileName}</span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-4">
                  {step === "file" && (
                    <div
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragging(false);
                        const f = e.dataTransfer.files[0];
                        if (f) processFile(f);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                      className={cn(
                        "cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors",
                        dragging
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/40 hover:bg-accent/30",
                      )}
                    >
                      <Upload className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
                      <p className="text-sm font-medium text-foreground">
                        Drop CSV here or click to browse
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Any column names — you'll map them in the next step
                      </p>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) processFile(f);
                          e.target.value = "";
                        }}
                      />
                    </div>
                  )}
                  {step !== "file" && (
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
                      <FileSpreadsheet className="h-5 w-5 text-success flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{fileName}</p>
                        <p className="text-xs text-muted-foreground">
                          {rawRows.length} rows · {rawHeaders.length} columns detected
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setStep("file");
                          setRawHeaders([]);
                          setRawRows([]);
                          setFileName("");
                        }}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Step 3 — Column mapping */}
            {(step === "map" || step === "settings" || step === "assign" || step === "preview") && (
              <Card className={cn(step !== "map" && "opacity-70")}>
                <CardHeader className="border-b border-border pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">3 · Map Columns</CardTitle>
                    {step !== "map" && (
                      <button
                        type="button"
                        onClick={() => setStep("map")}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Auto-mapped from header names, fuzzy matches and column values. Review the
                    low-confidence ones.
                  </p>
                </CardHeader>
                <CardContent className="pt-4">
                  {templateApplied && (
                    <div className="mb-3 flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-500/5 px-3 py-2 text-xs text-violet-600">
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                      <span>Applied this bank's saved mapping. Only confirm what changed.</span>
                    </div>
                  )}
                  {/* Confidence legend */}
                  <div className="mb-3 flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
                    <span>Confidence:</span>
                    {[
                      ["saved", "template"],
                      ["high", "high"],
                      ["likely", "medium"],
                      ["guess", "low"],
                    ].map(([lbl, tone]) => (
                      <Badge
                        key={tone}
                        variant="outline"
                        className={cn("text-[9px] h-4 px-1.5 capitalize", CONF_TONE[tone])}
                      >
                        {lbl}
                      </Badge>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {STD_FIELDS.map(({ key, label, required }) => {
                      const sug = suggestions[key];
                      const lowConf =
                        !!sug?.column && sug.source !== "template" && sug.confidence < 0.6;
                      return (
                        <div key={key} className="space-y-1">
                          <label className="text-xs font-medium text-foreground flex items-center gap-1">
                            {label}
                            {required ? (
                              <span className="text-destructive ml-0.5">*</span>
                            ) : (
                              <span className="text-[10px] text-muted-foreground font-normal">
                                (optional)
                              </span>
                            )}
                            <span className="ml-auto">
                              <ConfidenceBadge suggestion={sug} />
                            </span>
                          </label>
                          <Select
                            value={mapping[key] || "__none__"}
                            onValueChange={(val) =>
                              setMapping((m) => ({ ...m, [key]: val === "__none__" ? "" : val }))
                            }
                            disabled={step !== "map"}
                          >
                            <SelectTrigger
                              className={cn(
                                "h-8 text-xs",
                                required &&
                                  !mapping[key] &&
                                  "border-destructive/50 focus:ring-destructive/30",
                                lowConf && "border-amber-400/50 focus:ring-amber-400/30",
                              )}
                            >
                              <SelectValue placeholder="— not mapped —" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">
                                <span className="text-muted-foreground">— not mapped —</span>
                              </SelectItem>
                              {rawHeaders.map((h) => (
                                <SelectItem key={h} value={h}>
                                  <span className="font-mono">{h}</span>
                                  {rawRows[0]?.[rawHeaders.indexOf(h)] && (
                                    <span className="text-muted-foreground ml-2 text-[10px]">
                                      e.g. {rawRows[0][rawHeaders.indexOf(h)]}
                                    </span>
                                  )}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>

                  {unmappedRequired.length > 0 && (
                    <p className="mt-3 text-xs text-amber-600 flex items-center gap-1">
                      <span className="font-semibold">Not mapped:</span>{" "}
                      {unmappedRequired.map((f) => f.label).join(", ")} — rows missing these will be
                      skipped at upload, everything else still goes through.
                    </p>
                  )}

                  {step === "map" && (
                    <Button className="mt-4 w-full" onClick={() => setStep("settings")}>
                      Continue to Settings <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Step 4 — Portfolio Settings */}
            {(step === "settings" || step === "assign" || step === "preview") && (
              <Card className={cn(step !== "settings" && "opacity-70")}>
                <CardHeader className="border-b border-border pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">4 · Portfolio Settings</CardTitle>
                    {step !== "settings" && (
                      <button
                        type="button"
                        onClick={() => setStep("settings")}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    How this portfolio should be dialed, rechurned and followed up — saved with the
                    portfolio, not globally.
                  </p>
                </CardHeader>
                <CardContent className="pt-4">
                  <fieldset
                    disabled={step !== "settings"}
                    className={cn(step !== "settings" && "opacity-70 pointer-events-none")}
                  >
                    <PortfolioSettingsStep settings={settings} onChange={setSettings} />
                  </fieldset>
                  {step === "settings" && (
                    <Button className="mt-5 w-full" onClick={() => setStep("assign")}>
                      Continue to Assign Agents <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Step 5 — Assign Agents */}
            {(step === "assign" || step === "preview") && (
              <Card className={cn(step !== "assign" && "opacity-70")}>
                <CardHeader className="border-b border-border pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">5 · Assign Agents</CardTitle>
                    {step !== "assign" && (
                      <button
                        type="button"
                        onClick={() => setStep("assign")}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Split these {mappedRows.length} accounts across your team.
                  </p>
                </CardHeader>
                <CardContent className="pt-4">
                  <fieldset
                    disabled={step !== "assign"}
                    className={cn(step !== "assign" && "opacity-70 pointer-events-none")}
                  >
                    <AssignAgentsStep
                      agents={managerAgents}
                      rows={mappedRows}
                      onAllocationChange={setAllocation}
                    />
                  </fieldset>
                  {step === "assign" && (
                    <Button
                      className="mt-4 w-full"
                      disabled={!allocationComplete}
                      onClick={() => setStep("preview")}
                    >
                      Continue to Review <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Step 6 — Review & Upload */}
            {step === "preview" && (
              <Card>
                <CardHeader className="border-b border-border pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">6 · Review &amp; Upload</CardTitle>
                    <span className="text-xs text-muted-foreground">
                      {mappedRows.length} accounts
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="pt-4 space-y-4">
                  {/* Summary row */}
                  <div className="flex flex-wrap gap-3 text-xs">
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 flex flex-col">
                      <span className="text-muted-foreground">Portfolio</span>
                      <span className="font-semibold text-foreground">{portfolioName}</span>
                    </div>
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 flex flex-col">
                      <span className="text-muted-foreground">Lender</span>
                      <span className="font-semibold text-foreground">{lenderName}</span>
                    </div>
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 flex flex-col">
                      <span className="text-muted-foreground">Accounts</span>
                      <span className="font-semibold text-foreground">{mappedRows.length}</span>
                    </div>
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 flex flex-col">
                      <span className="text-muted-foreground">Call Mode</span>
                      <span className="font-semibold text-foreground">
                        {CALL_MODE_META[settings.callMode].label}
                      </span>
                    </div>
                  </div>

                  {/* Allocation summary */}
                  {managerAgents.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {managerAgents.map((a) => (
                        <Badge key={a.id} variant="outline" className="text-[11px] gap-1">
                          <Sliders className="h-3 w-3" />
                          {a.name}: {(allocation[a.id] ?? []).length}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Preview table */}
                  <div className="rounded-md border border-border overflow-hidden">
                    <div className="overflow-x-auto max-h-52">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">ID</TableHead>
                            <TableHead className="text-xs">Name</TableHead>
                            <TableHead className="text-xs">Phone</TableHead>
                            <TableHead className="text-xs text-right">Outstanding</TableHead>
                            <TableHead className="text-xs text-center">DPD</TableHead>
                            <TableHead className="text-xs">Bucket</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {mappedRows.slice(0, 8).map((r) => (
                            <TableRow key={r.id}>
                              <TableCell className="text-xs font-mono">{r.loanReference}</TableCell>
                              <TableCell className="text-xs">
                                {r.name || <span className="text-muted-foreground">—</span>}
                              </TableCell>
                              <TableCell className="text-xs font-mono">{r.phone || "—"}</TableCell>
                              <TableCell className="text-xs text-right">
                                {r.loanAmount ? `₹${r.loanAmount.toLocaleString("en-IN")}` : "—"}
                              </TableCell>
                              <TableCell className="text-xs text-center">{r.dpd}d</TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={cn("text-[10px]", BUCKET_META[r.bucket].color)}
                                >
                                  {BUCKET_META[r.bucket].label}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {mappedRows.length > 8 && (
                      <div className="py-2 text-center text-xs text-muted-foreground border-t border-border">
                        +{mappedRows.length - 8} more rows
                      </div>
                    )}
                  </div>

                  {rowIssues.length > 0 && (
                    <div className="rounded-md border border-amber-400/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 space-y-1.5">
                      <p>
                        {rowIssues.length} row{rowIssues.length === 1 ? "" : "s"} missing name or
                        phone — these will be skipped on upload, everything else still goes through.
                        Fix the source file and re-upload later if you want them included.
                      </p>
                      <ul className="list-disc space-y-0.5 pl-4">
                        {rowIssues.slice(0, 10).map((r) => (
                          <li key={r.row}>
                            CSV row {r.row}: missing {r.fields.join(", ")}
                          </li>
                        ))}
                        {rowIssues.length > 10 && <li>…and {rowIssues.length - 10} more</li>}
                      </ul>
                    </div>
                  )}

                  {uploading && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Uploading &amp; assigning…</span>
                        <span>{Math.round(uploadProgress)}%</span>
                      </div>
                      <Progress value={uploadProgress} />
                    </div>
                  )}

                  <Button className="w-full gap-2" onClick={handleUpload} disabled={uploading}>
                    <Upload className="h-4 w-4" />
                    Upload &amp; Assign {mappedRows.length - rowIssues.length} Account
                    {mappedRows.length - rowIssues.length === 1 ? "" : "s"}
                    {rowIssues.length > 0 && ` (${rowIssues.length} skipped)`}
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar — bucket preview */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-sm font-semibold">DPD Bucket Preview</CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                {mappedRows.length > 0 ? (
                  <BucketBreakdown rows={mappedRows} />
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-3">
                    Upload a CSV to see distribution
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="border-b border-border pb-3">
                <CardTitle className="text-sm font-semibold">Accepted Column Names</CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                <div className="space-y-2">
                  {REQUIRED_STD_FIELDS.map(({ key, label }) => (
                    <div key={key} className="text-xs">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <Badge variant="default" className="text-[9px] h-4">
                          req
                        </Badge>
                        <span className="font-medium text-foreground">{label}</span>
                      </div>
                      <p className="text-muted-foreground font-mono text-[10px] ml-8">
                        {key} · {key.replace("_", "")} · {label.toLowerCase().replace(/\s+/g, "_")}
                      </p>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const sample = [
                      "loan_id,name,phone,loan_amount,dpd,email",
                      "L-10001,Rahul Sharma,+91 98765 43210,125000,45,rahul@email.com",
                      "L-10002,Priya Iyer,+91 90123 45678,82000,0,priya@email.com",
                    ].join("\n");
                    const url = URL.createObjectURL(new Blob([sample], { type: "text/csv" }));
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "sample-portfolio.csv";
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="mt-4 w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 transition-colors"
                >
                  <Download className="h-3 w-3" />
                  Download Sample CSV
                </button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
