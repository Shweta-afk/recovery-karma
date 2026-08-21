import { FileDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatINR } from "@/lib/mock-debtors";
import { downloadCsv } from "@/lib/csv-export";
import type { DispositionRecord } from "@/lib/disposition-store";
import { OUTCOME_LABELS, OUTCOME_COLOR } from "@/components/reports/outcome-breakdown";

/** Expandable per-agent call log (most recent 10, with a CSV export of the full list) —
 * shared by admin/reports and manager/reports' "By Agent" tab. */
export function AgentCallLog({
  disps,
  agentName,
}: {
  disps: DispositionRecord[];
  agentName: string;
}) {
  if (disps.length === 0)
    return <p className="text-xs text-muted-foreground">No calls logged for {agentName} yet.</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">
          {agentName} · {disps.length} calls
        </span>
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              `${agentName}-calls.csv`,
              ["Time", "Debtor", "Phone", "Outcome", "PTP Amount", "Notes"],
              disps.map((d) => [
                new Date(d.time).toLocaleString("en-IN"),
                d.debtorName,
                d.phone,
                d.outcome,
                d.ptpAmount ?? "",
                d.notes,
              ]),
            )
          }
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors"
        >
          <FileDown className="h-2.5 w-2.5" />
          Export
        </button>
      </div>
      {disps.slice(0, 10).map((d) => (
        <div key={d.id} className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground w-32 shrink-0">
            {new Date(d.time).toLocaleString("en-IN", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="font-medium text-foreground min-w-0 truncate flex-1">
            {d.debtorName}
          </span>
          <span className={cn("font-medium shrink-0", OUTCOME_COLOR[d.outcome])}>
            {OUTCOME_LABELS[d.outcome] ?? d.outcome}
          </span>
          {d.ptpAmount ? (
            <span className="text-success shrink-0">{formatINR(d.ptpAmount)}</span>
          ) : null}
        </div>
      ))}
      {disps.length > 10 && (
        <p className="text-[10px] text-muted-foreground">+{disps.length - 10} more calls</p>
      )}
    </div>
  );
}
