import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef, useCallback } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, Clock, AlertCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/portfolio")({
  head: () => ({ meta: [{ title: "Portfolio Upload · RecoveryAI" }] }),
  component: PortfolioPage,
});

interface UploadRow {
  id: string; name: string; phone: string; loanAmount: string; dpd: string; email: string;
}

interface PreviousUpload {
  id: string; name: string; lender: string; accounts: number; scored: number;
  date: string; status: "ready" | "scoring" | "partial";
}

const PREVIOUS_UPLOADS: PreviousUpload[] = [
  { id: "UP-001", name: "Personal Loan Q1 2026", lender: "HDFC Bank", accounts: 320, scored: 320, date: "15 Jun 2026", status: "ready" },
  { id: "UP-002", name: "Credit Card NPA Jun", lender: "Bajaj Finance", accounts: 180, scored: 175, date: "10 Jun 2026", status: "partial" },
  { id: "UP-003", name: "MSME Working Capital", lender: "Axis Bank", accounts: 94, scored: 94, date: "01 Jun 2026", status: "ready" },
  { id: "UP-004", name: "Two-Wheeler Auto May", lender: "Sundaram Finance", accounts: 210, scored: 0, date: "22 Jun 2026", status: "scoring" },
];

const STATUS_CLS: Record<string, string> = {
  ready: "bg-success/15 text-success border-success/30",
  scoring: "bg-warning/20 text-warning-foreground border-warning/40",
  partial: "bg-muted text-muted-foreground border-border",
};

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  ready: CheckCircle2,
  scoring: Clock,
  partial: AlertCircle,
};

