import { createFileRoute } from "@tanstack/react-router";
import { PageGuide } from "@/components/superadmin/help";
import { useEffect, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAccessToken } from "@/lib/access-token";
import {
  getInsightsActivity,
  getInsightsReport,
  type InsightsActivityRow,
  type InsightsBucket,
  type InsightsReport,
} from "@/lib/superadmin-actions.server";
import { describeRange, isRangeActive } from "@/lib/date-filter";
import { openRangeInstants, rangeLabel } from "@/lib/superadmin-range";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import {
  ExcelButton,
  SuperadminDateFilter,
  useSuperadminRange,
} from "@/components/superadmin/usage-shared";
import { PROFILEX_SERVICES } from "@/lib/profilex/catalogue";
import { ExportRequestsCard } from "@/components/profilex/export-requests-card";

export const Route = createFileRoute("/superadmin/insights")({
  head: () => ({ meta: [{ title: "Insights Activity · SamvadX Platform" }] }),
  component: SuperadminInsightsPage,
});

const serviceLabel = (id: string) => PROFILEX_SERVICES.find((s) => s.id === id)?.label ?? id;

function stateBadge(row: InsightsActivityRow) {
  if (row.state === "failed") return { label: "Failed", variant: "destructive" as const };
  if (row.state === "pending") return { label: "Pending", variant: "outline" as const };
  if (row.providerStatus === "1") return { label: "Found", variant: "default" as const };
  return { label: "Not found", variant: "secondary" as const };
}

const money = (n: number) => `₹${n.toFixed(2)}`;
const signed = (n: number) => `${n > 0 ? "+" : ""}${money(n)}`;
const deltaClass = (d: number) =>
  d === 0 ? "text-muted-foreground" : d > 0 ? "text-destructive" : "text-emerald-600";

const BUCKET_HEADERS = [
  "Lookups",
  "Found",
  "Paid, no data",
  "Failed (free)",
  "Manual",
  "Company charged (₹)",
  "Actual ProfileX cost (₹)",
  "Delta (₹)",
];
const bucketCells = (b: InsightsBucket): number[] => [
  b.lookups,
  b.found,
  b.paidNoData,
  b.failed,
  b.manual,
  Number(b.companyCost.toFixed(2)),
  Number(b.realCost.toFixed(2)),
  Number((b.realCost - b.companyCost).toFixed(2)),
];

