import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, Copy, ExternalLink, IndianRupee, Clock, CheckCircle2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatINR } from "@/lib/mock-debtors";

export const Route = createFileRoute("/dashboard/payments")({
  head: () => ({ meta: [{ title: "Payments · RecoveryAI" }] }),
  component: PaymentsPage,
});

const PAYMENT_LINKS = [
  { id: "PL-001", debtor: "Rahul Sharma", loanId: "L-10042", amount: 8200, status: "pending", via: "WhatsApp", created: "22 Jun 2026", expires: "24 Jun 2026", link: "pay.recoveryai.in/L10042" },
  { id: "PL-002", debtor: "Priya Iyer", loanId: "L-10018", amount: 87500, status: "paid", via: "SMS", created: "21 Jun 2026", expires: "23 Jun 2026", link: "pay.recoveryai.in/L10018" },
  { id: "PL-003", debtor: "Ananya Bose", loanId: "L-10455", amount: 15000, status: "pending", via: "WhatsApp", created: "21 Jun 2026", expires: "23 Jun 2026", link: "pay.recoveryai.in/L10455" },
  { id: "PL-004", debtor: "Karthik Nair", loanId: "L-10122", amount: 5200, status: "expired", via: "Email", created: "18 Jun 2026", expires: "20 Jun 2026", link: "pay.recoveryai.in/L10122" },
  { id: "PL-005", debtor: "Meera Joshi", loanId: "L-10277", amount: 9500, status: "pending", via: "WhatsApp", created: "22 Jun 2026", expires: "24 Jun 2026", link: "pay.recoveryai.in/L10277" },
];

const RECEIVED = [
  { id: "RX-001", debtor: "Amit Verma", loanId: "L-10211", amount: 50000, method: "UPI", ref: "UPI20260622AMTV", date: "22 Jun 2026 09:45 AM" },
  { id: "RX-002", debtor: "Priya Iyer", loanId: "L-10018", amount: 87500, method: "NEFT", ref: "NEFT20260621PIY1", date: "21 Jun 2026 04:12 PM" },
  { id: "RX-003", debtor: "Divya Krishnan", loanId: "L-10333", amount: 27500, method: "UPI", ref: "UPI20260622DIVK", date: "22 Jun 2026 11:30 AM" },
  { id: "RX-004", debtor: "Rahul Sharma", loanId: "L-10042", amount: 8200, method: "eNACH", ref: "NACH20260515RHS1", date: "15 May 2026 12:00 AM" },
];

const STATS = [
  { label: "Collected Today", value: "₹1,65,000", sub: "+12% vs yesterday", icon: IndianRupee, tone: "success" },
  { label: "Collected This Month", value: "₹28,40,500", sub: "82% of monthly target", icon: CheckCircle2, tone: "primary" },
  { label: "Pending Links", value: "3", sub: "₹32,700 at risk", icon: Clock, tone: "warning" },
  { label: "Auto-reconciled", value: "94%", sub: "Today's transactions", icon: Zap, tone: "info" },
];

const STATUS_CLS: Record<string, string> = {
  paid: "bg-success/15 text-success border-success/30",
  pending: "bg-warning/20 text-warning-foreground border-warning/40",
  expired: "bg-destructive/15 text-destructive border-destructive/30",
};

const METHOD_CLS: Record<string, string> = {
  UPI: "bg-primary/15 text-primary border-primary/30",
  NEFT: "bg-muted text-muted-foreground border-border",
  RTGS: "bg-muted text-muted-foreground border-border",
  eNACH: "bg-accent text-accent-foreground border-border",
  Cash: "bg-success/15 text-success border-success/30",
};

