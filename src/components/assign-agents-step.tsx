import { useEffect, useRef, useState } from "react";
import { Zap, Hand, Plus, Minus, Info, Upload, FileDown, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, parseCsvLine } from "@/lib/utils";
import { BUCKET_META, type DPDBucket } from "@/lib/mock-debtors";
import { normHeader } from "@/lib/column-mapper";
import { downloadCsv } from "@/lib/csv-export";
import type { AgentRef } from "@/lib/team-store";
import type { UploadedDebtor } from "@/lib/portfolio-store";

const BUCKET_ORDER: DPDBucket[] = ["X", "1", "2", "NPA", "WriteOff"];
type AssignMode = "auto" | "manual" | "csv";

// Header aliases accepted in the mapping CSV (normalized: lowercase, non-alnum → "_")
const LOAN_ID_HEADERS = new Set(["loan_id", "loanid", "account_id", "accountid", "loan_reference", "loanreference"]);
const AGENT_ID_HEADERS = new Set(["agent_id", "agentid", "agent_email", "agentemail", "email"]);

export interface AssignAgentsStepProps {
  agents: AgentRef[];
  rows: UploadedDebtor[];
  /** Pre-fill from an existing assignment (agentId -> debtor count), e.g. when reassigning. */
  initialCounts?: Record<string, number>;
  /** Fires whenever the allocation changes with the concrete debtor-id slice per agent. */
  onAllocationChange: (allocation: Record<string, string[]>) => void;
}

function distributeEvenly(agentIds: string[], total: number): Record<string, number> {
  if (!agentIds.length) return {};
  const base = Math.floor(total / agentIds.length);
  const extra = total % agentIds.length;
  const result: Record<string, number> = {};
  agentIds.forEach((id, i) => { result[id] = base + (i < extra ? 1 : 0); });
  return result;
}

/** Slice the portfolio's row IDs into per-agent chunks matching `counts`, in agent order. */
function toIdSlices(rows: UploadedDebtor[], agents: AgentRef[], counts: Record<string, number>): Record<string, string[]> {
  const ids = rows.map(r => r.id);
  let offset = 0;
  const result: Record<string, string[]> = {};
  for (const a of agents) {
    const count = counts[a.id] ?? 0;
    result[a.id] = ids.slice(offset, offset + count);
    offset += count;
  }
  return result;
}

