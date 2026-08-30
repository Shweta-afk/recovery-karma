import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { ArrowDownRight, ArrowUpRight, FileDown, Minus, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatINR } from "@/lib/mock-debtors";
import { downloadCsv } from "@/lib/csv-export";
import { DataTable } from "@/components/reports/data-table";
import {
  TREND_METRICS,
  compareMonths,
  dailySeries,
  deltaPct,
  type MetricDef,
  type TrendComparison,
  type TrendMetricKey,
} from "@/lib/monthly-trend";
import type { DispositionRecord } from "@/lib/disposition-store";
import type { PaymentRecord } from "@/lib/payments-store";

// ─── formatting ─────────────────────────────────────────────────────────────────

function formatValue(value: number, currency: boolean): string {
  return currency ? formatINR(value) : value.toLocaleString("en-IN");
}

/** Small deltas deserve a decimal, large ones don't — "+2.4%" is information, "+247.0%" is noise. */
function formatDelta(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${Math.abs(pct) < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * The change chip.
 *
 * `null` means there was no baseline to divide by (last month was zero). That is shown as
 * "new" rather than as a percentage, because 0 → ₹57,500 has no percentage change and
 * rendering it as "+0%" would report real progress as a flat month.
 */
function DeltaChip({ pct, className }: { pct: number | null; className?: string }) {
  if (pct === null) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium",
          "bg-success/10 text-success",
          className,
        )}
      >
        new
      </span>
    );
  }
  const flat = Math.abs(pct) < 0.05;
  const Icon = flat ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        flat
          ? "bg-muted text-muted-foreground"
          : pct > 0
            ? "bg-success/10 text-success"
            : "bg-destructive/10 text-destructive",
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {flat ? "0%" : formatDelta(pct)}
    </span>
  );
}

// ─── KPI tiles ──────────────────────────────────────────────────────────────────

function TrendStat({
  def,
  comparison,
  active,
  onSelect,
}: {
  def: MetricDef;
  comparison: TrendComparison;
  active: boolean;
  onSelect: () => void;
}) {
  const { window: w } = comparison;
  const current = comparison.current[def.key];
  const previous = comparison.previousSamePeriod[def.key];
  const full = comparison.previousFull[def.key];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "rounded-lg border bg-card px-3 py-3 text-left transition-colors",
        active ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/40",
      )}
    >
      <div className="text-xs text-muted-foreground">{def.label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold leading-tight text-foreground">
          {formatValue(current, def.currency)}
        </span>
        <DeltaChip pct={deltaPct(current, previous)} />
      </div>
      <div className="mt-1 text-[11px] leading-tight text-muted-foreground">
        vs {formatValue(previous, def.currency)} by {w.comparableDay} {w.previousLabel.slice(0, 3)}
      </div>
      <div className="text-[11px] leading-tight text-muted-foreground/70">
        {w.previousLabel} full: {formatValue(full, def.currency)}
      </div>
    </button>
  );
}

// ─── the day-of-month chart ─────────────────────────────────────────────────────

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 11,
  },
  labelStyle: { color: "var(--popover-foreground)" },
};

const AXIS_TICK = { fontSize: 10, fill: "var(--muted-foreground)" };

type ChartMode = "cumulative" | "daily";

function TrendChart({
  disps,
  payments,
  def,
  mode,
  posByDebtor,
  compareTo,
}: {
  disps: DispositionRecord[];
  payments: PaymentRecord[];
  def: MetricDef;
  mode: ChartMode;
  posByDebtor?: Map<string, number>;
  /** Kept in step with the panel's picker, or the chart would plot a different comparison
   * month from the tiles directly above it. */
  compareTo?: string;
}) {
  const series = useMemo(
    () => dailySeries(disps, payments, def.key, new Date(), posByDebtor, compareTo),
    [disps, payments, def.key, posByDebtor, compareTo],
  );
  // Same comparison month as the series above, so the axis labels match the data.
  const { window: w } = useMemo(
    () => compareMonths(disps, payments, new Date(), posByDebtor, compareTo),
    [disps, payments, posByDebtor, compareTo],
  );

  const currentKey = mode === "cumulative" ? "currentCumulative" : "current";
  const previousKey = mode === "cumulative" ? "previousCumulative" : "previous";

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={series} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          interval={2}
          label={{
            value: "day of month",
            position: "insideBottom",
            offset: -2,
            style: { fontSize: 10, fill: "var(--muted-foreground)" },
          }}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(v: number) => (def.currency ? formatINR(v) : v.toLocaleString("en-IN"))}
        />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(value) =>
            typeof value === "number" ? formatValue(value, def.currency) : "—"
          }
          labelFormatter={(label: string) => `Day ${label}`}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line
          type="monotone"
          dataKey={previousKey}
          name={w.previousLabel}
          stroke="var(--muted-foreground)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
          // Last month is a completed month with no gaps; joining nulls would be a lie only
          // for the in-progress line below.
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey={currentKey}
          name={`${w.currentLabel} (to date)`}
          stroke="var(--primary)"
          strokeWidth={2}
          dot={false}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── breakdown tables (by team, by agent) ───────────────────────────────────────

