import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import {
  Phone, MessageCircle, Link2, HandCoins, Search, X, Clock, CheckCheck, Check,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { MOCK_DEBTORS, bucketOf, formatINR, type Debtor } from "@/lib/mock-debtors";

export const Route = createFileRoute("/dashboard/debtors")({
  head: () => ({ meta: [{ title: "Debtor Profiles · RecoveryAI" }] }),
  component: DebtorsPage,
});

const EXTRA: Record<string, { lender: string; product: string; originalAmount: number; emi: number; callHistory: { date: string; duration: string; outcome: string; note: string }[]; payments: { date: string; amount: number; method: string; ref: string }[]; disputes: { id: string; type: string; status: "open" | "resolved" | "escalated"; raised: string }[] }> = {
  "L-10042": {
    lender: "HDFC Bank", product: "Personal Loan", originalAmount: 300000, emi: 8200,
    callHistory: [
      { date: "22 Jun, 10:14 AM", duration: "4m 22s", outcome: "PTP", note: "Will pay by 25th June via UPI" },
      { date: "20 Jun, 11:45 AM", duration: "2m 05s", outcome: "Callback", note: "Asked to call back after 6 PM" },
      { date: "18 Jun, 03:30 PM", duration: "0m 45s", outcome: "No answer", note: "" },
    ],
    payments: [{ date: "15 May 2026", amount: 8200, method: "UPI", ref: "UPI202605151234" }],
    disputes: [],
  },
  "L-10018": {
    lender: "Bajaj Finance", product: "Credit Card NPA", originalAmount: 120000, emi: 3800,
    callHistory: [
      { date: "22 Jun, 09:00 AM", duration: "6m 10s", outcome: "PTP", note: "Salary credited, will settle this week" },
    ],
    payments: [],
    disputes: [{ id: "D-001", type: "Interest waiver request", status: "open", raised: "10 Jun 2026" }],
  },
};

function getExtra(id: string) {
  return EXTRA[id] ?? {
    lender: "Axis Bank", product: "Personal Loan", originalAmount: 0, emi: 0,
    callHistory: [], payments: [], disputes: [],
  };
}

function DebtorsPage() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Debtor | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return MOCK_DEBTORS;
    return MOCK_DEBTORS.filter(
      (d) => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q),
    );
  }, [search]);

  return (
    <>
      <div className="space-y-6">
        <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Debtor Profiles</h1>
            <p className="text-sm text-muted-foreground">360° view of every borrower in your queue.</p>
          </div>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search name or loan ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((d, i) => (
            <DebtorCard key={d.id} d={d} index={i} onView={() => setSelected(d)} />
          ))}
          {filtered.length === 0 && (
            <p className="col-span-full py-16 text-center text-sm text-muted-foreground">No debtors found.</p>
          )}
        </div>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent side="right" className="w-full max-w-2xl overflow-y-auto p-0 sm:max-w-2xl">
          {selected && <DebtorProfile d={selected} onClose={() => setSelected(null)} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

function DebtorCard({ d, index, onView }: { d: Debtor; index: number; onView: () => void }) {
  const b = bucketOf(d.dpd);
  const dpdCls =
    b === "0-30" ? "bg-success/15 text-success border-success/30"
      : b === "31-60" ? "bg-warning/20 text-warning-foreground border-warning/40"
        : "bg-destructive/15 text-destructive border-destructive/30";
  const scoreCls =
    d.aiScore >= 8 ? "bg-success text-success-foreground"
      : d.aiScore >= 5 ? "bg-warning text-warning-foreground"
        : "bg-destructive text-destructive-foreground";
  const initials = d.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase();

  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both transition-all duration-200 hover:shadow-lg hover:shadow-primary/10 hover:-translate-y-0.5"
      style={{ animationDelay: `${Math.min(index * 50, 400)}ms` }}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-primary/20 text-primary text-sm font-semibold">{initials}</AvatarFallback>
            </Avatar>
            <div>
              <div className="font-medium text-foreground text-sm">{d.name}</div>
              <div className="text-xs text-muted-foreground">{d.id}</div>
            </div>
          </div>
          <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold", scoreCls)}>
            {d.aiScore}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={cn("text-xs", dpdCls)}>DPD {d.dpd}d</Badge>
          <Badge variant="secondary" className="text-xs">{d.portfolio}</Badge>
        </div>

        <div className="text-xs text-muted-foreground font-mono">{d.phone}</div>

        <div className="flex items-center justify-between pt-1">
          <div>
            <div className="text-base font-semibold text-foreground">{formatINR(d.loanAmount)}</div>
            <div className="text-xs text-muted-foreground">Outstanding</div>
          </div>
          <Button size="sm" variant="outline" onClick={onView} className="text-xs h-8">
            View Profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DebtorProfile({ d, onClose }: { d: Debtor; onClose: () => void }) {
  const extra = getExtra(d.id);
  const b = bucketOf(d.dpd);
  const dpdCls =
    b === "0-30" ? "bg-success/15 text-success border-success/30"
      : b === "31-60" ? "bg-warning/20 text-warning-foreground border-warning/40"
        : "bg-destructive/15 text-destructive border-destructive/30";
  const initials = d.name.split(" ").map((n) => n[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="flex flex-col h-full">
      <SheetHeader className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Avatar className="h-12 w-12">
            <AvatarFallback className="bg-primary/20 text-primary font-semibold">{initials}</AvatarFallback>
          </Avatar>
          <div>
            <SheetTitle className="text-lg">{d.name}</SheetTitle>
            <p className="text-xs text-muted-foreground">{d.id} · {d.phone} · {d.language}</p>
          </div>
        </div>
      </SheetHeader>

      {/* Loan summary */}
      <div className="px-6 py-4 bg-accent/30 grid grid-cols-2 gap-x-6 gap-y-2 text-sm border-b border-border">
        {[
          ["Lender", extra.lender],
          ["Product", extra.product],
          ["Original Amount", formatINR(extra.originalAmount)],
          ["Outstanding", formatINR(d.loanAmount)],
          ["EMI", formatINR(extra.emi)],
          ["DPD", <Badge key="dpd" variant="outline" className={cn("text-xs", dpdCls)}>{d.dpd} days</Badge>],
          ["Portfolio", d.portfolio],
          ["AI Score", <span key="score" className="font-semibold text-primary">{d.aiScore}/10</span>],
        ].map(([label, val]) => (
          <div key={String(label)}>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="font-medium text-foreground">{val}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-y-auto">
        <Tabs defaultValue="calls" className="h-full">
          <TabsList className="w-full rounded-none border-b border-border bg-transparent px-6 h-10 justify-start gap-1">
            {["calls", "messages", "payments", "disputes"].map((t) => (
              <TabsTrigger key={t} value={t} className="capitalize text-xs data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none pb-2">
                {t}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="calls" className="px-6 py-4 space-y-3">
            {extra.callHistory.length === 0 && <p className="text-sm text-muted-foreground">No call history yet.</p>}
            {extra.callHistory.map((c, i) => (
              <div key={i} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div className="h-2.5 w-2.5 rounded-full bg-primary mt-1" />
                  {i < extra.callHistory.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                </div>
                <div className="pb-4">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-foreground">{c.outcome}</span>
                    <span className="text-muted-foreground">·</span>
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground text-xs">{c.duration}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{c.date}</div>
                  {c.note && <div className="mt-1 text-xs text-foreground/80 bg-accent rounded px-2 py-1">{c.note}</div>}
                </div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="messages" className="px-6 py-4 space-y-2">
            {[
              { out: true, text: "Namaste Rahul ji, aapka EMI ₹8,200 due hai. Kripya aaj payment karein.", time: "10:15 AM", status: "read" },
              { out: false, text: "Haan sir, kal tak kar dunga UPI se.", time: "10:18 AM", status: "" },
              { out: true, text: "Shukriya! Payment link: pay.recoveryai.in/L10042", time: "10:19 AM", status: "delivered" },
            ].map((m, i) => (
              <div key={i} className={cn("flex", m.out ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[75%] rounded-2xl px-3 py-2 text-sm", m.out ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-card border border-border text-foreground rounded-bl-sm")}>
                  <p>{m.text}</p>
                  <div className={cn("flex items-center gap-1 mt-1 text-[10px]", m.out ? "justify-end text-primary-foreground/70" : "text-muted-foreground")}>
                    {m.time}
                    {m.status === "read" && <CheckCheck className="h-3 w-3 text-blue-400" />}
                    {m.status === "delivered" && <CheckCheck className="h-3 w-3" />}
                    {m.status === "sent" && <Check className="h-3 w-3" />}
                  </div>
                </div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="payments" className="px-6 py-4">
            {extra.payments.length === 0 && <p className="text-sm text-muted-foreground">No payments recorded.</p>}
            <div className="space-y-2">
              {extra.payments.map((p, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
                  <div>
                    <div className="font-medium text-foreground">{formatINR(p.amount)}</div>
                    <div className="text-xs text-muted-foreground">{p.date} · {p.ref}</div>
                  </div>
                  <Badge variant="secondary">{p.method}</Badge>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="disputes" className="px-6 py-4 space-y-3">
            {extra.disputes.length === 0 && <p className="text-sm text-muted-foreground">No disputes raised.</p>}
            {extra.disputes.map((disp) => (
              <div key={disp.id} className="rounded-lg border border-border p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">{disp.type}</span>
                  <Badge variant={disp.status === "resolved" ? "secondary" : disp.status === "escalated" ? "destructive" : "outline"} className="capitalize">
                    {disp.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">{disp.id} · Raised {disp.raised}</div>
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </div>

      {/* Action bar */}
      <div className="border-t border-border px-6 py-3 flex flex-wrap gap-2 bg-card">
        <Button size="sm" className="gap-1.5 h-8 transition-all active:scale-95" onClick={() => toast.success("Initiating call to " + d.name)}>
          <Phone className="h-3.5 w-3.5" />Call Now
        </Button>
        <Button size="sm" className="gap-1.5 h-8 bg-success text-success-foreground hover:bg-success/90 transition-all active:scale-95" onClick={() => toast.success("WhatsApp opened for " + d.name)}>
          <MessageCircle className="h-3.5 w-3.5" />Send WhatsApp
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5 h-8 transition-all active:scale-95" onClick={() => { navigator.clipboard?.writeText("https://pay.recoveryai.in/" + d.id); toast.success("Payment link copied to clipboard"); }}>
          <Link2 className="h-3.5 w-3.5" />Generate Payment Link
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5 h-8 transition-all active:scale-95" onClick={() => toast.info("Settlement workflow initiated")}>
          <HandCoins className="h-3.5 w-3.5" />Raise Settlement
        </Button>
      </div>
    </div>
  );
}
