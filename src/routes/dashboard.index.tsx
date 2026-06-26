import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Phone,
  MessageCircle,
  SkipForward,
  Search,
  PhoneCall,
  Target,
  CheckCircle2,
  Clock,
  XCircle,
  PhoneOff,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import {
  MOCK_DEBTORS,
  PORTFOLIOS,
  TODAY_STATS,
  bucketOf,
  formatINR,
  type Debtor,
} from "@/lib/mock-debtors";
import { useEffect, useRef } from "react";

export const Route = createFileRoute("/dashboard/")({
  head: () => ({
    meta: [
      { title: "Call Queue · RecoveryAI" },
      {
        name: "description",
        content:
          "AI-prioritised call queue for collections agents. Today's debtor list ranked by likelihood to pay.",
      },
    ],
  }),
  component: DashboardPage,
});

type SortKey = "name" | "loanAmount" | "dpd" | "aiScore" | "lastContacted";
type SortDir = "asc" | "desc";

function DashboardPage() {
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState<string>("all");
  const [portfolio, setPortfolio] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("aiScore");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = MOCK_DEBTORS.filter((d) => {
      if (bucket !== "all" && bucketOf(d.dpd) !== bucket) return false;
      if (portfolio !== "all" && d.portfolio !== portfolio) return false;
      if (q && !d.name.toLowerCase().includes(q) && !d.id.toLowerCase().includes(q))
        return false;
      return true;
    });

    rows = [...rows].sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      switch (sortKey) {
        case "name":
          av = a.name;
          bv = b.name;
          break;
        case "loanAmount":
          av = a.loanAmount;
          bv = b.loanAmount;
          break;
        case "dpd":
          av = a.dpd;
          bv = b.dpd;
          break;
        case "aiScore":
          av = a.aiScore;
          bv = b.aiScore;
          break;
        case "lastContacted":
          av = a.lastContacted ?? "";
          bv = b.lastContacted ?? "";
          break;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [search, bucket, portfolio, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const targetPct = Math.round((TODAY_STATS.callsMade / TODAY_STATS.target) * 100);

  const statCards = [
    { label: "Calls Made", value: TODAY_STATS.callsMade.toString(), hint: `${targetPct}% of target`, icon: PhoneCall, tone: undefined },
    { label: "Daily Target", value: TODAY_STATS.target.toString(), hint: `${TODAY_STATS.target - TODAY_STATS.callsMade} remaining`, icon: Target, tone: undefined },
    { label: "Paid", value: TODAY_STATS.outcomes.paid.toString(), hint: "Today", icon: CheckCircle2, tone: "success" as const },
    { label: "Promised", value: TODAY_STATS.outcomes.promised.toString(), hint: "PTP open", icon: Clock, tone: "info" as const },
    { label: "Refused", value: TODAY_STATS.outcomes.refused.toString(), hint: "Today", icon: XCircle, tone: "danger" as const },
    { label: "No Answer", value: TODAY_STATS.outcomes.noAnswer.toString(), hint: "Re-queue", icon: PhoneOff, tone: "warning" as const },
  ];

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Call Queue</h1>
        <p className="text-sm text-muted-foreground">
          AI-prioritised debtors for today. Highest scoring accounts surface first.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {statCards.map((card, index) => (
          <StatCard
            key={card.label}
            label={card.label}
            value={card.value}
            hint={card.hint}
            icon={card.icon}
            tone={card.tone}
            index={index}
          />
        ))}
      </div>

      <Card className="animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
        <CardHeader className="gap-4 border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base font-semibold">
              Today's Queue
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {filtered.length} of {MOCK_DEBTORS.length} accounts
              </span>
            </CardTitle>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or loan ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>

            <Select value={bucket} onValueChange={setBucket}>
              <SelectTrigger className="w-full sm:w-[170px]">
                <SelectValue placeholder="DPD Bucket" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All DPD buckets</SelectItem>
                <SelectItem value="0-30">0–30 days</SelectItem>
                <SelectItem value="31-60">31–60 days</SelectItem>
                <SelectItem value="61-90">61–90 days</SelectItem>
                <SelectItem value="90+">90+ days</SelectItem>
              </SelectContent>
            </Select>

            <Select value={portfolio} onValueChange={setPortfolio}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Portfolio" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All portfolios</SelectItem>
                {PORTFOLIOS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Debtor" sortKey="name" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <TableHead>Phone</TableHead>
                  <SortableHead label="Loan Amount" sortKey="loanAmount" activeKey={sortKey} dir={sortDir} onClick={toggleSort} className="text-right" />
                  <SortableHead label="DPD" sortKey="dpd" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <SortableHead label="AI Score" sortKey="aiScore" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <TableHead className="min-w-[220px]">Score Reason</TableHead>
                  <SortableHead label="Last Contact" sortKey="lastContacted" activeKey={sortKey} dir={sortDir} onClick={toggleSort} />
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((d, index) => (
                  <DebtorRow key={d.id} d={d} index={index} />
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-12 text-center text-sm text-muted-foreground">
                      No debtors match your filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SortableHead({
  label, sortKey, activeKey, dir, onClick, className,
}: {
  label: string; sortKey: SortKey; activeKey: SortKey; dir: SortDir;
  onClick: (k: SortKey) => void; className?: string;
}) {
  const active = activeKey === sortKey;
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}

function DPDBadge({ dpd }: { dpd: number }) {
  const b = bucketOf(dpd);
  const cls =
    b === "0-30"
      ? "bg-success/15 text-success border-success/30 shadow-sm shadow-success/30"
      : b === "31-60"
        ? "bg-warning/20 text-warning-foreground border-warning/40 shadow-sm shadow-warning/30"
        : "bg-destructive/15 text-destructive border-destructive/30 shadow-sm shadow-destructive/30";
  return (
    <Badge variant="outline" className={cn("font-medium", cls)}>
      {dpd} d
    </Badge>
  );
}

function AIScore({ score }: { score: number }) {
  const tone =
    score >= 8
      ? "bg-success text-success-foreground"
      : score >= 5
        ? "bg-warning text-warning-foreground"
        : "bg-destructive text-destructive-foreground";

  const [pulsing, setPulsing] = useState(score >= 8);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (score >= 8) {
      timerRef.current = setTimeout(() => setPulsing(false), 2000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [score]);

  return (
    <div className="flex items-center gap-2">
      <span className={cn("flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold", tone, pulsing && "animate-pulse")}>
        {score}
      </span>
      <span className="text-xs text-muted-foreground">/10</span>
    </div>
  );
}

function DebtorRow({ d, index }: { d: Debtor; index: number }) {
  const delay = Math.min(index * 40, 500);
  return (
    <TableRow
      className="animate-in fade-in duration-300 align-top transition-colors duration-150 hover:bg-primary/5 cursor-pointer"
      style={{ animationDelay: `${delay}ms` }}
    >
      <TableCell>
        <div className="font-medium text-foreground">{d.name}</div>
        <div className="text-xs text-muted-foreground">{d.id} · {d.portfolio}</div>
      </TableCell>
      <TableCell className="font-mono text-xs text-foreground">{d.phone}</TableCell>
      <TableCell className="text-right font-medium text-foreground">{formatINR(d.loanAmount)}</TableCell>
      <TableCell><DPDBadge dpd={d.dpd} /></TableCell>
      <TableCell><AIScore score={d.aiScore} /></TableCell>
      <TableCell className="max-w-[280px]">
        <p className="text-sm text-foreground/90">{d.scoreReason}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Lang: {d.language}</p>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
        {d.lastContacted
          ? new Date(d.lastContacted).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
          : "—"}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1.5">
          <Button size="sm" className="h-8 gap-1.5 transition-all duration-150 active:scale-95">
            <Phone className="h-3.5 w-3.5" />Call
          </Button>
          <Button size="sm" className="h-8 gap-1.5 bg-success text-success-foreground hover:bg-success/90 transition-all duration-150 active:scale-95">
            <MessageCircle className="h-3.5 w-3.5" />WhatsApp
          </Button>
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-muted-foreground transition-all duration-150 active:scale-95">
            <SkipForward className="h-3.5 w-3.5" />Skip
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function StatCard({
  label, value, hint, icon: Icon, tone, index,
}: {
  label: string; value: string; hint: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "success" | "warning" | "danger" | "info";
  index: number;
}) {
  const toneCls =
    tone === "success" ? "text-success"
      : tone === "warning" ? "text-warning-foreground"
        : tone === "danger" ? "text-destructive"
          : tone === "info" ? "text-primary"
            : "text-muted-foreground";
  return (
    <Card
      className="animate-in fade-in slide-in-from-bottom-4 duration-500 fill-mode-both transition-all duration-200 hover:scale-[1.02] hover:shadow-lg hover:shadow-primary/10"
      style={{ animationDelay: `${index * 75}ms` }}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</CardTitle>
        <Icon className={cn("h-4 w-4", toneCls)} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold text-foreground">{value}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
