// "Charges report" button on Reports → Insights (admin and manager). One click builds the
// report: every lookup that cost money, found or not found, what it cost, any correction made
// later and where the refund went, plus the wallet's top-ups and refunds. Admins see the whole
// company; a manager sees the lookups they ran. Data: getInsightsChargesReport.
import { useState } from "react";
import { FileDown, Loader2, Receipt, Search, IndianRupee, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Stat } from "@/components/reports/stat-card";
import { DataTable, ReportSection } from "@/components/reports/data-table";
import { getAccessToken } from "@/lib/access-token";
import { getInsightsChargesReport } from "@/lib/insights-charges.server";
import { periodLabel, periodSince, type InsightsPeriod } from "@/lib/profilex/period";
import {
  REFUNDED_TO_LABEL,
  lookupCellText,
  walletCellText,
  type ChargeLookupRow,
  type ChargesReport,
  type ServiceChargeRow,
  type WalletMoveRow,
} from "@/lib/profilex/charges-report";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import { errorText } from "@/lib/app-error";
import { InsightsPeriodPicker } from "./outcome-report";

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
const outcomeText = (r: ChargeLookupRow) => (r.outcome === "found" ? "Found" : "Not found");
const correctionText = (r: ChargeLookupRow) =>
  r.correction
    ? `Was ${inr(r.correction.was)}, corrected to ${inr(r.cost)}` +
      (r.correction.refunded > 0
        ? ` — ${inr(r.correction.refunded)} refunded to the ${REFUNDED_TO_LABEL[r.correction.refundedTo]}`
        : ` — ${REFUNDED_TO_LABEL[r.correction.refundedTo]}`)
    : "";

const ROWS_SHOWN = 300;