function PortfolioPage() {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadRow[]>([]);
  const [portfolioName, setPortfolioName] = useState("");
  const [lenderName, setLenderName] = useState("");
  const [productType, setProductType] = useState("");
  const [highPriority, setHighPriority] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const MOCK_PREVIEW: UploadRow[] = [
    { id: "L-20001", name: "Suresh Kumar", phone: "+91 98XXX XX111", loanAmount: "₹1,85,000", dpd: "34", email: "suresh.k@email.com" },
    { id: "L-20002", name: "Kavitha Nair", phone: "+91 97XXX XX222", loanAmount: "₹92,500", dpd: "12", email: "kavitha.n@email.com" },
    { id: "L-20003", name: "Deepak Shinde", phone: "+91 99XXX XX333", loanAmount: "₹3,40,000", dpd: "67", email: "deepak.s@email.com" },
    { id: "L-20004", name: "Nalini Pillai", phone: "+91 90XXX XX444", loanAmount: "₹55,000", dpd: "8", email: "nalini.p@email.com" },
    { id: "L-20005", name: "Girish Patil", phone: "+91 91XXX XX555", loanAmount: "₹2,10,000", dpd: "89", email: "girish.p@email.com" },
  ];

  const handleFile = useCallback((f: File) => {
    setFile(f);
    setPreview(MOCK_PREVIEW);
    if (!portfolioName) setPortfolioName(f.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "));
  }, [portfolioName]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith(".csv") || f.name.endsWith(".xlsx"))) {
      handleFile(f);
    } else {
      toast.error("Please upload a CSV or XLSX file.");
    }
  }, [handleFile]);

  const handleUpload = async () => {
    if (!file || !portfolioName || !lenderName || !productType) {
      toast.error("Please fill all fields before uploading.");
      return;
    }
    setUploading(true);
    setProgress(0);
    for (let p = 0; p <= 100; p += 10) {
      await new Promise((r) => setTimeout(r, 120));
      setProgress(p);
    }
    setUploading(false);
    toast.success(`Portfolio "${portfolioName}" uploaded. AI scoring started.`);
    setFile(null); setPreview([]); setPortfolioName(""); setLenderName(""); setProductType(""); setHighPriority(false); setProgress(0);
  };

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Portfolio Upload</h1>
        <p className="text-sm text-muted-foreground">Import debtor portfolios and trigger AI scoring.</p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => !file && inputRef.current?.click()}
            className={cn(
              "relative rounded-xl border-2 border-dashed transition-all duration-200 flex flex-col items-center justify-center gap-3 py-14 cursor-pointer",
              dragging ? "border-primary bg-primary/10 scale-[1.01]" : file ? "border-success/50 bg-success/5" : "border-border bg-card hover:border-primary/50 hover:bg-accent/30",
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx"
              className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            {file ? (
              <>
                <FileSpreadsheet className="h-10 w-10 text-success" />
                <div className="text-center">
                  <p className="font-medium text-foreground">{file.name}</p>
                  <p className="text-sm text-muted-foreground">{preview.length}+ rows detected (showing first 5)</p>
                </div>
                <Button size="sm" variant="ghost" className="absolute top-3 right-3 h-7 w-7 p-0 text-muted-foreground" onClick={(e) => { e.stopPropagation(); setFile(null); setPreview([]); }}>
                  <X className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Upload className={cn("h-10 w-10 transition-transform", dragging && "scale-110 text-primary")} />
                <div className="text-center">
                  <p className="font-medium text-foreground">Drop CSV or XLSX here</p>
                  <p className="text-sm text-muted-foreground">or click to browse your files</p>
                </div>
                <Badge variant="secondary" className="text-xs">Supports: .csv, .xlsx — max 50,000 rows</Badge>
              </>
            )}
          </div>

          {/* Preview table */}
          {preview.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-4 px-4">
                <CardTitle className="text-sm font-medium text-muted-foreground">Preview — first 5 rows</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Loan ID</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead className="text-right">Loan Amount</TableHead>
                        <TableHead>DPD</TableHead>
                        <TableHead>Email</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.map((r) => (
                        <TableRow key={r.id} className="text-sm">
                          <TableCell className="font-mono text-xs text-muted-foreground">{r.id}</TableCell>
                          <TableCell className="font-medium text-foreground">{r.name}</TableCell>
                          <TableCell className="font-mono text-xs">{r.phone}</TableCell>
                          <TableCell className="text-right">{r.loanAmount}</TableCell>
                          <TableCell>{r.dpd}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.email}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Progress */}
          {uploading && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Uploading & scoring…</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          {/* Upload button */}
          {file && (
            <Button onClick={handleUpload} disabled={uploading} className="gap-2 transition-all active:scale-95">
              <Upload className="h-4 w-4" />
              {uploading ? "Uploading…" : "Upload & Score"}
            </Button>
          )}
        </div>

        {/* Metadata form */}
        <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-500 delay-150">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Portfolio Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Portfolio Name</Label>
                <Input placeholder="e.g. Personal Loan Q2 2026" value={portfolioName} onChange={(e) => setPortfolioName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Lender / Client</Label>
                <Input placeholder="e.g. HDFC Bank" value={lenderName} onChange={(e) => setLenderName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Product Type</Label>
                <Select value={productType} onValueChange={setProductType}>
                  <SelectTrigger><SelectValue placeholder="Select product…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal Loan</SelectItem>
                    <SelectItem value="auto">Auto / Two-Wheeler</SelectItem>
                    <SelectItem value="cc">Credit Card NPA</SelectItem>
                    <SelectItem value="msme">MSME / Business Loan</SelectItem>
                    <SelectItem value="hl">Home Loan</SelectItem>
                    <SelectItem value="gold">Gold Loan</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between pt-1">
                <div>
                  <Label className="text-xs font-medium">High Priority</Label>
                  <p className="text-[11px] text-muted-foreground">Surface this portfolio at the top of every agent's queue.</p>
                </div>
                <Switch checked={highPriority} onCheckedChange={setHighPriority} />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Previous uploads */}
      <Card className="animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
        <CardHeader className="border-b border-border">
          <CardTitle className="text-base font-semibold">Previous Uploads</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Portfolio Name</TableHead>
                  <TableHead>Lender</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">Scored</TableHead>
                  <TableHead>Upload Date</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PREVIOUS_UPLOADS.map((u) => {
                  const StatusIcon = STATUS_ICON[u.status];
                  return (
                    <TableRow key={u.id} className="hover:bg-primary/5 transition-colors cursor-pointer">
                      <TableCell>
                        <div className="font-medium text-foreground text-sm">{u.name}</div>
                        <div className="text-xs text-muted-foreground">{u.id}</div>
                      </TableCell>
                      <TableCell className="text-sm text-foreground">{u.lender}</TableCell>
                      <TableCell className="text-right font-medium text-foreground">{u.accounts.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{u.scored.toLocaleString()}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{u.date}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("gap-1 capitalize", STATUS_CLS[u.status])}>
                          <StatusIcon className="h-3 w-3" />
                          {u.status}
                        </Badge>
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
  );
}