export interface TrendGroup {
  id: string;
  name: string;
  /** Secondary line under the name — team for an agent, headcount for a team. */
  sub?: string;
  disps: DispositionRecord[];
  payments: PaymentRecord[];
}

export interface TrendBreakdown {
  title: string;
  description: string;
  icon: LucideIcon;
  groups: TrendGroup[];
  /** Filename stem for the export button. */
  exportName: string;
}

function BreakdownTable({ breakdown, def }: { breakdown: TrendBreakdown; def: MetricDef }) {
  const { window: w, rows } = useMemo(() => {
    const computed = breakdown.groups.map((g) => {
      const c = compareMonths(g.disps, g.payments);
      const current = c.current[def.key];
      const previous = c.previousSamePeriod[def.key];
      return {
        id: g.id,
        name: g.name,
        sub: g.sub,
        current,
        previous,
        full: c.previousFull[def.key],
        pct: deltaPct(current, previous),
        window: c.window,
      };
    });
    computed.sort((a, b) => b.current - a.current);
    return {
      rows: computed,
      // Every group shares the same window; take it from the first, or derive an empty one.
      window: computed[0]?.window ?? compareMonths([], []).window,
    };
  }, [breakdown.groups, def.key]);

  const totals = rows.reduce(
    (acc, r) => ({ current: acc.current + r.current, previous: acc.previous + r.previous }),
    { current: 0, previous: 0 },
  );

  const Icon = breakdown.icon;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 text-primary/70" />
          <div>
            <CardTitle className="text-sm">{breakdown.title}</CardTitle>
            <CardDescription className="text-xs">{breakdown.description}</CardDescription>
          </div>
        </div>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() =>
              downloadCsv(
                `${breakdown.exportName}-${def.key}-trend.csv`,
                [
                  breakdown.title,
                  `${def.label} — ${w.currentLabel} (1-${w.asOfDay})`,
                  `${def.label} — ${w.previousLabel} (1-${w.comparableDay})`,
                  "Change %",
                  `${def.label} — ${w.previousLabel} full month`,
                ],
                rows.map((r) => [
                  r.name,
                  r.current,
                  r.previous,
                  r.pct === null ? "new" : r.pct.toFixed(1),
                  r.full,
                ]),
              )
            }
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <FileDown className="h-3.5 w-3.5" />
            Export
          </button>
        )}
      </CardHeader>
      <CardContent>
        <DataTable
          rows={rows}
          keyOf={(r) => r.id}
          empty="Nothing to compare yet."
          maxHeight="max-h-[420px]"
          columns={[
            {
              key: "name",
              header: breakdown.title,
              render: (r) => (
                <div>
                  <div className="font-medium text-foreground">{r.name}</div>
                  {r.sub && <div className="text-[10px] text-muted-foreground">{r.sub}</div>}
                </div>
              ),
            },
            {
              key: "current",
              header: `${w.currentLabel} (1-${w.asOfDay})`,
              numeric: true,
              render: (r) => formatValue(r.current, def.currency),
            },
            {
              key: "previous",
              header: `${w.previousLabel} (1-${w.comparableDay})`,
              numeric: true,
              render: (r) => (
                <span className="text-muted-foreground">
                  {formatValue(r.previous, def.currency)}
                </span>
              ),
            },
            {
              key: "delta",
              header: "Change",
              numeric: true,
              width: "w-24",
              render: (r) => <DeltaChip pct={r.pct} />,
            },
            {
              key: "full",
              header: `${w.previousLabel} full`,
              numeric: true,
              render: (r) => (
                <span className="text-muted-foreground/70">
                  {formatValue(r.full, def.currency)}
                </span>
              ),
            },
          ]}
          footer={[
            "Total",
            formatValue(totals.current, def.currency),
            formatValue(totals.previous, def.currency),
            <DeltaChip key="d" pct={deltaPct(totals.current, totals.previous)} />,
            formatValue(
              rows.reduce((s, r) => s + r.full, 0),
              def.currency,
            ),
          ]}
        />
      </CardContent>
    </Card>
  );
}

