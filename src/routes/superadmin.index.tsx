import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Building2,
  Clock,
  Gauge,
  Loader2,
  Phone,
  PhoneCall,
  RefreshCw,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fmtInt,
  fmtMoney,
  fmtPct,
  fmtTalk,
  HealthBadge,
  Trend,
  comparisonLabel,
  ExcelButton,
  Kpi,
  SuperadminDateFilter,
  usePlatformUsage,
} from "@/components/superadmin/usage-shared";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import { DailyUsageChart } from "@/components/superadmin/daily-usage-chart";
import {
  contactRate,
  type AttentionItem,
  type CompanyUsage,
  type PlatformUsageReport,
} from "@/lib/platform-usage";

export const Route = createFileRoute("/superadmin/")({
  head: () => ({
    meta: [
      { title: "Overview · SamvadX Platform" },
      {
        name: "description",
        content: "How every company on SamvadX is using calling and Insights.",
      },
    ],
  }),
  component: SuperadminOverviewPage,
});

function SuperadminOverviewPage() {
  const { range, setRange, report, loading, reload } = usePlatformUsage();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
            <Badge variant="secondary">Superadmin</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            How companies are using SamvadX calling and Insights
            {report ? ` — ${comparisonLabel(report)}.` : "."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SuperadminDateFilter value={range} onChange={setRange} />
          <ExcelButton disabled={!report} onExport={() => exportOverview(report!)} />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            disabled={loading}
            onClick={reload}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {!report ? (
        <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading usage…
        </div>
      ) : (
        <div className={`space-y-6 ${loading ? "opacity-60" : ""}`}>
          <KpiGrid report={report} />
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <DailyUsageChart daily={report.daily} />
            </div>
            <div className="lg:col-span-2">
              <AttentionCard items={report.attention} />
            </div>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <TopCompanies
              title="Most calling"
              icon={<PhoneCall className="h-4 w-4 text-primary" />}
              companies={report.companies}
              value={(c) => c.current.calls}
              previous={(c) => c.previous.calls}
              detail={(c) =>
                `${fmtPct(contactRate(c.current))} contact · ${fmtTalk(c.current.talkSeconds)} talk`
              }
              empty="No calls in this period."
            />
            <TopCompanies
              title="Most Insights lookups"
              icon={<Sparkles className="h-4 w-4 text-primary" />}
              companies={report.companies}
              value={(c) => c.current.lookups}
              previous={(c) => c.previous.lookups}
              detail={(c) => `${fmtMoney(c.current.insightsCharged)} billed`}
              empty="No Insights lookups in this period."
            />
          </div>
          {report.unattributedCalls > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {report.unattributedCalls} call(s) in this period belong to a user no longer linked to
              any company and are left out of the per-company numbers.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

async function exportOverview(report: PlatformUsageReport) {
  const { current: cur, previous: prev } = report.totals;
  const kpi = (label: string, c: number | string, p: number | string) => [label, c, p];
  const rate = (b: typeof cur) => (b.calls ? Math.round((b.contacts / b.calls) * 100) : "");
  await downloadXlsx(reportFilename("overview", report.range), [
    {
      name: "Summary",
      headers: [
        "Measure",
        `${report.range.from} to ${report.range.to}`,
        `${report.previousRange.from} to ${report.previousRange.to}`,
      ],
      rows: [
        kpi("Active companies", report.totals.activeCompanies, report.totals.activeCompaniesPrev),
        kpi("Live companies", report.totals.liveCompanies, ""),
        kpi("Active callers", cur.activeCallers, prev.activeCallers),
        kpi("Calls", cur.calls, prev.calls),
        kpi("Contacts", cur.contacts, prev.contacts),
        kpi("Contact rate %", rate(cur), rate(prev)),
        kpi("Talk minutes", Math.round(cur.talkSeconds / 60), Math.round(prev.talkSeconds / 60)),
        kpi("Insights lookups", cur.lookups, prev.lookups),
        kpi("Insights lookups found", cur.lookupsFound, prev.lookupsFound),
        kpi(
          "Insights billed (₹)",
          +cur.insightsCharged.toFixed(2),
          +prev.insightsCharged.toFixed(2),
        ),
        kpi(
          "ProfileX cost (₹)",
          +cur.insightsActualCost.toFixed(2),
          +prev.insightsActualCost.toFixed(2),
        ),
        kpi(
          "Insights margin (₹)",
          +(cur.insightsCharged - cur.insightsActualCost).toFixed(2),
          +(prev.insightsCharged - prev.insightsActualCost).toFixed(2),
        ),
      ],
    },
    {
      name: "Daily usage",
      headers: ["Day (IST)", "Calls", "Insights lookups"],
      rows: report.daily.map((d) => [d.day, d.calls, d.lookups]),
    },
    {
      name: "Needs attention",
      headers: ["Company", "Issue", "Detail"],
      rows: report.attention.map((a) => [a.companyName ?? "", a.kind, a.message]),
    },
  ]);
}

function KpiGrid({ report }: { report: PlatformUsageReport }) {
  const { current: cur, previous: prev } = report.totals;
  const curRate = contactRate(cur);
  const prevRate = contactRate(prev);
  const margin = cur.insightsCharged - cur.insightsActualCost;
  const prevMargin = prev.insightsCharged - prev.insightsActualCost;
  const iconCls = "h-3.5 w-3.5";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Kpi
        icon={<Building2 className={iconCls} />}
        label="Active companies"
        value={`${report.totals.activeCompanies} / ${report.totals.liveCompanies}`}
        sub="used calling or Insights, of all live"
        trend={
          <Trend
            current={report.totals.activeCompanies}
            previous={report.totals.activeCompaniesPrev}
          />
        }
      />
      <Kpi
        icon={<Users className={iconCls} />}
        label="Active callers"
        value={fmtInt(cur.activeCallers)}
        sub="users who placed at least one call"
        trend={<Trend current={cur.activeCallers} previous={prev.activeCallers} />}
      />
      <Kpi
        icon={<Phone className={iconCls} />}
        label="Calls"
        value={fmtInt(cur.calls)}
        sub={`${fmtInt(prev.calls)} the period before`}
        trend={<Trend current={cur.calls} previous={prev.calls} />}
      />
      <Kpi
        icon={<Gauge className={iconCls} />}
        label="Contact rate"
        value={fmtPct(curRate)}
        sub={`${fmtInt(cur.contacts)} calls reached someone · was ${fmtPct(prevRate)}`}
      />
      <Kpi
        icon={<Clock className={iconCls} />}
        label="Talk time"
        value={fmtTalk(cur.talkSeconds)}
        sub={
          cur.calls > 0
            ? `avg ${fmtTalk(cur.talkSeconds / Math.max(1, cur.contacts))} per contact`
            : undefined
        }
        trend={<Trend current={cur.talkSeconds} previous={prev.talkSeconds} />}
      />
      <Kpi
        icon={<Sparkles className={iconCls} />}
        label="Insights lookups"
        value={fmtInt(cur.lookups)}
        sub={`${fmtPct(cur.lookups ? cur.lookupsFound / cur.lookups : null)} found data`}
        trend={<Trend current={cur.lookups} previous={prev.lookups} />}
      />
      <Kpi
        icon={<Wallet className={iconCls} />}
        label="Insights billed"
        value={fmtMoney(cur.insightsCharged)}
        sub="charged to company wallets"
        trend={<Trend current={cur.insightsCharged} previous={prev.insightsCharged} />}
      />
      <Kpi
        icon={<Wallet className={iconCls} />}
        label="Insights margin"
        value={fmtMoney(margin)}
        sub={`after ${fmtMoney(cur.insightsActualCost)} ProfileX cost`}
        trend={<Trend current={margin} previous={prevMargin} />}
      />
    </div>
  );
}

function AttentionCard({ items }: { items: AttentionItem[] }) {
  return (
    <Card className="h-full">
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Needs attention
          {items.length > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {items.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-4">
        {items.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nothing needs you right now.
          </p>
        ) : (
          items.map((item, i) => (
            <AttentionRow key={`${item.kind}-${item.clientId}-${i}`} item={item} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const body = (
    <>
      <div className="text-xs font-medium text-foreground">
        {item.companyName ?? "Insights Excel requests"}
      </div>
      <div className="text-[11px] text-muted-foreground">{item.message}</div>
    </>
  );
  const cls = "block rounded-lg border border-border px-3 py-2 hover:bg-accent/50";
  if (item.kind === "export_requests") {
    return (
      <Link to="/superadmin/insights" className={cls}>
        {body}
      </Link>
    );
  }
  if (item.kind === "pending_approval") {
    return (
      <Link to="/superadmin/companies" className={cls}>
        {body}
      </Link>
    );
  }
  return (
    <Link
      to="/superadmin/companies/$clientId"
      params={{ clientId: item.clientId! }}
      search={
        item.kind === "seat_cap" || item.kind === "wallet_running_out" ? { tab: "billing" } : {}
      }
      className={cls}
    >
      {body}
    </Link>
  );
}

function TopCompanies({
  title,
  icon,
  companies,
  value,
  previous,
  detail,
  empty,
}: {
  title: string;
  icon: ReactNode;
  companies: CompanyUsage[];
  value: (c: CompanyUsage) => number;
  previous: (c: CompanyUsage) => number;
  detail: (c: CompanyUsage) => string;
  empty: string;
}) {
  const top = companies
    .filter((c) => value(c) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, 5);
  const max = top.length ? value(top[0]) : 0;
  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {top.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">{empty}</p>
        ) : (
          top.map((c) => (
            <Link
              key={c.clientId}
              to="/superadmin/companies/$clientId"
              params={{ clientId: c.clientId }}
              className="block space-y-1 rounded-md hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-foreground">{c.companyName}</span>
                  <HealthBadge health={c.health} />
                </span>
                <span className="flex flex-shrink-0 items-center gap-2">
                  <span className="font-semibold text-foreground">{fmtInt(value(c))}</span>
                  <Trend current={value(c)} previous={previous(c)} />
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${max ? (value(c) / max) * 100 : 0}%` }}
                />
              </div>
              <div className="text-[10px] text-muted-foreground">{detail(c)}</div>
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}
