// Insights outcome report: what each lookup found, and what happened on the account after it.
//
// The usage panels answer "who spent what"; this answers "did it help recover". One row per
// lookup, with calls/contacts/PTPs/payments recorded on that account after the lookup ran.
// Every filter is applied here, on one fetch for the period: the option lists come from the
// same rows, so a manager/portfolio that had no lookups never shows up as an empty choice.
// Pure logic lives in src/lib/profilex/outcome.ts.
import { useEffect, useMemo, useState } from "react";
import {
  FileDown,
  Search,
  IndianRupee,
  PhoneCall,
  Handshake,
  BadgeCheck,
  Layers,
  ListFilter,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Stat } from "@/components/reports/stat-card";
import { ReportSection, DataTable } from "@/components/reports/data-table";
import { getAccessToken } from "@/lib/access-token";
import { getInsightsOutcomeReport } from "@/lib/profilex-actions.server";
import { serviceLabel } from "@/lib/profilex-store";
import { downloadCsv } from "@/lib/csv-export";
import {
  INSIGHTS_PERIODS,
  periodLabel,
  periodSince,
  type InsightsPeriod,
} from "@/lib/profilex/period";
import {
  OUTCOME_EXPORT_HEADERS,
  OUTCOME_LABEL,
  TURNOUT_META,
  groupTotals,
  outcomeExportRow,
  totals,
  type OutcomeRow,
  type OutcomeTotals,
  type Turnout,
} from "@/lib/profilex/outcome";

const ALL = "all";
const DETAIL_ROWS_SHOWN = 500;

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

const TURNOUT_CLS: Record<Turnout, string> = {
  recovered: "bg-success/15 text-success border-success/30",
  ptp: "bg-primary/10 text-primary border-primary/30",
  contacted: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30",
  worked_no_contact: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  not_worked: "bg-muted text-muted-foreground border-border",
  no_data: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/10 text-destructive border-destructive/30",
  pending: "bg-muted text-muted-foreground border-border",
};

type GroupBy = "service" | "manager" | "portfolio" | "requester";
const GROUP_BY: { value: GroupBy; label: string; keyOf: (r: OutcomeRow) => string }[] = [
  { value: "service", label: "Service", keyOf: (r) => serviceLabel(r.serviceId) },
  { value: "manager", label: "Manager", keyOf: (r) => r.managerName || "No manager" },
  {
    value: "portfolio",
    label: "Portfolio",
    keyOf: (r) => r.portfolioName || "No portfolio",
  },
  { value: "requester", label: "Run by", keyOf: (r) => r.requestedBy },
];

function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-full sm:w-44 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL} className="text-xs">
            {allLabel}
          </SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The period switch shown above the Insights reports. */