// ─── compact box (agent dashboard) ──────────────────────────────────────────────

/**
 * The month-over-month view shrunk to a dashboard tile, sized to sit beside "My Activity
 * Today" rather than to fill a report page.
 *
 * Same numbers and the same like-for-like window as MonthlyTrendPanel — it shares
 * compareMonths/dailySeries rather than recomputing anything its own way, so the tile and the
 * full report can never disagree. What it drops is the breadth: three rows instead of six
 * tiles, a running-total line with no axis furniture, and no breakdown tables.
 */
export function MonthlyTrendCompact({
  disps,
  payments,
  className,
  /** Rendered under the chart — e.g. a link through to the full report. */
  footer,
}: {
  disps: DispositionRecord[];
  payments: PaymentRecord[];
  className?: string;
  footer?: React.ReactNode;
}) {
  const [metric, setMetric] = useState<TrendMetricKey>("collected");

  // Compact tile: always this month vs last, with no POS map. The full panel is where the
  // comparison month and the POS metrics are selectable.
  const comparison = useMemo(() => compareMonths(disps, payments), [disps, payments]);
  const series = useMemo(() => dailySeries(disps, payments, metric), [disps, payments, metric]);
  const def = TREND_METRICS.find((m) => m.key === metric)!;
  const { window: w } = comparison;

  // Three rows, not all seven: this is a glance tile. Collected is the number the floor is
  // measured on, PTP value is what is coming, calls is the effort behind both.
  const rows = TREND_METRICS.filter(
    (m) => m.key === "collected" || m.key === "ptpAmount" || m.key === "calls",
  );

  return (
    <div className={cn("rounded-xl border border-border bg-card p-3", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          This Month vs Last
        </span>
        <span className="text-[10px] text-muted-foreground">
          1–{w.asOfDay} {w.currentLabel} · 1–{w.comparableDay} {w.previousLabel}
        </span>
      </div>

      <div className="mb-3 space-y-1 border-b border-border pb-2">
        {rows.map((m) => {
          const current = comparison.current[m.key];
          const previous = comparison.previousSamePeriod[m.key];
          const selected = m.key === metric;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => setMetric(m.key)}
              aria-pressed={selected}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left transition-colors",
                selected ? "bg-muted/60" : "hover:bg-muted/30",
              )}
            >
              <span className="text-[11px] text-muted-foreground">{m.label}</span>
              <span className="flex items-center gap-1.5">
                <span className="text-xs font-semibold tabular-nums text-foreground">
                  {formatValue(current, m.currency)}
                </span>
                <DeltaChip pct={deltaPct(current, previous)} />
                <span className="w-20 text-right text-[10px] tabular-nums text-muted-foreground">
                  vs {formatValue(previous, m.currency)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <ResponsiveContainer width="100%" height={116}>
        <LineChart data={series} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval={6} />
          <Tooltip
            {...TOOLTIP_STYLE}
            formatter={(value) =>
              typeof value === "number" ? formatValue(value, def.currency) : "—"
            }
            labelFormatter={(label: string) => `Day ${label}`}
          />
          <Line
            type="monotone"
            dataKey="previousCumulative"
            name={w.previousLabel}
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="currentCumulative"
            name={w.currentLabel}
            stroke="var(--primary)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 rounded bg-primary" />
            {w.currentLabel}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 rounded bg-muted-foreground" />
            {w.previousLabel}
          </span>
        </span>
        <span>
          {w.previousLabel} finished at {formatValue(comparison.previousFull[metric], def.currency)}
        </span>
      </div>
      {footer && <div className="mt-1.5">{footer}</div>}
    </div>
  );
}

// ─── the panel ──────────────────────────────────────────────────────────────────

/**
 * The whole month-over-month view: KPI tiles, the day-of-month chart, and any number of
 * breakdown tables (by team, by agent, by whatever the caller groups).
 *
 * One metric selection drives all three — clicking the "Collected" tile re-draws the chart and
 * re-sorts every breakdown table on collections. Splitting the selector per section meant
 * reading three different metrics off one screen and mistaking them for the same one.
 */
/** Latest month a comparison can point at: the one before this one. Comparing a month with
 * itself, or with the future, has no meaning — monthWindow rejects both, and the input should
 * not offer them in the first place. */
function monthInputMax(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // already 0-based, so this IS last month
  const year = m === 0 ? y - 1 : y;
  const month = m === 0 ? 12 : m;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function MonthlyTrendPanel({
  disps,
  payments,
  breakdowns = [],
  /** Shown under the header — e.g. that bank-reported collections credit no agent. */
  note,
  posByDebtor,
}: {
  disps: DispositionRecord[];
  payments: PaymentRecord[];
  breakdowns?: TrendBreakdown[];
  note?: string;
  /** debtorId -> principal, for the POS Worked / POS Promised metrics. Omit and they read 0. */
  posByDebtor?: Map<string, number>;
}) {
  const [metric, setMetric] = useState<TrendMetricKey>("collected");
  const [mode, setMode] = useState<ChartMode>("cumulative");
  // Which month to compare against. Empty = the month immediately before, which is what this
  // always did before the picker existed.
  const [compareTo, setCompareTo] = useState("");

  const comparison = useMemo(
    () => compareMonths(disps, payments, new Date(), posByDebtor, compareTo || undefined),
    [disps, payments, posByDebtor, compareTo],
  );
  const def = TREND_METRICS.find((m) => m.key === metric)!;
  const { window: w } = comparison;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {w.currentLabel} vs {w.previousLabel}
        </h3>
        <p className="text-xs text-muted-foreground">
          Like for like: 1–{w.asOfDay} {w.currentLabel} against 1–{w.comparableDay}{" "}
          {w.previousLabel}. Last month's full total is shown on each tile so the finish line stays
          visible.
        </p>
        {note && <p className="mt-1 text-[11px] text-muted-foreground/80">{note}</p>}

        {/* Compare against any earlier month, not only the one immediately before. Useful for
            "how does this August compare with last August" rather than only with July. */}
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor="compare-month" className="text-[11px] text-muted-foreground">
            Compare with
          </label>
          <input
            id="compare-month"
            type="month"
            value={compareTo}
            max={monthInputMax()}
            onChange={(e) => setCompareTo(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {compareTo && (
            <button
              type="button"
              onClick={() => setCompareTo("")}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            >
              reset to last month
            </button>
          )}
        </div>
      </div>

      {/* 7 metrics since Accounts was added — a 6-wide row left one orphaned on its own line. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
        {TREND_METRICS.map((m) => (
          <TrendStat
            key={m.key}
            def={m}
            comparison={comparison}
            active={m.key === metric}
            onSelect={() => setMetric(m.key)}
          />
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="flex items-start gap-2">
            <TrendingUp className="mt-0.5 h-4 w-4 text-primary/70" />
            <div>
              <CardTitle className="text-sm">{def.label} — day by day</CardTitle>
              <CardDescription className="text-xs">
                Both months aligned on day-of-month, so today sits directly above the same date last
                month.
              </CardDescription>
            </div>
          </div>
          <div className="flex shrink-0 rounded-md border border-border p-0.5">
            {(["cumulative", "daily"] as ChartMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded px-2 py-1 text-[11px] capitalize transition-colors",
                  mode === m
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "cumulative" ? "Running total" : "Per day"}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <TrendChart
            disps={disps}
            payments={payments}
            def={def}
            mode={mode}
            posByDebtor={posByDebtor}
            compareTo={compareTo || undefined}
          />
        </CardContent>
      </Card>

      {breakdowns.map((b) => (
        <BreakdownTable key={b.title} breakdown={b} def={def} />
      ))}
    </div>
  );
}
