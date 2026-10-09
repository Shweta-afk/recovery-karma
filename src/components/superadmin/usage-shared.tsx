// Shared pieces of the superadmin Overview and Companies pages — both read the same
// getPlatformUsage report, so the window picker, the fetch hook and the small badges live here.

import { useCallback, useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import { getPlatformUsage } from "@/lib/platform-usage.server";
import {
  pctChange,
  USAGE_WINDOWS,
  type CompanyHealth,
  type PlatformUsageReport,
  type UsageWindow,
} from "@/lib/platform-usage";

const WINDOW_KEY = "superadmin-usage-window";

function readWindow(): UsageWindow {
  try {
    const n = Number(localStorage.getItem(WINDOW_KEY));
    return (USAGE_WINDOWS as readonly number[]).includes(n) ? (n as UsageWindow) : 30;
  } catch {
    return 30;
  }
}

/** The report for the chosen window; the window is remembered per browser and shared by the
 *  Overview and Companies pages. */
export function usePlatformUsage() {
  const [windowDays, setWindowDaysState] = useState<UsageWindow>(30);
  const [report, setReport] = useState<PlatformUsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => setWindowDaysState(readWindow()), []);

  const setWindowDays = (w: UsageWindow) => {
    setWindowDaysState(w);
    try {
      localStorage.setItem(WINDOW_KEY, String(w));
    } catch {
      // Remembering the choice is a convenience only.
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const accessToken = await getAccessToken();
      setReport(await getPlatformUsage({ data: { accessToken, windowDays } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load platform usage");
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    load();
  }, [load]);

  return { windowDays, setWindowDays, report, loading, reload: load };
}

export function WindowPicker({
  value,
  onChange,
}: {
  value: UsageWindow;
  onChange: (w: UsageWindow) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v) as UsageWindow)}>
      <SelectTrigger className="h-8 w-40 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {USAGE_WINDOWS.map((w) => (
          <SelectItem key={w} value={String(w)} className="text-xs">
            Last {w} days
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export const HEALTH_META: Record<
  CompanyHealth,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; hint: string }
> = {
  active: { label: "Active", variant: "default", hint: "Using calling or Insights this period" },
  slowing: {
    label: "Slowing",
    variant: "outline",
    hint: "Calls + lookups fell below 60% of the previous period",
  },
  dormant: { label: "Dormant", variant: "destructive", hint: "No calls or lookups this period" },
  new: { label: "New", variant: "secondary", hint: "Joined in the last 14 days, no usage yet" },
  not_live: { label: "Not live", variant: "secondary", hint: "Pending or rejected" },
};

export function HealthBadge({ health }: { health: CompanyHealth }) {
  const m = HEALTH_META[health];
  return (
    <Badge
      variant={m.variant}
      title={m.hint}
      className={
        health === "slowing" ? "border-amber-500/50 text-[10px] text-amber-600" : "text-[10px]"
      }
    >
      {m.label}
    </Badge>
  );
}

/** "+12%" / "−40%" against the previous period; nothing when there's no base to compare. */
export function Trend({ current, previous }: { current: number; previous: number }) {
  const p = pctChange(current, previous);
  if (p === null) {
    return current > 0 ? <span className="text-[10px] text-muted-foreground">new</span> : null;
  }
  if (Math.abs(p) < 0.005) return <span className="text-[10px] text-muted-foreground">±0%</span>;
  const up = p > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center text-[10px] font-medium ${up ? "text-emerald-600" : "text-destructive"}`}
    >
      <Icon className="h-3 w-3" />
      {up ? "+" : "−"}
      {Math.round(Math.abs(p) * 100)}%
    </span>
  );
}

export const fmtInt = (n: number) => n.toLocaleString("en-IN");
export const fmtMoney = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtPct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
export function fmtTalk(seconds: number) {
  if (seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "3h ago" / "5d ago" / "—" — relative, because "is anyone there?" is the question. */
export function fmtAgo(iso: string | null, now = Date.now()) {
  if (!iso) return "—";
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 60 ? `${days}d ago` : new Date(iso).toLocaleDateString("en-IN");
}
