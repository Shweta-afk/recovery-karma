import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  FileText,
  IndianRupee,
  Loader2,
  Lock,
  Receipt,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAccessToken } from "@/lib/access-token";
import { getRevenueReport, type RevenueReportResponse } from "@/lib/revenue-report.server";
import { AGEING_BUCKETS, type RevenueReport } from "@/lib/revenue-report";
import { INVOICE_KIND_LABEL, type InvoiceKind } from "@/lib/invoice-math";
import type { CompanyUsage } from "@/lib/platform-usage";
import { boundedRange, rangeLabel } from "@/lib/superadmin-range";
import { downloadXlsx, reportFilename, type XlsxSheet } from "@/lib/xlsx-export";
import {
  ExcelButton,
  Explained,
  fmtInt,
  fmtMoney,
  Kpi,
  SuperadminDateFilter,
  usePlatformUsage,
} from "@/components/superadmin/usage-shared";
import { InfoTip, PageGuide } from "@/components/superadmin/help";

export const Route = createFileRoute("/superadmin/revenue")({
  head: () => ({
    meta: [
      { title: "Revenue · SamvadX Platform" },
      {
        name: "description",
        content:
          "What SamvadX has billed companies, what has been received, what is owed, GST by month, Insights margin and seat upsells.",
      },
    ],
  }),
  component: SuperadminRevenuePage,
});

const kindLabel = (k: string) => INVOICE_KIND_LABEL[k as InvoiceKind] ?? k;
const monthLabel = (m: string) =>
  new Date(`${m}-01T12:00:00Z`).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
/** A company at or above this share of a seat cap is an upsell conversation. */
const SEAT_UPSELL_RATIO = 0.9;

function useRevenue(range: { from: string; to: string }) {
  const [res, setRes] = useState<RevenueReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const accessToken = await getAccessToken();
      const r = await getRevenueReport({
        data: { accessToken, from: range.from || undefined, to: range.to || undefined },
      });
      if (id === requestId.current) setRes(r);
    } catch (e) {
      if (id === requestId.current) {
        toast.error(e instanceof Error ? e.message : "Could not load revenue");
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [range]);
  useEffect(() => {
    load();
  }, [load]);
  return { res, loading };
}