export function AssignAgentsStep({ agents, rows, initialCounts, onAllocationChange }: AssignAgentsStepProps) {
  const [mode, setMode] = useState<AssignMode>("auto");
  const [bucketGrouping, setBucketGrouping] = useState<Record<DPDBucket, string[]>>({
    X: [], "1": [], "2": [], NPA: [], WriteOff: [],
  });
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    initialCounts ?? distributeEvenly(agents.map(a => a.id), rows.length));

  // CSV mode — loan_id → agent_id mapping file
  const csvFileInputRef = useRef<HTMLInputElement>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [csvAllocation, setCsvAllocation] = useState<Record<string, string[]>>({});
  const [csvUnmatchedLoanIds, setCsvUnmatchedLoanIds] = useState<string[]>([]);
  const [csvUnmatchedAgentIds, setCsvUnmatchedAgentIds] = useState<string[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);

  const totalCount = rows.length;
  const bucketCounts = BUCKET_ORDER.reduce((acc, b) => {
    acc[b] = rows.filter(r => r.bucket === b).length;
    return acc;
  }, {} as Record<DPDBucket, number>);

  const csvAllocatedCount = Object.values(csvAllocation).reduce((s, ids) => s + ids.length, 0);
  const totalAlloc = mode === "csv" ? csvAllocatedCount : Object.values(counts).reduce((s, n) => s + n, 0);
  const remaining = totalCount - totalAlloc;

  // Recompute an even split whenever the agent roster or row count changes (e.g. new team, new file)
  useEffect(() => {
    if (!initialCounts) setCounts(distributeEvenly(agents.map(a => a.id), rows.length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, rows.length]);

  // Reset any parsed CSV mapping when the underlying portfolio changes
  useEffect(() => {
    setCsvFileName(""); setCsvAllocation({}); setCsvUnmatchedLoanIds([]); setCsvUnmatchedAgentIds([]); setCsvError(null);
  }, [rows]);

  // Push the concrete debtor-id allocation up to the parent whenever it changes
  useEffect(() => {
    onAllocationChange(mode === "csv" ? csvAllocation : toIdSlices(rows, agents, counts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, counts, csvAllocation, rows, agents]);

  const adjustCount = (agentId: string, delta: number) => {
    setCounts(prev => {
      const cur = prev[agentId] ?? 0;
      return { ...prev, [agentId]: Math.max(0, cur + delta) };
    });
  };

  const handleCsvFile = (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) { setCsvError("Only .csv files are accepted"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) { setCsvError("CSV must have a header row and at least one data row"); return; }

      const headers = parseCsvLine(lines[0]).map(normHeader);
      const loanIdx = headers.findIndex(h => LOAN_ID_HEADERS.has(h));
      const agentIdx = headers.findIndex(h => AGENT_ID_HEADERS.has(h));
      if (loanIdx === -1 || agentIdx === -1) {
        setCsvError(`CSV must include a "loan_id" column and an "agent_id" column (found: ${headers.join(", ") || "none"})`);
        return;
      }

      const debtorIdByLoanId = new Map(rows.map(r => [r.loanReference.trim().toLowerCase(), r.id]));
      const agentIdByKey = new Map<string, string>();
      agents.forEach(a => {
        agentIdByKey.set(a.id.trim().toLowerCase(), a.id);
        agentIdByKey.set(a.name.trim().toLowerCase(), a.id);
      });

      const allocation: Record<string, string[]> = {};
      const assignedDebtorIds = new Set<string>();
      const unmatchedLoanIds: string[] = [];
      const unmatchedAgentIds: string[] = [];

      for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line);
        const loanId = (cells[loanIdx] ?? "").trim();
        const agentKey = (cells[agentIdx] ?? "").trim();
        if (!loanId || !agentKey) continue;

        const debtorId = debtorIdByLoanId.get(loanId.toLowerCase());
        if (!debtorId) { unmatchedLoanIds.push(loanId); continue; }
        if (assignedDebtorIds.has(debtorId)) continue; // duplicate row — first occurrence wins

        const agentId = agentIdByKey.get(agentKey.toLowerCase());
        if (!agentId) { unmatchedAgentIds.push(agentKey); continue; }

        assignedDebtorIds.add(debtorId);
        if (!allocation[agentId]) allocation[agentId] = [];
        allocation[agentId].push(debtorId);
      }

      setCsvFileName(file.name);
      setCsvAllocation(allocation);
      setCsvUnmatchedLoanIds(unmatchedLoanIds);
      setCsvUnmatchedAgentIds(unmatchedAgentIds);
      setCsvError(null);
    };
    reader.readAsText(file);
  };

  const downloadCsvTemplate = () => {
    downloadCsv("assignment-template.csv", ["loan_id", "agent_id"],
      rows.slice(0, 10).map((r, i) => [r.loanReference, agents[i % agents.length]?.id ?? ""]));
  };

  const toggleBucketAgent = (bucket: DPDBucket, agentId: string) => {
    setBucketGrouping(prev => {
      const cur = prev[bucket];
      return { ...prev, [bucket]: cur.includes(agentId) ? cur.filter(id => id !== agentId) : [...cur, agentId] };
    });
  };

  if (!agents.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No agents on your team yet — ask an admin to add you to a team before assigning.</p>;
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Mode */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <button type="button" onClick={() => setMode("auto")}
            className={cn("rounded-lg border p-3 text-left transition-all", mode === "auto" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-accent/20")}>
            <div className="flex items-center gap-2 mb-1">
              <Zap className={cn("h-4 w-4", mode === "auto" ? "text-primary" : "text-muted-foreground")} />
              <span className="text-sm font-semibold text-foreground">Auto-Assign</span>
              <Badge variant="secondary" className="text-[10px] ml-auto">Recommended</Badge>
            </div>
            <p className="text-xs text-muted-foreground">Splits accounts evenly across your team.</p>
          </button>
          <button type="button" onClick={() => setMode("manual")}
            className={cn("rounded-lg border p-3 text-left transition-all", mode === "manual" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-accent/20")}>
            <div className="flex items-center gap-2 mb-1">
              <Hand className={cn("h-4 w-4", mode === "manual" ? "text-primary" : "text-muted-foreground")} />
              <span className="text-sm font-semibold text-foreground">Manual</span>
            </div>
            <p className="text-xs text-muted-foreground">Set an exact account count per agent.</p>
          </button>
          <button type="button" onClick={() => setMode("csv")}
            className={cn("rounded-lg border p-3 text-left transition-all", mode === "csv" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-accent/20")}>
            <div className="flex items-center gap-2 mb-1">
              <Upload className={cn("h-4 w-4", mode === "csv" ? "text-primary" : "text-muted-foreground")} />
              <span className="text-sm font-semibold text-foreground">CSV Upload</span>
            </div>
            <p className="text-xs text-muted-foreground">Upload a loan_id → agent_id mapping file.</p>
          </button>
        </div>

        {mode === "csv" && (
          <Card>
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Upload Mapping CSV</CardTitle>
            </CardHeader>
            <CardContent className="pt-2 space-y-3">
              <p className="text-xs text-muted-foreground">
                Two columns: <code className="rounded bg-muted px-1 py-0.5">loan_id</code> (matches each account's Loan / Account ID)
                and <code className="rounded bg-muted px-1 py-0.5">agent_id</code> (agent's email or name).
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={csvFileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleCsvFile(f); e.target.value = ""; }}
                />
                <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => csvFileInputRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />{csvFileName ? "Replace File" : "Choose CSV File"}
                </Button>
                <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={downloadCsvTemplate}>
                  <FileDown className="h-3.5 w-3.5" />Download Template
                </Button>
                {csvFileName && <span className="text-xs text-muted-foreground">{csvFileName}</span>}
              </div>

              {csvError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />{csvError}
                </div>
              )}

              {!csvError && csvFileName && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <CheckCircle2 className="h-3.5 w-3.5 text-success flex-shrink-0" />
                    <span className="font-medium text-foreground">{totalAlloc}</span>
                    <span className="text-muted-foreground">of {totalCount} accounts matched to an agent</span>
                  </div>
                  {csvUnmatchedLoanIds.length > 0 && (
                    <div className="text-xs text-orange-600">
                      {csvUnmatchedLoanIds.length} loan ID{csvUnmatchedLoanIds.length === 1 ? "" : "s"} not found in this portfolio
                      {" "}(e.g. {csvUnmatchedLoanIds.slice(0, 5).join(", ")}{csvUnmatchedLoanIds.length > 5 ? "…" : ""})
                    </div>
                  )}
                  {csvUnmatchedAgentIds.length > 0 && (
                    <div className="text-xs text-orange-600">
                      {csvUnmatchedAgentIds.length} agent ID{csvUnmatchedAgentIds.length === 1 ? "" : "s"} not found on your team
                      {" "}(e.g. {csvUnmatchedAgentIds.slice(0, 5).join(", ")}{csvUnmatchedAgentIds.length > 5 ? "…" : ""})
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Bucket grouping (visual — which agent specializes in which bucket) */}
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold flex items-center gap-1.5 text-muted-foreground uppercase tracking-wider">
              Group Agents by Bucket
              <Tooltip>
                <TooltipTrigger asChild><Info className="h-3.5 w-3.5 cursor-help" /></TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">Tag which agents should handle each DPD bucket — informational, doesn't change the split above.</TooltipContent>
              </Tooltip>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2 space-y-2">
            {BUCKET_ORDER.filter(b => bucketCounts[b] > 0).map(b => {
              const meta = BUCKET_META[b];
              return (
                <div key={b} className="flex items-center gap-3 flex-wrap">
                  <Badge variant="outline" className={cn("text-[10px] w-20 justify-center flex-shrink-0", meta.color)}>{meta.label}</Badge>
                  <span className="text-[10px] text-muted-foreground w-16 flex-shrink-0">{bucketCounts[b]} accts</span>
                  <div className="flex flex-wrap gap-1.5">
                    {agents.map(a => (
                      <button key={a.id} type="button" onClick={() => toggleBucketAgent(b, a.id)}
                        className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium border transition-all",
                          bucketGrouping[b].includes(a.id) ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:border-primary/40")}>
                        {a.name.split(" ")[0]}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Per-agent allocation */}
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Allocation · {totalAlloc}/{totalCount} assigned
              {remaining !== 0 && (
                <span className={cn("ml-2 normal-case font-normal", remaining > 0 ? "text-warning-foreground" : "text-destructive")}>
                  {remaining > 0 ? `${remaining} unallocated` : `${Math.abs(remaining)} over-allocated`}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {agents.map(a => {
                const count = mode === "csv" ? (csvAllocation[a.id]?.length ?? 0) : (counts[a.id] ?? 0);
                const pct = totalCount ? (count / totalCount) * 100 : 0;
                return (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">{a.name}</div>
                    </div>
                    <Progress value={Math.min(pct, 100)} className="h-1.5 w-24 flex-shrink-0" />
                    {mode === "manual" ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button type="button" onClick={() => adjustCount(a.id, -5)}
                          className="h-6 w-6 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                          <Minus className="h-3 w-3" />
                        </button>
                        <Input type="number" min={0} value={count}
                          onChange={e => setCounts(prev => ({ ...prev, [a.id]: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                          className="h-7 w-16 text-center text-xs" />
                        <button type="button" onClick={() => adjustCount(a.id, 5)}
                          className="h-6 w-6 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <span className="text-sm font-semibold text-foreground w-16 text-right flex-shrink-0">{count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
