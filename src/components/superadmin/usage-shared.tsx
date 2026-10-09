// Shared pieces of the superadmin portal: the one date filter every page uses, the
// getPlatformUsage fetch hook, and the small badges/formatters the usage tables share.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DateRangeFilter } from "@/components/date-range-filter";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/lib/access-token";
import { EMPTY_RANGE, type DateRange } from "@/lib/date-filter";
import { getPlatformUsage, type PlatformUsageResponse } from "@/lib/platform-usage.server";
import { pctChange, type CompanyHealth } from "@/lib/platform-usage";
import { GLOSSARY, type GlossaryKey } from "@/lib/superadmin-glossary";
import { InfoTip } from "@/components/superadmin/help";
import {
  DEFAULT_RANGE_PRESET,
  matchingPreset,
  presetRange,
  RANGE_PRESETS,
  rangeLabel,
  type RangePreset,
} from "@/lib/superadmin-range";

const RANGE_KEY = "superadmin-date-range";

/** What is remembered: a preset (so "30 days" keeps rolling forward) or explicit days. */
type StoredRange = { preset: RangePreset } | { from: string; to: string };

function readStoredRange(): DateRange {
  try {
    const raw = localStorage.getItem(RANGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as StoredRange;
      if ("preset" in v && RANGE_PRESETS.some((p) => p.value === v.preset)) {
        return presetRange(v.preset);
      }
      if ("from" in v && typeof v.from === "string" && typeof v.to === "string") {
        return { from: v.from, to: v.to };
      }
    }
  } catch {
    // Unreadable storage just means the default range.
  }
  return presetRange(DEFAULT_RANGE_PRESET);
}

/** The date range for a superadmin page — one range remembered per browser and shared by
 *  every superadmin page, so moving between pages keeps the period you were looking at. */
export function useSuperadminRange() {
  const [range, setRangeState] = useState<DateRange>(() => presetRange(DEFAULT_RANGE_PRESET));
  // Read after mount: localStorage doesn't exist during SSR.
  useEffect(() => setRangeState(readStoredRange()), []);
  const setRange = useCallback((next: DateRange) => {
    setRangeState(next);
    try {
      const preset = matchingPreset(next);
      localStorage.setItem(RANGE_KEY, JSON.stringify(preset ? { preset } : next));
    } catch {
      // Remembering the choice is a convenience only.
    }
  }, []);
  return [range, setRange] as const;
}

/** Preset chips + the same From/To date control admins use. With `allowAll`, clearing the
 *  dates means "all dates" (list pages); reports always need a bounded range. */
export function SuperadminDateFilter({
  value,
  onChange,
  allowAll = false,
  className,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  allowAll?: boolean;
  className?: string;
}) {
  const active = matchingPreset(value);
  const chip = (selected: boolean) =>
    cn(
      "h-7 rounded-md border px-2 text-[11px] font-medium transition-colors",
      selected
        ? "border-primary bg-primary text-primary-foreground"
        : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
    );
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {RANGE_PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          className={chip(active === p.value)}
          onClick={() => onChange(presetRange(p.value))}
        >
          {p.label}
        </button>
      ))}
      {allowAll && (
        <button
          type="button"
          className={chip(!value.from && !value.to)}
          onClick={() => onChange(EMPTY_RANGE)}
        >
          All
        </button>
      )}
      <InfoTip k="period" />
      <DateRangeFilter
        value={value}
        onChange={(r) =>
          // A report can't be "all dates": clearing falls back to the default preset.
          onChange(!allowAll && !r.from && !r.to ? presetRange(DEFAULT_RANGE_PRESET) : r)
        }
        showIcon={false}
      />
    </div>
  );
}

/** "1 Oct – 9 Oct 2026 (vs 22 Sep – 30 Sep 2026)" for a loaded usage report. */
export const comparisonLabel = (r: { range: DateRange; previousRange: DateRange }) =>
  `${rangeLabel(r.range)}, compared with ${rangeLabel(r.previousRange)}`;

/** "Download Excel" button that shows a spinner while the workbook is built. */
export function ExcelButton({
  onExport,
  disabled,
  label = "Download Excel",
}: {
  onExport: () => Promise<void>;
  disabled?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 gap-1 text-xs"
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onExport();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Could not build the Excel file");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <FileSpreadsheet className="h-3 w-3" />
      )}
      {label}
    </Button>
  );
}

/** The usage report for the shared superadmin range (optionally one company). */
export function usePlatformUsage(clientId?: string) {
  const [range, setRange] = useSuperadminRange();
  const [report, setReport] = useState<PlatformUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Only the latest request may write: changing the range quickly (or the stored range
  // arriving just after mount) must not let an older, slower response win.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const accessToken = await getAccessToken();
      const res = await getPlatformUsage({
        data: {
          accessToken,
          from: range.from || undefined,
          to: range.to || undefined,
          clientId,
        },
      });
      if (id === requestId.current) setReport(res);
    } catch (e) {
      if (id === requestId.current) {
        toast.error(e instanceof Error ? e.message : "Could not load platform usage");
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [range, clientId]);

  useEffect(() => {
    load();
  }, [load]);

  return { range, setRange, report, loading, reload: load };
}

export const HEALTH_META: Record<
  CompanyHealth,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; hint: string }
> = {
  active: { label: "Active", variant: "default", hint: GLOSSARY.healthActive.text },
  slowing: { label: "Slowing", variant: "outline", hint: GLOSSARY.healthSlowing.text },
  dormant: { label: "Dormant", variant: "destructive", hint: GLOSSARY.healthDormant.text },
  new: { label: "New", variant: "secondary", hint: GLOSSARY.healthNew.text },
  not_live: { label: "Not live", variant: "secondary", hint: GLOSSARY.healthNotLive.text },
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

/** One headline number with an optional trend and a line of context. */
export function Kpi({
  icon,
  label,
  value,
  sub,
  trend,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: ReactNode;
  trend?: ReactNode;
  /** Glossary entry explained by the ⓘ beside the label. */
  hint?: GlossaryKey;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          {icon}
          {label}
          {hint && <InfoTip k={hint} />}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-semibold text-foreground">{value}</span>
          {trend}
        </div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** A label (card title, column heading) with its ⓘ explanation. */
export function Explained({ k, children }: { k: GlossaryKey; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <InfoTip k={k} />
    </span>
  );
}