function SuperadminInsightsPage() {
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useSuperadminRange();
  const [report, setReport] = useState<InsightsReport | null>(null);
  const [rows, setRows] = useState<InsightsActivityRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const accessToken = await getAccessToken();
        const { since, until } = openRangeInstants(range);
        const [rep, act] = await Promise.all([
          getInsightsReport({ data: { accessToken, since, until } }),
          getInsightsActivity({ data: { accessToken, since, until, limit: 1000 } }),
        ]);
        if (cancelled) return;
        setReport(rep);
        setRows(act.rows);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load Insights activity");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const totals = report?.totals;
  const totalDelta = totals ? totals.realCost - totals.companyCost : 0;
  const label = !isRangeActive(range)
    ? "All time"
    : range.from && range.to
      ? rangeLabel(range.from > range.to ? { from: range.to, to: range.from } : range)
      : describeRange(range);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Insights Activity
          </h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Every ProfileX lookup across every company (debtor lookups and admins' manual ones), with
          two costs side by side: what that company's own wallet was charged (its rate card) versus
          what ProfileX actually charged (their real published price). Totals cover the whole
          period; the list below shows up to the 1,000 most recent.
        </p>
        <SuperadminDateFilter value={range} onChange={setRange} allowAll className="mt-3" />
      </div>

      <PageGuide page="insights" />

      <ExportRequestsCard />

      {!loading && report && totals && (
        <>
          {report.truncated && (
            <p className="text-xs text-destructive">
              This window has more lookups than the report can total, so figures are a lower bound.
              Pick a shorter period.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                k: "Lookups",
                v: String(totals.lookups),
                sub: `${totals.manual} typed in by admins`,
              },
              {
                k: "Found",
                v: String(totals.found),
                sub: totals.lookups
                  ? `${Math.round((totals.found / totals.lookups) * 100)}% hit rate`
                  : "—",
              },
              {
                k: "Paid, no data",
                v: String(totals.paidNoData),
                sub: `${totals.failed} failed (free)`,
              },
              {
                k: "Actual ProfileX cost",
                v: money(totals.realCost),
                sub: `companies charged ${money(totals.companyCost)} · margin ${signed(totals.companyCost - totals.realCost)}`,
              },
            ].map((t) => (
              <Card key={t.k}>
                <CardContent className="py-4">
                  <div className="text-xs text-muted-foreground">{t.k}</div>
                  <div className="text-2xl font-semibold text-foreground">{t.v}</div>
                  <div className="text-[11px] text-muted-foreground">{t.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0 border-b border-border pb-3">
              <div>
                <CardTitle className="text-sm font-semibold">
                  Company-charged vs. actual ProfileX cost
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {label}. A non-zero delta means that company's rate card is priced differently
                  from what ProfileX really bills for the same lookups.
                </p>
              </div>
              <ExcelButton
                onExport={() =>
                  downloadXlsx(reportFilename("insights-by-company", range), [
                    {
                      name: "By company",
                      headers: ["Company", ...BUCKET_HEADERS],
                      rows: report.byCompany.map((c) => [c.companyName, ...bucketCells(c)]),
                    },
                  ])
                }
              />
            </CardHeader>
            <CardContent className="pt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Company</th>
                      <th className="py-2 pr-4 font-medium text-right">Lookups</th>
                      <th className="py-2 pr-4 font-medium text-right">Found</th>
                      <th className="py-2 pr-4 font-medium text-right">Paid, no data</th>
                      <th className="py-2 pr-4 font-medium text-right">Failed</th>
                      <th className="py-2 pr-4 font-medium text-right">Manual</th>
                      <th className="py-2 pr-4 font-medium text-right">Company charged</th>
                      <th className="py-2 pr-4 font-medium text-right">Actual cost</th>
                      <th className="py-2 pr-4 font-medium text-right">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byCompany.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-6 text-center text-muted-foreground">
                          No lookups in this period.
                        </td>
                      </tr>
                    )}
                    {report.byCompany.map((c) => {
                      const delta = c.realCost - c.companyCost;
                      return (
                        <tr key={c.clientId} className="border-b border-border last:border-0">
                          <td className="py-2 pr-4 text-foreground font-medium">{c.companyName}</td>
                          <td className="py-2 pr-4 text-right">{c.lookups}</td>
                          <td className="py-2 pr-4 text-right">{c.found}</td>
                          <td className="py-2 pr-4 text-right">{c.paidNoData}</td>
                          <td className="py-2 pr-4 text-right">{c.failed}</td>
                          <td className="py-2 pr-4 text-right">{c.manual}</td>
                          <td className="py-2 pr-4 text-right">{money(c.companyCost)}</td>
                          <td className="py-2 pr-4 text-right">{money(c.realCost)}</td>
                          <td className={`py-2 pr-4 text-right font-medium ${deltaClass(delta)}`}>
                            {signed(delta)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="text-left font-semibold text-foreground">
                      <td className="py-2 pr-4">Total</td>
                      <td className="py-2 pr-4 text-right">{totals.lookups}</td>
                      <td className="py-2 pr-4 text-right">{totals.found}</td>
                      <td className="py-2 pr-4 text-right">{totals.paidNoData}</td>
                      <td className="py-2 pr-4 text-right">{totals.failed}</td>
                      <td className="py-2 pr-4 text-right">{totals.manual}</td>
                      <td className="py-2 pr-4 text-right">{money(totals.companyCost)}</td>
                      <td className="py-2 pr-4 text-right">{money(totals.realCost)}</td>
                      <td className={`py-2 pr-4 text-right ${deltaClass(totalDelta)}`}>
                        {signed(totalDelta)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0 border-b border-border pb-3">
              <div>
                <CardTitle className="text-sm font-semibold">By service</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {label}. Where the money goes, and which lookups return nothing.
                </p>
              </div>
              <ExcelButton
                onExport={() =>
                  downloadXlsx(reportFilename("insights-by-service", range), [
                    {
                      name: "By service",
                      headers: ["Service", ...BUCKET_HEADERS],
                      rows: report.byService.map((r) => [
                        serviceLabel(r.serviceId),
                        ...bucketCells(r),
                      ]),
                    },
                  ])
                }
              />
            </CardHeader>
            <CardContent className="pt-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Service</th>
                      <th className="py-2 pr-4 font-medium text-right">Lookups</th>
                      <th className="py-2 pr-4 font-medium text-right">Found</th>
                      <th className="py-2 pr-4 font-medium text-right">Paid, no data</th>
                      <th className="py-2 pr-4 font-medium text-right">Failed</th>
                      <th className="py-2 pr-4 font-medium text-right">Manual</th>
                      <th className="py-2 pr-4 font-medium text-right">Company charged</th>
                      <th className="py-2 pr-4 font-medium text-right">Actual cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byService.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-6 text-center text-muted-foreground">
                          No lookups in this period.
                        </td>
                      </tr>
                    )}
                    {report.byService.map((r) => (
                      <tr key={r.serviceId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4 text-foreground font-medium">
                          {serviceLabel(r.serviceId)}
                        </td>
                        <td className="py-2 pr-4 text-right">{r.lookups}</td>
                        <td className="py-2 pr-4 text-right">{r.found}</td>
                        <td className="py-2 pr-4 text-right">{r.paidNoData}</td>
                        <td className="py-2 pr-4 text-right">{r.failed}</td>
                        <td className="py-2 pr-4 text-right">{r.manual}</td>
                        <td className="py-2 pr-4 text-right">{money(r.companyCost)}</td>
                        <td className="py-2 pr-4 text-right">{money(r.realCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Recent lookups
            </CardTitle>
            <ExcelButton
              disabled={loading || rows.length === 0}
              onExport={() =>
                // The typed-in mobile/UAN of a manual lookup is left out on purpose: the
                // download is a usage record, not a list of people's numbers.
                downloadXlsx(reportFilename("insights-lookups", range), [
                  {
                    name: "Lookups",
                    headers: [
                      "When",
                      "Company",
                      "Run by",
                      "Service",
                      "Result",
                      "Manual",
                      "Company charged (₹)",
                      "Actual ProfileX cost (₹)",
                      "Delta (₹)",
                    ],
                    rows: rows.map((r) => [
                      new Date(r.createdAt).toLocaleString("en-IN"),
                      r.companyName ?? "",
                      r.managerName ?? "",
                      serviceLabel(r.serviceId),
                      stateBadge(r).label,
                      r.manual ? "Yes" : "No",
                      +r.cost.toFixed(2),
                      +r.realCost.toFixed(2),
                      +(r.realCost - r.cost).toFixed(2),
                    ]),
                  },
                ])
              }
            />
          </div>
          {!loading && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Latest {rows.length} lookups · {label}
            </p>
          )}
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No Insights lookups yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium">Manager</th>
                    <th className="py-2 pr-4 font-medium">Service</th>
                    <th className="py-2 pr-4 font-medium">Result</th>
                    <th className="py-2 pr-4 font-medium text-right">Company charged</th>
                    <th className="py-2 pr-4 font-medium text-right">Actual ProfileX cost</th>
                    <th className="py-2 pr-4 font-medium text-right">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const badge = stateBadge(row);
                    const delta = row.realCost - row.cost;
                    return (
                      <tr key={row.id} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4 text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-foreground">{row.companyName ?? "—"}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {row.managerName ?? "—"}
                        </td>
                        <td className="py-2 pr-4">
                          {serviceLabel(row.serviceId)}
                          {row.manual && (
                            <span className="ml-2 text-[10px] text-muted-foreground">
                              Manual · {row.queryValue}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant={badge.variant} className="text-[10px]">
                            {badge.label}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4 text-right font-medium text-foreground">
                          {row.billable ? `₹${row.cost.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 pr-4 text-right font-medium text-foreground">
                          {row.billable ? `₹${row.realCost.toFixed(2)}` : "—"}
                        </td>
                        <td
                          className={`py-2 pr-4 text-right ${
                            !row.billable || delta === 0
                              ? "text-muted-foreground"
                              : delta > 0
                                ? "text-destructive"
                                : "text-emerald-600"
                          }`}
                        >
                          {row.billable ? `${delta > 0 ? "+" : ""}₹${delta.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
