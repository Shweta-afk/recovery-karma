// ProfileX spend for the current month. This is the only place the money shows up: the provider
// has no balance or usage endpoint, so `debtor_traces` is the sole record on our side and this
// is what gets reconciled against Neokred's invoice.
//
// The number that actually decides whether the integration is worth keeping is "paid, no data" —
// ProfileX bills for a not-found result on every service except Mobile to UAN, so a high miss
// rate means money going out for nothing.
import { useEffect, useState } from "react";
import { IndianRupee, Search, Loader2, TriangleAlert, FileDown } from "lucide-react";
import { downloadCsv } from "@/lib/csv-export";
import { periodLabel, periodSince, type InsightsPeriod } from "@/lib/profilex/period";
import { Progress } from "@/components/ui/progress";
import { Stat } from "@/components/reports/stat-card";
import { DataTable, ReportSection } from "@/components/reports/data-table";
import { supabase } from "@/lib/supabase";
import { getProfilexSpend } from "@/lib/profilex-actions.server";
import { serviceLabel } from "@/lib/profilex-store";

import type { ServiceSpendRow as ServiceSpend } from "@/lib/profilex-actions.server";
import { errorText } from "@/lib/app-error";

export function ProfilexSpendPanel({ period = "this-month" }: { period?: InsightsPeriod }) {
  const label = periodLabel(period).toLowerCase();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ServiceSpend[]>([]);
  const [totalSpend, setTotalSpend] = useState(0);
  const [budget, setBudget] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired — sign in again");
        const res = await getProfilexSpend({
          data: { accessToken: session.access_token, since: periodSince(period) },
        });
        if (cancelled) return;
        setRows(res.byService.map((r) => ({ ...r, spend: Number(r.spend) })));
        setTotalSpend(Number(res.totalSpend));
        setBudget(Number(res.monthlyBudget));
      } catch (e) {
        setError(errorText(e, "Could not load Insights spend"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading spend…
      </div>
    );
  }
  if (error) return <p className="text-xs text-destructive">{error}</p>;

  const totalCalls = rows.reduce((n, r) => n + Number(r.calls), 0);
  const totalMisses = rows.reduce((n, r) => n + Number(r.misses), 0);
  const wasted = rows.reduce(
    (n, r) => n + (Number(r.calls) ? (Number(r.spend) * Number(r.misses)) / Number(r.calls) : 0),
    0,
  );
  const pctOfBudget = budget > 0 ? Math.min(100, (totalSpend / budget) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={IndianRupee}
          label={period === "this-month" ? "Spent this month" : `Spent (${label})`}
          value={`₹${totalSpend.toFixed(2)}`}
          sub={
            period === "this-month" && budget > 0
              ? `of ₹${budget.toFixed(2)} budget`
              : period === "this-month"
                ? "no budget cap set"
                : undefined
          }
        />
        <Stat icon={Search} label="Lookups run" value={String(totalCalls)} />
        <Stat
          icon={TriangleAlert}
          label="Paid, no data"
          value={String(totalMisses)}
          sub={totalCalls ? `${Math.round((totalMisses / totalCalls) * 100)}% of lookups` : "—"}
        />
        <Stat
          icon={IndianRupee}
          label="Spent on no data"
          // Apportioned from each service's own spend rather than assumed, since the miss price
          // differs per service (and is ₹0 for Mobile to UAN).
          value={`₹${wasted.toFixed(2)}`}
          sub="approximate"
        />
      </div>

      {period === "this-month" && budget > 0 && (
        <div>
          <div className="flex justify-between text-[11px] text-muted-foreground mb-1">
            <span>Monthly budget</span>
            <span>
              ₹{totalSpend.toFixed(2)} / ₹{budget.toFixed(2)}
            </span>
          </div>
          <Progress value={pctOfBudget} />
        </div>
      )}

      <ReportSection
        title="By service"
        description={`Every Insights lookup (${label}), and what it returned.`}
        action={
          rows.length > 0 ? (
            <button
              type="button"
              onClick={() =>
                downloadCsv(
                  `insights-by-service-${period}.csv`,
                  ["Service", "Lookups", "Found", "Paid, no data", "Failed (free)", "Spend (₹)"],
                  rows.map((r) => [
                    serviceLabel(r.service_id),
                    Number(r.calls),
                    Number(r.hits),
                    Number(r.misses),
                    Number(r.failures),
                    Number(r.spend),
                  ]),
                )
              }
              className="inline-flex items-center gap-1.5 h-7 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <FileDown className="h-3.5 w-3.5" />
              Export
            </button>
          ) : undefined
        }
        icon={Search}
      >
        <DataTable
          columns={[
            {
              key: "service",
              header: "Service",
              render: (r: ServiceSpend) => serviceLabel(r.service_id),
            },
            { key: "calls", header: "Lookups", numeric: true, render: (r) => String(r.calls) },
            { key: "hits", header: "Found", numeric: true, render: (r) => String(r.hits) },
            {
              key: "misses",
              header: "Paid, no data",
              numeric: true,
              render: (r) => String(r.misses),
            },
            {
              key: "failures",
              header: "Failed (free)",
              numeric: true,
              render: (r) => String(r.failures),
            },
            {
              key: "spend",
              header: "Spend",
              numeric: true,
              render: (r) => `₹${Number(r.spend).toFixed(2)}`,
            },
          ]}
          rows={rows}
          keyOf={(r) => r.service_id}
          empty={`No lookups (${label}).`}
        />
      </ReportSection>
    </div>
  );
}
