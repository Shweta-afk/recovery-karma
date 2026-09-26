// The Insights tab on Admin and Manager Reports: two views of the same lookups.
//   Outcomes            — what happened on each account after a lookup (outcome-report.tsx)
//   Data by Loan ID     — everything the lookups found per account, vs the bank file
//                         (loan-lookup-report.tsx)
// `children` renders under Outcomes only — Admin adds its usage/spend panels there.
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { InsightsPeriod } from "@/lib/profilex/period";
import { InsightsOutcomeReport, InsightsPeriodPicker } from "./outcome-report";
import { LoanLookupReport } from "./loan-lookup-report";

type View = "outcomes" | "loan-data";
const VIEWS: { value: View; label: string }[] = [
  { value: "outcomes", label: "Lookup outcomes" },
  { value: "loan-data", label: "Lookup data by Loan ID" },
];

export function InsightsReports({
  period,
  onPeriodChange,
  showManagerFilter = true,
  children,
}: {
  period: InsightsPeriod;
  onPeriodChange: (p: InsightsPeriod) => void;
  showManagerFilter?: boolean;
  children?: ReactNode;
}) {
  const [view, setView] = useState<View>("outcomes");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-border bg-card p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              onClick={() => setView(v.value)}
              className={cn(
                "rounded px-3 py-1 text-xs transition-colors",
                view === v.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === "outcomes" && <InsightsPeriodPicker value={period} onChange={onPeriodChange} />}
      </div>
      {view === "outcomes" ? (
        <div className="space-y-6">
          <InsightsOutcomeReport period={period} showManagerFilter={showManagerFilter} />
          {children}
        </div>
      ) : (
        <LoanLookupReport />
      )}
    </div>
  );
}