export function InsightsPeriodPicker({
  value,
  onChange,
}: {
  value: InsightsPeriod;
  onChange: (p: InsightsPeriod) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Period</span>
      <div className="inline-flex rounded-md border border-border bg-card p-0.5">
        {INSIGHTS_PERIODS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors",
              value === p.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function distinct(
  rows: OutcomeRow[],
  id: (r: OutcomeRow) => string | null,
  name: (r: OutcomeRow) => string,
) {
  const m = new Map<string, string>();
  for (const r of rows) {
    const k = id(r);
    if (k && !m.has(k)) m.set(k, name(r) || "Unnamed");
  }
  return [...m.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function InsightsOutcomeReport({
  period = "this-month",
  showManagerFilter = true,
}: {
  period?: InsightsPeriod;
  /** Off for a manager — RLS already limits them to their own team. */
  showManagerFilter?: boolean;
}) {
  const [rows, setRows] = useState<OutcomeRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [manager, setManager] = useState(ALL);
  const [portfolio, setPortfolio] = useState(ALL);
  const [service, setService] = useState(ALL);
  const [result, setResult] = useState(ALL);
  const [turnout, setTurnout] = useState(ALL);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("service");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await getInsightsOutcomeReport({
          data: { accessToken: await getAccessToken(), since: periodSince(period) },
        });
        if (cancelled) return;
        setRows(res.rows);
        setTruncated(res.truncated);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  const managerOptions = useMemo(
    () =>
      distinct(
        rows,
        (r) => r.managerId,
        (r) => r.managerName,
      ),
    [rows],
  );
  // Portfolios narrow to the chosen manager, so the second dropdown only offers real pairs.
  const portfolioOptions = useMemo(
    () =>
      distinct(
        rows.filter((r) => manager === ALL || r.managerId === manager),
        (r) => r.portfolioId,
        (r) => [r.portfolioName, r.lenderName].filter(Boolean).join(" · "),
      ),
    [rows, manager],
  );
  const serviceOptions = useMemo(
    () =>
      distinct(
        rows,
        (r) => r.serviceId,
        (r) => serviceLabel(r.serviceId),
      ),
    [rows],
  );

  // A portfolio chosen under one manager may not exist under the next one picked.
  useEffect(() => {
    if (portfolio !== ALL && !portfolioOptions.some((o) => o.value === portfolio)) {
      setPortfolio(ALL);
    }
  }, [portfolio, portfolioOptions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (manager === ALL || r.managerId === manager) &&
        (portfolio === ALL || r.portfolioId === portfolio) &&
        (service === ALL || r.serviceId === service) &&
        (result === ALL || r.result === result) &&
        (turnout === ALL || r.turnout === turnout) &&
        (!q ||
          r.debtorName.toLowerCase().includes(q) ||
          r.loanReference.toLowerCase().includes(q) ||
          r.phonePrimary.includes(q)),
    );
  }, [rows, manager, portfolio, service, result, turnout, query]);

  const t = useMemo(() => totals(filtered), [filtered]);
  const groups = useMemo(
    () => groupTotals(filtered, GROUP_BY.find((g) => g.value === groupBy)!.keyOf),
    [filtered, groupBy],
  );
  const turnoutCounts = useMemo(() => {
    const c = new Map<Turnout, number>();
    for (const r of filtered) c.set(r.turnout, (c.get(r.turnout) ?? 0) + 1);
    return (Object.keys(TURNOUT_META) as Turnout[])
      .map((k) => ({ k, n: c.get(k) ?? 0 }))
      .filter((x) => x.n > 0);
  }, [filtered]);

  if (loading) return <p className="text-xs text-muted-foreground py-6">Loading outcomes…</p>;
  if (error) return <p className="text-xs text-destructive">{error}</p>;

  const filterLabel = [
    manager !== ALL && managerOptions.find((o) => o.value === manager)?.label,
    portfolio !== ALL && portfolioOptions.find((o) => o.value === portfolio)?.label,
  ]
    .filter(Boolean)
    .join(" · ");

  const exportCsv = () => {
    const slug = (filterLabel || "all").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    downloadCsv(
      `insights-outcomes-${period}-${slug}.csv`,
      [...OUTCOME_EXPORT_HEADERS],
      filtered.map((r) => outcomeExportRow(r, serviceLabel)),
    );
  };

  const found = filtered.filter((r) => r.result === "found").length;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card/50 p-3">
        <ListFilter className="h-4 w-4 text-muted-foreground mb-2 hidden sm:block" />
        {showManagerFilter && (
          <FilterSelect
            label="Manager"
            value={manager}
            onChange={setManager}
            options={managerOptions}
            allLabel="All managers"
          />
        )}
        <FilterSelect
          label="Portfolio"
          value={portfolio}
          onChange={setPortfolio}
          options={portfolioOptions}
          allLabel="All portfolios"
        />
        <FilterSelect
          label="Service"
          value={service}
          onChange={setService}
          options={serviceOptions}
          allLabel="All services"
        />
        <FilterSelect
          label="Result"
          value={result}
          onChange={setResult}
          options={[
            { value: "found", label: "Found" },
            { value: "not_found", label: "Not found" },
            { value: "failed", label: "Failed" },
          ]}
          allLabel="Any result"
        />
        <FilterSelect
          label="Turnout"
          value={turnout}
          onChange={setTurnout}
          options={(Object.keys(TURNOUT_META) as Turnout[]).map((k) => ({
            value: k,
            label: TURNOUT_META[k].label,
          }))}
          allLabel="Any turnout"
        />
        <div className="space-y-1 min-w-0 flex-1 sm:flex-none">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Account</div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, loan no., phone"
              className="h-8 pl-7 text-xs w-full sm:w-52"
            />
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Stat
          icon={Search}
          label="Lookups"
          value={String(t.lookups)}
          sub={`${inr(t.spend)} spent`}
        />
        <Stat
          icon={BadgeCheck}
          label="Data found"
          value={String(t.found)}
          sub={`${pct(t.found, t.lookups)} hit rate · ${t.newNumbers} with new numbers`}
        />
        <Stat
          icon={PhoneCall}
          label="Called after"
          value={String(t.worked)}
          sub={`${pct(t.worked, found)} of found lookups`}
        />
        <Stat
          icon={PhoneCall}
          label="Contacted after"
          value={String(t.contacted)}
          sub={`${t.newContacts} first-time contacts · ${t.newNumberConnected} via a found number`}
        />
        <Stat
          icon={Handshake}
          label="PTP after"
          value={String(t.ptp)}
          sub={t.ptpAmount ? `${inr(t.ptpAmount)} promised` : "—"}
        />
        <Stat
          icon={IndianRupee}
          label="Recovered after"
          value={inr(t.recoveredAmount)}
          sub={[
            `${t.recovered} accounts`,
            t.recoveredViaFile ? `${t.recoveredViaFile} via bank paid file` : "",
            t.spend ? `${(t.recoveredAmount / t.spend).toFixed(1)}× spend` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          green={t.recoveredAmount > 0}
        />
      </div>

      {/* Turnout funnel */}
      {turnoutCounts.length > 0 && (
        <ReportSection
          title="Lookup turnout"
          description="Best thing that happened on the account after each lookup"
          icon={Layers}
        >
          <div className="p-4 space-y-2">
            {turnoutCounts.map(({ k, n }) => (
              <div key={k} className="flex items-center gap-3 text-xs">
                <span className="w-36 shrink-0 text-muted-foreground">{TURNOUT_META[k].label}</span>
                <div className="flex-1 h-4 rounded bg-muted/50 overflow-hidden">
                  <div
                    className={cn("h-full rounded border", TURNOUT_CLS[k])}
                    style={{ width: `${Math.max(2, (n / filtered.length) * 100)}%` }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right tabular-nums">
                  {n} <span className="text-muted-foreground">({pct(n, filtered.length)})</span>
                </span>
              </div>
            ))}
          </div>
        </ReportSection>
      )}

      {/* Breakdown */}
      <ReportSection
        title="Breakdown"
        description={`${periodLabel(period)}${filterLabel ? ` · ${filterLabel}` : ""}`}
        icon={Layers}
        action={
          <div className="inline-flex rounded-md border border-border bg-card p-0.5">
            {GROUP_BY.filter((g) => showManagerFilter || g.value !== "manager").map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => setGroupBy(g.value)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs transition-colors",
                  groupBy === g.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
        }
      >
        <DataTable<{ key: string; totals: OutcomeTotals }>
          rows={groups}
          keyOf={(g) => g.key}
          empty="No lookups match these filters."
          columns={[
            {
              key: "k",
              header: GROUP_BY.find((g) => g.value === groupBy)!.label,
              render: (g) => <span className="font-medium text-foreground">{g.key}</span>,
            },
            { key: "l", header: "Lookups", numeric: true, render: (g) => g.totals.lookups },
            {
              key: "f",
              header: "Found",
              numeric: true,
              render: (g) => `${g.totals.found} (${pct(g.totals.found, g.totals.lookups)})`,
            },
            { key: "s", header: "Spend", numeric: true, render: (g) => inr(g.totals.spend) },
            { key: "w", header: "Called", numeric: true, render: (g) => g.totals.worked },
            {
              key: "c",
              header: "Contacted",
              numeric: true,
              render: (g) => `${g.totals.contacted} (${g.totals.newContacts} new)`,
            },
            { key: "p", header: "PTP", numeric: true, render: (g) => g.totals.ptp },
            {
              key: "r",
              header: "Recovered",
              numeric: true,
              render: (g) => (
                <span className={cn(g.totals.recoveredAmount > 0 && "text-success font-semibold")}>
                  {inr(g.totals.recoveredAmount)}
                </span>
              ),
            },
            {
              key: "cpc",
              header: "Cost / contact",
              numeric: true,
              render: (g) => (g.totals.contacted ? inr(g.totals.spend / g.totals.contacted) : "—"),
            },
          ]}
          footer={[
            "Total",
            t.lookups,
            `${t.found} (${pct(t.found, t.lookups)})`,
            inr(t.spend),
            t.worked,
            `${t.contacted} (${t.newContacts} new)`,
            t.ptp,
            inr(t.recoveredAmount),
            t.contacted ? inr(t.spend / t.contacted) : "—",
          ]}
        />
      </ReportSection>

      {/* Per-lookup detail */}
      <ReportSection
        title="Lookup outcomes"
        description={`${filtered.length} lookup${filtered.length === 1 ? "" : "s"}${
          filtered.length > DETAIL_ROWS_SHOWN
            ? ` — showing the latest ${DETAIL_ROWS_SHOWN}; Export has all`
            : ""
        }${truncated ? " · report capped at 5,000 lookups, pick a shorter period" : ""}`}
        icon={Search}
        action={
          filtered.length > 0 ? (
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 h-7 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <FileDown className="h-3.5 w-3.5" />
              Export
            </button>
          ) : undefined
        }
      >
        <DataTable
          rows={filtered.slice(0, DETAIL_ROWS_SHOWN)}
          keyOf={(r) => r.traceId}
          empty="No lookups match these filters."
          maxHeight="max-h-[600px]"
          columns={[
            {
              key: "when",
              header: "Lookup",
              render: (r) => (
                <div className="whitespace-nowrap">
                  <div className="text-foreground">
                    {new Date(r.createdAt).toLocaleString("en-IN", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                  <div className="text-[10px] text-muted-foreground">by {r.requestedBy}</div>
                </div>
              ),
            },
            {
              key: "acct",
              header: "Account",
              render: (r) => (
                <div className="min-w-[140px]">
                  <div className="font-medium text-foreground">{r.debtorName}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    {r.loanReference || "—"}
                  </div>
                </div>
              ),
            },
            {
              key: "pf",
              header: "Portfolio / Manager",
              render: (r) => (
                <div className="min-w-[140px]">
                  <div className="text-foreground">{r.portfolioName || "—"}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {[r.managerName, r.agentName && `agent ${r.agentName}`]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </div>
                </div>
              ),
            },
            {
              key: "svc",
              header: "Service / result",
              render: (r) => (
                <div className="min-w-[160px]">
                  <div className="text-foreground">{serviceLabel(r.serviceId)}</div>
                  <div
                    className={cn(
                      "text-[10px]",
                      r.result === "found"
                        ? "text-success"
                        : r.result === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                  >
                    {r.result === "found"
                      ? r.dataFound || "Found"
                      : r.result === "failed"
                        ? "Failed — not billed"
                        : r.result === "pending"
                          ? "In progress"
                          : "No record found"}
                  </div>
                </div>
              ),
            },
            {
              key: "cost",
              header: "Cost",
              numeric: true,
              render: (r) =>
                r.billable ? inr(r.cost) : <span className="text-muted-foreground">Free</span>,
            },
            {
              key: "nums",
              header: "Found numbers",
              render: (r) =>
                r.newNumbers.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="whitespace-nowrap">
                    <div>{r.newNumbers.length} found</div>
                    <div className="text-[10px] text-muted-foreground">
                      {r.newNumberConnected
                        ? "connected ✓"
                        : r.newNumberCalled
                          ? "called, no contact"
                          : "not called"}
                    </div>
                  </div>
                ),
            },
            {
              key: "before",
              header: "Before",
              render: (r) => (
                <span className="whitespace-nowrap text-muted-foreground">
                  {r.callsBefore} call{r.callsBefore === 1 ? "" : "s"}
                  {r.contactedBefore ? " · contact" : ""}
                </span>
              ),
            },
            {
              key: "after",
              header: "After",
              render: (r) => (
                <div className="whitespace-nowrap">
                  <div>
                    {r.callsAfter} call{r.callsAfter === 1 ? "" : "s"} · {r.contactsAfter} contact
                    {r.contactsAfter === 1 ? "" : "s"}
                  </div>
                  {r.bestOutcome && (
                    <div
                      className="text-[10px] text-muted-foreground max-w-[200px] truncate"
                      title={r.bestNotes}
                    >
                      Best: {OUTCOME_LABEL[r.bestOutcome] ?? r.bestOutcome}
                      {r.bestNotes ? ` — ${r.bestNotes}` : ""}
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: "money",
              header: "PTP / Paid",
              numeric: true,
              render: (r) => (
                <div className="whitespace-nowrap">
                  {r.paidAfter > 0 && (
                    <div className="text-success font-semibold">{inr(r.paidAfter)} paid</div>
                  )}
                  {r.markedPaidByFile && (
                    <div className="text-success font-semibold">Marked paid</div>
                  )}
                  {(r.paidFileAfter > 0 || r.markedPaidByFile) && (
                    <div className="text-[10px] text-muted-foreground">via bank paid file</div>
                  )}
                  {r.ptpAmount != null && (
                    <div className="text-[10px] text-muted-foreground">
                      PTP {inr(r.ptpAmount)}
                      {r.ptpDate ? ` on ${r.ptpDate}` : ""}
                    </div>
                  )}
                  {r.paidAfter === 0 && !r.markedPaidByFile && r.ptpAmount == null && (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              ),
            },
            {
              key: "turnout",
              header: "Turnout",
              render: (r) => (
                <Badge
                  variant="outline"
                  className={cn("text-[10px] whitespace-nowrap", TURNOUT_CLS[r.turnout])}
                >
                  {TURNOUT_META[r.turnout].label}
                </Badge>
              ),
            },
          ]}
        />
      </ReportSection>

      <p className="text-[11px] text-muted-foreground">
        Outcomes are what was recorded on the same account <em>after</em> the lookup — a payment is
        credited because it came after, not proven to be caused by it. An account looked up with
        several services counts its result against each lookup. "Connected via a found number" only
        counts calls placed since calls began recording the number dialled, so older lookups show it
        as not called.
      </p>
    </div>
  );
}