export function ChargesReportButton({
  initialPeriod = "this-month",
}: {
  initialPeriod?: InsightsPeriod;
}) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<InsightsPeriod>(initialPeriod);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ChargesReport | null>(null);
  const [view, setView] = useState<"company" | "manager">("company");

  async function load(p: InsightsPeriod) {
    setLoading(true);
    try {
      const res = await getInsightsChargesReport({
        data: { accessToken: await getAccessToken(), since: periodSince(p) },
      });
      setReport(res.report);
      setView(res.view);
    } catch (e) {
      toast.error(errorText(e, "Could not build the charges report"));
    } finally {
      setLoading(false);
    }
  }

  const openReport = () => {
    setOpen(true);
    load(period);
  };
  const changePeriod = (p: InsightsPeriod) => {
    setPeriod(p);
    load(p);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={openReport}>
        <Receipt className="h-3.5 w-3.5 mr-1.5" /> Charges report
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Insights charges report</DialogTitle>
            <DialogDescription>
              {view === "company"
                ? "Every lookup your company paid for, what each one cost, and the wallet's top-ups and refunds."
                : "Every lookup you ran, what each one cost, and money added to or refunded to your wallet."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <InsightsPeriodPicker value={period} onChange={changePeriod} />
            {report && !loading && (
              <Button variant="outline" size="sm" onClick={() => exportReport(report, period)}>
                <FileDown className="h-3.5 w-3.5 mr-1.5" /> Download Excel
              </Button>
            )}
          </div>
          {loading || !report ? (
            <div className="flex items-center gap-2 py-12 justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Building the report…
            </div>
          ) : (
            <ReportBody report={report} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReportBody({ report }: { report: ChargesReport }) {
  const t = report.totals;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          icon={IndianRupee}
          label="Total charged"
          value={inr(t.amount)}
          sub={`${t.lookups} lookups`}
        />
        <Stat
          icon={Search}
          label="Found"
          value={inr(t.foundAmount)}
          sub={`${t.found} lookups`}
          green
        />
        <Stat
          icon={XCircle}
          label="Not found"
          value={inr(t.notFoundAmount)}
          sub={`${t.notFound} lookups — still billed by the provider`}
        />
        <Stat
          icon={RotateCcw}
          label="Corrected"
          value={inr(t.refunded)}
          sub={t.corrected ? `refunded on ${t.corrected} lookups` : "no corrections"}
        />
      </div>

      <ReportSection
        title="By service"
        description="How many lookups found something or not, and what each side cost."
      >
        <DataTable<ServiceChargeRow>
          rows={report.byService}
          keyOf={(r) => r.serviceId}
          empty="No charged lookups in this period."
          columns={[
            { key: "s", header: "Service", render: (r) => r.service },
            { key: "f", header: "Found", numeric: true, render: (r) => r.found },
            { key: "fa", header: "Found ₹", numeric: true, render: (r) => inr(r.foundAmount) },
            { key: "n", header: "Not found", numeric: true, render: (r) => r.notFound },
            {
              key: "na",
              header: "Not found ₹",
              numeric: true,
              render: (r) => inr(r.notFoundAmount),
            },
            { key: "t", header: "Total ₹", numeric: true, render: (r) => inr(r.totalAmount) },
          ]}
          footer={[
            "Total",
            t.found,
            inr(t.foundAmount),
            t.notFound,
            inr(t.notFoundAmount),
            inr(t.amount),
          ]}
        />
      </ReportSection>

      <ReportSection
        title="Every lookup"
        description={
          report.lookups.length > ROWS_SHOWN
            ? `Newest ${ROWS_SHOWN} of ${report.lookups.length} shown — the Excel file has all of them.`
            : "Newest first."
        }
      >
        <DataTable<ChargeLookupRow>
          rows={report.lookups.slice(0, ROWS_SHOWN)}
          keyOf={(r) => `${r.source}:${r.id}`}
          maxHeight="max-h-[420px]"
          empty="No charged lookups in this period."
          columns={[
            { key: "at", header: "When", width: "w-36", render: (r) => when(r.at) },
            { key: "s", header: "Service", render: (r) => r.service },
            {
              key: "b",
              header: "Borrower",
              render: (r) => (r.loanId ? `${r.borrower} · ${r.loanId}` : r.borrower),
            },
            { key: "w", header: "Run by", render: (r) => r.runBy },
            {
              key: "o",
              header: "Result",
              render: (r) => (
                <Badge variant={r.outcome === "found" ? "default" : "secondary"}>
                  {outcomeText(r)}
                </Badge>
              ),
            },
            { key: "c", header: "Charged", numeric: true, render: (r) => inr(r.cost) },
            {
              key: "x",
              header: "Correction",
              render: (r) => (
                <span className="text-xs text-muted-foreground">{correctionText(r)}</span>
              ),
            },
          ]}
        />
      </ReportSection>

      <ReportSection
        title="Wallet: money in and refunds"
        description="Top-ups, transfers and refunds in this period."
      >
        <DataTable<WalletMoveRow>
          rows={report.wallet}
          keyOf={(r, i) => `${r.at}:${i}`}
          maxHeight="max-h-[300px]"
          empty="No top-ups or refunds in this period."
          columns={[
            { key: "at", header: "When", width: "w-36", render: (r) => when(r.at) },
            {
              key: "l",
              header: "What",
              render: (r) => (r.manager ? `${r.label} (${r.manager})` : r.label),
            },
            {
              key: "a",
              header: "Amount",
              numeric: true,
              render: (r) => `${r.direction > 0 ? "+" : "−"}${inr(r.amount)}`,
            },
            {
              key: "n",
              header: "Note",
              render: (r) => <span className="text-xs text-muted-foreground">{r.note}</span>,
            },
          ]}
        />
      </ReportSection>
    </div>
  );
}

function exportReport(report: ChargesReport, period: InsightsPeriod) {
  const t = report.totals;
  return downloadXlsx(reportFilename(`insights-charges-${period}`), [
    {
      name: "Summary",
      headers: [
        "Period",
        "Lookups",
        "Total ₹",
        "Found",
        "Found ₹",
        "Not found",
        "Not found ₹",
        "Corrected",
        "Refunded ₹",
      ],
      rows: [
        [
          periodLabel(period),
          t.lookups,
          t.amount,
          t.found,
          t.foundAmount,
          t.notFound,
          t.notFoundAmount,
          t.corrected,
          t.refunded,
        ],
      ],
    },
    {
      name: "By service",
      headers: ["Service", "Found", "Found ₹", "Not found", "Not found ₹", "Total", "Total ₹"],
      rows: report.byService.map((r) => [
        r.service,
        r.found,
        r.foundAmount,
        r.notFound,
        r.notFoundAmount,
        r.total,
        r.totalAmount,
      ]),
    },
    {
      name: "Lookups",
      headers: [
        "When (IST)",
        "Service",
        "Borrower",
        "Loan ID",
        "Portfolio",
        "Run by",
        "Result",
        "Charged ₹",
        "Correction",
      ],
      rows: report.lookups.map((r) => {
        const c = lookupCellText(r, correctionText(r));
        return [
          when(r.at),
          r.service,
          r.borrower,
          c.loanId,
          c.portfolio,
          r.runBy,
          outcomeText(r),
          r.cost,
          c.correction,
        ];
      }),
    },
    {
      name: "Wallet",
      headers: ["When (IST)", "What", "Manager", "Amount ₹", "Note"],
      rows: report.wallet.map((r) => {
        const c = walletCellText(r);
        return [when(r.at), r.label, c.manager, r.direction * r.amount, c.note];
      }),
    },
  ]);
}
