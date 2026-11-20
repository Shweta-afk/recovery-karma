import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ExcelButton } from "@/components/superadmin/usage-shared";
import { PageGuide } from "@/components/superadmin/help";
import { todayIstKey } from "@/lib/date-filter";
import { shiftDay } from "@/lib/superadmin-range";
import type { HealthReport } from "@/lib/health-checks.server";
import { SeverityIcon, useHealthReport } from "@/components/superadmin/health-shared";
import { overallHealth, type HealthCheckResult, type Severity } from "@/lib/health-checks";
import { downloadXlsx } from "@/lib/xlsx-export";

export const Route = createFileRoute("/superadmin/health")({
  head: () => ({ meta: [{ title: "Health Check · SamvadX Platform" }] }),
  component: HealthPage,
});

function HealthPage() {
  const today = todayIstKey();
  const [day, setDay] = useState(today);
  const { report, loading, error, reload } = useHealthReport(day);
  const overall = report ? overallHealth(report.results) : null;
  const areas = ["Data safety", "Calling", "Insights"] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Health Check</h1>
            <Badge variant="secondary">Superadmin</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Automatic checks for problems we have had before, across every company — so a bug shows
            up the same day, not a week later.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={day === today ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setDay(today)}
          >
            Today
          </Button>
          <Button
            size="sm"
            variant={day === shiftDay(today, -1) ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setDay(shiftDay(today, -1))}
          >
            Yesterday
          </Button>
          <Input
            type="date"
            value={day}
            max={today}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-8 w-[150px] text-xs"
          />
          <ExcelButton disabled={!report} onExport={() => exportHealth(report!)} />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            disabled={loading}
            onClick={reload}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Run again
          </Button>
        </div>
      </div>

      <PageGuide page="health" />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {report && overall && (
        <div
          className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
            overall.severity === "bad"
              ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              : overall.severity === "warn"
                ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                : "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          }`}
        >
          <SeverityIcon s={overall.severity} className="h-5 w-5 shrink-0" />
          <span>
            {overall.severity === "ok"
              ? "All checks passed."
              : `${overall.bad} serious and ${overall.warn} to watch.`}{" "}
            {report.partial
              ? `Today so far (midnight IST to ${new Date(report.generatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}).`
              : `Whole day ${report.day}.`}
          </span>
        </div>
      )}

      {report &&
        areas.map((area) => (
          <Card key={area}>
            <CardHeader className="border-b border-border pb-3">
              <CardTitle className="text-sm font-semibold">{area}</CardTitle>
            </CardHeader>
            <CardContent className="divide-y divide-border p-0">
              {report.results
                .filter((r) => r.area === area)
                .map((r) => (
                  <CheckRow key={r.id} r={r} />
                ))}
            </CardContent>
          </Card>
        ))}

      {!report && loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Running the checks…
        </p>
      )}
    </div>
  );
}

function CheckRow({ r }: { r: HealthCheckResult }) {
  const [open, setOpen] = useState(r.severity === "bad");
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <SeverityIcon s={r.severity} />
        <span className="flex-1 text-sm font-medium text-foreground">{r.title}</span>
        <span className="text-xs text-muted-foreground">{r.summary}</span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-2 space-y-2 pl-7 text-xs">
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">What it means: </span>
            {r.why}
          </p>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">What to do: </span>
            {r.todo}
          </p>
          {r.items.length > 0 && (
            <ul className="space-y-1">
              {r.items.map((it, i) => (
                <li key={i} className="flex items-start gap-2">
                  <SeverityIcon s={it.severity} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {it.company && <span className="font-medium">{it.company}: </span>}
                    {it.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

async function exportHealth(report: HealthReport) {
  const label = (s: Severity) => (s === "bad" ? "Serious" : s === "warn" ? "Watch" : "OK");
  await downloadXlsx(`samvadx-health-check-${report.day}.xlsx`, [
    {
      name: "Checks",
      headers: ["Area", "Check", "Status", "Summary", "What it means", "What to do"],
      rows: report.results.map((r) => [
        r.area,
        r.title,
        label(r.severity),
        r.summary,
        r.why,
        r.todo,
      ]),
    },
    {
      name: "Problems",
      headers: ["Area", "Check", "Status", "Company", "Detail"],
      rows: report.results.flatMap((r) =>
        r.items.map((it) => [r.area, r.title, label(it.severity), it.company ?? "", it.text]),
      ),
    },
  ]);
}