function PaymentsPage() {
  const [generateOpen, setGenerateOpen] = useState(false);
  const [genDebtor, setGenDebtor] = useState("");
  const [genAmount, setGenAmount] = useState("");
  const [genType, setGenType] = useState("");
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!genDebtor || !genAmount) return;
    setGenerating(true);
    await new Promise((r) => setTimeout(r, 700));
    setGenerating(false);
    setGenerateOpen(false);
    toast.success("Payment link generated and sent via WhatsApp");
    setGenDebtor(""); setGenAmount(""); setGenType("");
  };

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Payments</h1>
          <p className="text-sm text-muted-foreground">Track payment links, receipts and auto-reconciliation.</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setGenerateOpen(true)}>
          <Plus className="h-4 w-4" />Generate Link
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STATS.map((s, i) => (
          <Card
            key={s.label}
            className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-primary/10"
            style={{ animationDelay: `${i * 75}ms` }}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{s.label}</CardTitle>
              <s.icon className={cn("h-4 w-4", s.tone === "success" ? "text-success" : s.tone === "warning" ? "text-warning-foreground" : s.tone === "info" ? "text-muted-foreground" : "text-primary")} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold text-foreground">{s.value}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <Card className="animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
        <Tabs defaultValue="links">
          <CardHeader className="border-b border-border pb-0">
            <TabsList className="bg-transparent p-0 h-10">
              <TabsTrigger value="links" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary pb-2 text-sm">
                Payment Links
              </TabsTrigger>
              <TabsTrigger value="received" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary pb-2 text-sm">
                Received
              </TabsTrigger>
            </TabsList>
          </CardHeader>

          <TabsContent value="links" className="m-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Debtor</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sent Via</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {PAYMENT_LINKS.map((pl) => (
                    <TableRow key={pl.id} className="hover:bg-primary/5 transition-colors cursor-pointer">
                      <TableCell>
                        <div className="font-medium text-foreground text-sm">{pl.debtor}</div>
                        <div className="text-xs text-muted-foreground">{pl.loanId}</div>
                      </TableCell>
                      <TableCell className="text-right font-medium text-foreground">{formatINR(pl.amount)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("capitalize", STATUS_CLS[pl.status])}>{pl.status}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{pl.via}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{pl.created}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{pl.expires}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm" variant="ghost" className="h-7 gap-1 text-xs transition-all active:scale-95"
                          onClick={() => { navigator.clipboard?.writeText("https://" + pl.link); toast.success("Link copied!"); }}
                        >
                          <Copy className="h-3 w-3" />Copy
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="received" className="m-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Debtor</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Date & Time</TableHead>
                    <TableHead className="text-right">Receipt</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {RECEIVED.map((rx) => (
                    <TableRow key={rx.id} className="hover:bg-primary/5 transition-colors cursor-pointer">
                      <TableCell>
                        <div className="font-medium text-foreground text-sm">{rx.debtor}</div>
                        <div className="text-xs text-muted-foreground">{rx.loanId}</div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-success">{formatINR(rx.amount)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("text-xs", METHOD_CLS[rx.method] ?? "")}>{rx.method}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{rx.ref}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{rx.date}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs transition-all active:scale-95" onClick={() => toast.info("Downloading receipt " + rx.ref)}>
                          <ExternalLink className="h-3 w-3" />View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        </Tabs>
      </Card>

      {/* Generate link dialog */}
      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate Payment Link</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Debtor</Label>
              <Select value={genDebtor} onValueChange={setGenDebtor}>
                <SelectTrigger><SelectValue placeholder="Select debtor…" /></SelectTrigger>
                <SelectContent>
                  {["Rahul Sharma (L-10042)", "Priya Iyer (L-10018)", "Amit Verma (L-10211)", "Sneha Reddy (L-10087)", "Ananya Bose (L-10455)"].map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount (₹)</Label>
              <Input type="number" placeholder="e.g. 8200" value={genAmount} onChange={(e) => setGenAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Payment Type</Label>
              <Select value={genType} onValueChange={setGenType}>
                <SelectTrigger><SelectValue placeholder="Select type…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="emi">EMI Payment</SelectItem>
                  <SelectItem value="partial">Partial Settlement</SelectItem>
                  <SelectItem value="full">Full & Final Settlement</SelectItem>
                  <SelectItem value="penalty">Penalty / Late Fee</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={generating || !genDebtor || !genAmount}>
              {generating ? "Generating…" : "Generate & Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