function SuperadminRevenuePage() {
  const { range, setRange, report: usage, loading: usageLoading } = usePlatformUsage();
  const { res, loading } = useRevenue(range);
  const revenue = res?.available ? res.report : null;
  const bounded = boundedRange(range);

  const insights = useMemo(
    () =>
      (usage?.companies ?? [])
        .filter((c) => c.current.lookups > 0)
        .map((c) => ({
          c,
          margin: c.current.insightsCharged - c.current.insightsActualCost,
        }))
        .sort((a, b) => a.margin - b.margin),
    [usage],
  );
  const seatUpsell = useMemo(
    () =>
      (usage?.companies ?? [])
        .filter((c) => c.status === "approved")
        .flatMap((c) =>
          (
            [
              ["Agents", c.agentSeats],
              ["Managers", c.managerSeats],
            ] as const
          )
            .filter(([, s]) => s.max && s.max > 0 && s.used >= s.max * SEAT_UPSELL_RATIO)
            .map(([label, s]) => ({ c, label, used: s.used, max: s.max! })),
        )
        .sort((a, b) => b.used / b.max - a.used / a.max),
    [usage],
  );

  const exportAll = async () => {
    const sheets: XlsxSheet[] = [];
    if (revenue) {
      sheets.push(
        {
          name: "Summary",
          headers: ["Measure", "Invoices", "Amount (₹)"],
          rows: [
            ["Billed (incl. GST)", revenue.billed.count, revenue.billed.total],
            ["  of which taxable value", "", revenue.billed.taxable],
            ["  of which GST", "", revenue.billed.gst],
            ["Received", revenue.received.count, revenue.received.total],
            [
              `Outstanding as of ${revenue.today}`,
              revenue.outstanding.count,
              revenue.outstanding.total,
            ],
            ["  of which overdue", revenue.overdue.count, revenue.overdue.total],
            ...AGEING_BUCKETS.map((b) => [
              `  ${b.label}`,
              revenue.ageing[b.key].count,
              revenue.ageing[b.key].total,
            ]),
          ],
        },
        {
          name: "By company",
          headers: [
            "Company",
            "Billed invoices",
            "Billed (₹)",
            "Received invoices",
            "Received (₹)",
            "Outstanding invoices",
            "Outstanding (₹)",
            "Oldest overdue (days)",
          ],
          rows: revenue.byCompany.map((c) => [
            c.companyName,
            c.billed.count,
            c.billed.total,
            c.received.count,
            c.received.total,
            c.outstanding.count,
            c.outstanding.total,
            c.oldestOverdueDays,
          ]),
        },
        {
          name: "GST by month",
          headers: [
            "Month",
            "Invoices",
            "Cancelled",
            "Taxable value (₹)",
            "CGST (₹)",
            "SGST (₹)",
            "IGST (₹)",
            "Invoice total (₹)",
          ],
          rows: revenue.gstMonthly.map((m) => [
            m.month,
            m.invoices,
            m.cancelled,
            m.taxable,
            m.cgst,
            m.sgst,
            m.igst,
            m.total,
          ]),
        },
        {
          name: "Invoice register",
          headers: [
            "Invoice no.",
            "Invoice date",
            "Due date",
            "Type",
            "Company",
            "Recipient (legal name)",
            "Recipient GSTIN",
            "Place of supply",
            "Taxable value (₹)",
            "CGST (₹)",
            "SGST (₹)",
            "IGST (₹)",
            "Total (₹)",
            "Status",
            "Paid on",
          ],
          rows: revenue.register.map((i) => [
            i.invoiceNumber,
            i.issueDate,
            i.dueDate,
            kindLabel(i.kind),
            i.companyName,
            i.recipientName,
            i.recipientGstin ?? "",
            i.placeOfSupply,
            i.taxable,
            i.cgst,
            i.sgst,
            i.igst,
            i.total,
            i.status,
            i.paidAt ? i.paidAt.slice(0, 10) : "",
          ]),
        },
        {
          name: "Unpaid invoices",
          headers: [
            "Invoice no.",
            "Company",
            "Invoice date",
            "Due date",
            "Days overdue",
            "Total (₹)",
          ],
          rows: revenue.unpaid.map((i) => [
            i.invoiceNumber,
            i.companyName,
            i.issueDate,
            i.dueDate,
            Math.max(0, i.daysOverdue),
            i.total,
          ]),
        },
      );
    }
    sheets.push(
      {
        name: "Insights margin",
        headers: [
          "Company",
          "Lookups",
          "Billed (₹)",
          "ProfileX cost (₹)",
          "Margin (₹)",
          "Margin %",
        ],
        rows: insights.map(({ c, margin }) => [
          c.companyName,
          c.current.lookups,
          +c.current.insightsCharged.toFixed(2),
          +c.current.insightsActualCost.toFixed(2),
          +margin.toFixed(2),
          c.current.insightsCharged ? Math.round((margin / c.current.insightsCharged) * 100) : "",
        ]),
      },
      {
        name: "Seat upsell",
        headers: ["Company", "Seat type", "Used", "Cap", "Usage %"],
        rows: seatUpsell.map((s) => [
          s.c.companyName,
          s.label,
          s.used,
          s.max,
          Math.round((s.used / s.max) * 100),
        ]),
      },
    );
    await downloadXlsx(reportFilename("revenue", bounded), sheets);
  };

  const insightsTotals = insights.reduce(
    (t, { c, margin }) => ({
      billed: t.billed + c.current.insightsCharged,
      cost: t.cost + c.current.insightsActualCost,
      margin: t.margin + margin,
    }),
    { billed: 0, cost: 0, margin: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Revenue</h1>
            <Badge variant="secondary">Superadmin</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            What SamvadX billed companies, what came in and what is still owed —{" "}
            {rangeLabel(bounded)}. Outstanding and overdue are as of today, whatever the dates.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SuperadminDateFilter value={range} onChange={setRange} />
          <ExcelButton disabled={!res || !usage} onExport={exportAll} />
        </div>
      </div>

      <PageGuide page="revenue" />

      {!res ? (
        <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading revenue…
        </div>
      ) : !res.available ? (
        <Card className="border-amber-400/40">
          <CardContent className="flex items-start gap-2 p-4 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <div>
              <div className="font-medium text-foreground">
                Invoice figures aren't available yet
              </div>
              {res.reason} Billed, received, outstanding and GST figures appear here once it is.
              Insights margin and seat upsells below don't depend on it.
            </div>
          </CardContent>
        </Card>
      ) : (
        revenue && <InvoiceSections revenue={revenue} loading={loading} />
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-primary" />
              Insights margin by company
              <InfoTip k="insightsMargin" />
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              What each company's wallet was charged vs what ProfileX bills us. A negative margin
              means that company's rate card is below our cost. Lowest margin first.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            {!usage ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : insights.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No Insights lookups in this period.
              </p>
            ) : (
              <div className={`overflow-x-auto ${usageLoading ? "opacity-60" : ""}`}>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Company</th>
                      <th className="py-2 pr-4 font-medium text-right">Lookups</th>
                      <th className="py-2 pr-4 font-medium text-right">Billed</th>
                      <th className="py-2 pr-4 font-medium text-right">
                        <Explained k="profilexCost">ProfileX cost</Explained>
                      </th>
                      <th className="py-2 pr-4 font-medium text-right">Margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insights.map(({ c, margin }) => (
                      <InsightsRow key={c.clientId} c={c} margin={margin} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border font-medium text-foreground">
                      <td className="py-2 pr-4">Total</td>
                      <td className="py-2 pr-4 text-right">
                        {fmtInt(insights.reduce((n, { c }) => n + c.current.lookups, 0))}
                      </td>
                      <td className="py-2 pr-4 text-right">{fmtMoney(insightsTotals.billed)}</td>
                      <td className="py-2 pr-4 text-right">{fmtMoney(insightsTotals.cost)}</td>
                      <td
                        className={`py-2 pr-4 text-right ${insightsTotals.margin < 0 ? "text-destructive" : "text-emerald-600"}`}
                      >
                        {fmtMoney(insightsTotals.margin)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Lock className="h-4 w-4 text-primary" />
              Seat upsell
              <InfoTip k="seatUpsell" />
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Companies using 90% or more of a seat limit — ready for a bigger plan. Current seats,
              not tied to the dates above.
            </p>
          </CardHeader>
          <CardContent className="space-y-2 pt-4">
            {!usage ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : seatUpsell.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No company is near its seat limit.
              </p>
            ) : (
              seatUpsell.map((s) => (
                <Link
                  key={`${s.c.clientId}-${s.label}`}
                  to="/superadmin/companies/$clientId"
                  params={{ clientId: s.c.clientId }}
                  search={{ tab: "billing" }}
                  className="block rounded-lg border border-border px-3 py-2 hover:bg-accent/50"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-foreground">{s.c.companyName}</span>
                    <span
                      className={
                        s.used >= s.max ? "font-semibold text-destructive" : "text-amber-600"
                      }
                    >
                      {s.used} / {s.max} {s.label.toLowerCase()}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${s.used >= s.max ? "bg-destructive" : "bg-amber-500"}`}
                      style={{ width: `${Math.min(100, (s.used / s.max) * 100)}%` }}
                    />
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function InsightsRow({ c, margin }: { c: CompanyUsage; margin: number }) {
  const pct = c.current.insightsCharged ? margin / c.current.insightsCharged : null;
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2 pr-4">
        <Link
          to="/superadmin/companies/$clientId"
          params={{ clientId: c.clientId }}
          className="font-medium text-foreground hover:underline"
        >
          {c.companyName}
        </Link>
        {margin < 0 && (
          <span className="ml-2 inline-flex items-center gap-1">
            <Badge variant="destructive" className="text-[10px]">
              Losing money
            </Badge>
            <InfoTip k="losingMoney" />
          </span>
        )}
      </td>
      <td className="py-2 pr-4 text-right">{fmtInt(c.current.lookups)}</td>
      <td className="py-2 pr-4 text-right">{fmtMoney(c.current.insightsCharged)}</td>
      <td className="py-2 pr-4 text-right">{fmtMoney(c.current.insightsActualCost)}</td>
      <td
        className={`py-2 pr-4 text-right font-medium ${margin < 0 ? "text-destructive" : "text-emerald-600"}`}
      >
        {fmtMoney(margin)}
        {pct !== null && (
          <span className="ml-1 text-[10px] text-muted-foreground">({Math.round(pct * 100)}%)</span>
        )}
      </td>
    </tr>
  );
}

function InvoiceSections({ revenue, loading }: { revenue: RevenueReport; loading: boolean }) {
  const iconCls = "h-3.5 w-3.5";
  const maxAgeing = Math.max(1, ...AGEING_BUCKETS.map((b) => revenue.ageing[b.key].total));
  return (
    <div className={`space-y-6 ${loading ? "opacity-60" : ""}`}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi
          icon={<Receipt className={iconCls} />}
          label="Billed"
          hint="billed"
          value={fmtMoney(revenue.billed.total)}
          sub={`${revenue.billed.count} invoice(s) · GST ${fmtMoney(revenue.billed.gst)}`}
        />
        <Kpi
          icon={<IndianRupee className={iconCls} />}
          label="Received"
          hint="received"
          value={fmtMoney(revenue.received.total)}
          sub={`${revenue.received.count} invoice(s) marked paid in this period`}
        />
        <Kpi
          icon={<TrendingUp className={iconCls} />}
          label="Outstanding now"
          hint="outstanding"
          value={fmtMoney(revenue.outstanding.total)}
          sub={`${revenue.outstanding.count} unpaid invoice(s)`}
        />
        <Kpi
          icon={<CalendarClock className={iconCls} />}
          label="Overdue now"
          hint="overdue"
          value={fmtMoney(revenue.overdue.total)}
          sub={`${revenue.overdue.count} past their due date`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <CalendarClock className="h-4 w-4 text-primary" />
              How long it's been owed
              <InfoTip k="ageing" />
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Unpaid invoices by days past their due date, as of {revenue.today}.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            {AGEING_BUCKETS.map((b) => {
              const m = revenue.ageing[b.key];
              return (
                <div key={b.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{b.label}</span>
                    <span className="font-medium text-foreground">
                      {fmtMoney(m.total)}
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                        ({m.count})
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${b.key === "notDue" ? "bg-primary" : b.key === "d1_30" ? "bg-amber-500" : "bg-destructive"}`}
                      style={{ width: `${(m.total / maxAgeing) * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {revenue.byKind.length > 0 && (
              <div className="border-t border-border pt-3 text-[11px] text-muted-foreground">
                Billed this period:{" "}
                {revenue.byKind
                  .map((k) => `${kindLabel(k.kind)} ${fmtMoney(k.billed.total)}`)
                  .join(" · ")}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Building2 className="h-4 w-4 text-primary" />
              By company
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {revenue.byCompany.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No invoices billed, paid or outstanding in this period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Company</th>
                      <th className="py-2 pr-4 font-medium text-right">Billed</th>
                      <th className="py-2 pr-4 font-medium text-right">Received</th>
                      <th className="py-2 pr-4 font-medium text-right">
                        <Explained k="outstanding">Outstanding</Explained>
                      </th>
                      <th className="py-2 pr-4 font-medium text-right">
                        <Explained k="oldestOverdue">Oldest overdue</Explained>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenue.byCompany.map((c) => (
                      <tr key={c.clientId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4">
                          <Link
                            to="/superadmin/companies/$clientId"
                            params={{ clientId: c.clientId }}
                            search={{ tab: "billing" }}
                            className="font-medium text-foreground hover:underline"
                          >
                            {c.companyName}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-right">{fmtMoney(c.billed.total)}</td>
                        <td className="py-2 pr-4 text-right">{fmtMoney(c.received.total)}</td>
                        <td className="py-2 pr-4 text-right font-medium text-foreground">
                          {fmtMoney(c.outstanding.total)}
                        </td>
                        <td
                          className={`py-2 pr-4 text-right ${c.oldestOverdueDays > 30 ? "text-destructive" : c.oldestOverdueDays > 0 ? "text-amber-600" : "text-muted-foreground"}`}
                        >
                          {c.oldestOverdueDays > 0 ? `${c.oldestOverdueDays} days` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-primary" />
            GST summary by month
            <InfoTip k="gstSummary" />
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Invoices issued in each month (by invoice date), cancelled invoices excluded from the
            amounts. The Excel download adds the full invoice register with recipient GSTINs for
            filing.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {revenue.gstMonthly.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No invoices issued in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Month</th>
                    <th className="py-2 pr-4 font-medium text-right">Invoices</th>
                    <th className="py-2 pr-4 font-medium text-right">Taxable value</th>
                    <th className="py-2 pr-4 font-medium text-right">CGST</th>
                    <th className="py-2 pr-4 font-medium text-right">SGST</th>
                    <th className="py-2 pr-4 font-medium text-right">IGST</th>
                    <th className="py-2 pr-4 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {revenue.gstMonthly.map((m) => (
                    <tr key={m.month} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4 font-medium text-foreground">
                        {monthLabel(m.month)}
                        {m.cancelled > 0 && (
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            ({m.cancelled} cancelled)
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">{m.invoices}</td>
                      <td className="py-2 pr-4 text-right">{fmtMoney(m.taxable)}</td>
                      <td className="py-2 pr-4 text-right">{fmtMoney(m.cgst)}</td>
                      <td className="py-2 pr-4 text-right">{fmtMoney(m.sgst)}</td>
                      <td className="py-2 pr-4 text-right">{fmtMoney(m.igst)}</td>
                      <td className="py-2 pr-4 text-right font-medium text-foreground">
                        {fmtMoney(m.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
