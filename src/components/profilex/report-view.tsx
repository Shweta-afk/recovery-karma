// An Insights / credit report laid out as tables: each section a label/value table, each list
// (loan accounts, enquiries, address variations…) a table with one row per item. Used by the
// debtor's Insights tab, Admin → Insights and the CIBIL panel, so every report reads the same.
// The layout itself is pure and tested: lib/profilex/report-layout.ts.
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildReportLayout,
  countValues,
  type ReportSection,
  type ReportTable,
} from "@/lib/profilex/report-layout";

/** Rows shown before "Show all" — a 76-account credit report shouldn't push everything else off. */
const ROWS_SHOWN = 10;

function KeyValueTable({ fields }: { fields: ReportSection["fields"] }) {
  if (!fields.length) return null;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <tbody>
          {fields.map((f, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              <th
                scope="row"
                className="w-2/5 bg-muted/40 px-2.5 py-1.5 text-left align-top font-medium text-muted-foreground"
              >
                {f.label}
              </th>
              <td className="px-2.5 py-1.5 align-top font-medium text-foreground break-words">
                {f.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowsTable({ table }: { table: ReportTable }) {
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, ROWS_SHOWN);
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold text-foreground">
        {table.title}{" "}
        <span className="font-normal text-muted-foreground">({table.rows.length})</span>
      </p>
      <div className="max-h-[28rem] overflow-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">#</th>
              {table.columns.map((c) => (
                <th
                  key={c}
                  className="whitespace-nowrap px-2 py-1.5 text-left font-semibold text-muted-foreground"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border/60 even:bg-muted/20">
                <td className="px-2 py-1.5 align-top text-muted-foreground">{i + 1}</td>
                {r.map((c, j) => (
                  <td key={j} className="min-w-[6rem] px-2 py-1.5 align-top text-foreground">
                    {c || <span className="text-muted-foreground/50">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > ROWS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="text-[11px] text-primary hover:underline"
        >
          {all ? "Show fewer" : `Show all ${table.rows.length}`}
        </button>
      )}
    </div>
  );
}

function Section({ section, depth }: { section: ReportSection; depth: number }) {
  const [open, setOpen] = useState(true);
  const body = (
    <div className="space-y-3">
      <KeyValueTable fields={section.fields} />
      {section.tables.map((t, i) => (
        <RowsTable key={i} table={t} />
      ))}
      {section.sections.map((s, i) => (
        <Section key={i} section={s} depth={depth + 1} />
      ))}
    </div>
  );
  if (depth === 0) return body;
  return (
    <div className={cn("space-y-2", depth > 1 && "border-l-2 border-border pl-3")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-foreground"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        {section.title}
      </button>
      {open && body}
    </div>
  );
}

/**
 * @param response the stored provider response (the whole object; envelopes are peeled off).
 * @param empty    what to say when the provider sent nothing usable.
 */
export function ReportView({
  response,
  title = "Report",
  empty = "The provider returned no details.",
}: {
  response: unknown;
  title?: string;
  empty?: string;
}) {
  const layout = useMemo(() => buildReportLayout(response, title), [response, title]);
  if (countValues(layout) === 0) {
    return <p className="text-xs italic text-muted-foreground">{empty}</p>;
  }
  return <Section section={layout} depth={0} />;
}

/** True when a response has anything ReportView would show. */
export function hasReportValues(response: unknown): boolean {
  return countValues(buildReportLayout(response)) > 0;
}
