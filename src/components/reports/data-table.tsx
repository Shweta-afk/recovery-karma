import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: string;
  /** Right-aligns and applies tabular figures — use for every numeric/currency column. */
  numeric?: boolean;
  /** Fixed width utility class (e.g. "w-32"). */
  width?: string;
  render: (row: T, index: number) => ReactNode;
}

/**
 * Dense spreadsheet-style table shared by every report page: sticky header, ruled cells,
 * zebra striping, and right-aligned tabular numerics so columns of figures line up the way
 * they would in Excel.
 */
export function DataTable<T>({
  columns,
  rows,
  keyOf,
  empty = "No data.",
  maxHeight,
  footer,
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string;
  empty?: string;
  /** e.g. "max-h-[600px]" — omit for an unbounded table. */
  maxHeight?: string;
  /** Totals row cells, aligned to `columns`. */
  footer?: ReactNode[];
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/40 py-10 text-center">
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card">
      <div className={cn("overflow-auto", maxHeight)}>
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/60 backdrop-blur">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "border-b border-r border-border last:border-r-0 px-3 py-2 font-semibold",
                    "text-[10px] uppercase tracking-wider text-muted-foreground whitespace-nowrap",
                    c.numeric ? "text-right" : "text-left",
                    c.width,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={keyOf(row, i)}
                className={cn("transition-colors hover:bg-primary/5", i % 2 === 1 && "bg-muted/20")}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "border-b border-r border-border/60 last:border-r-0 px-3 py-1.5 align-middle",
                      c.numeric ? "text-right tabular-nums" : "text-left",
                    )}
                  >
                    {c.render(row, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && (
            <tfoot className="sticky bottom-0">
              <tr className="bg-muted/70 backdrop-blur font-semibold">
                {footer.map((cell, i) => (
                  <td
                    key={columns[i]?.key ?? i}
                    className={cn(
                      "border-t-2 border-r border-border px-3 py-2 last:border-r-0",
                      columns[i]?.numeric ? "text-right tabular-nums" : "text-left",
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

/** Bordered, titled section wrapper — gives each report block its own visual box. */
export function ReportSection({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-xl border border-border bg-card/50 overflow-hidden", className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="h-4 w-4 text-primary shrink-0" />}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate">{title}</h3>
            {description && (
              <p className="text-[11px] text-muted-foreground truncate">{description}</p>
            )}
          </div>
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
