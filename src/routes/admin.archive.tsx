import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, DatabaseBackup, FileArchive } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { getAccessToken } from "@/lib/access-token";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { runArchiveNow, getDeadAccountFileUrl } from "@/lib/archive-actions.server";
import { ARCHIVE_SHEETS, shapeSheet } from "@/lib/archive-shared";

export const Route = createFileRoute("/admin/archive")({
  head: () => ({ meta: [{ title: "Archive History · SamvadX" }] }),
  component: AdminArchivePage,
});

interface RunRow {
  id: string;
  month: string;
  status: "running" | "done" | "failed";
  counts: Record<string, number> | null;
  error: string | null;
  triggered_by: string;
  finished_at: string | null;
}

interface DeadFileRow {
  id: string;
  portfolio_name: string;
  closed_at: string | null;
  account_count: number;
  size_bytes: number | null;
  created_at: string;
}

const kb = (n: number | null) => (n == null ? "—" : `${Math.max(1, Math.round(n / 1024))} KB`);

const MONTH_FMT = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" });
const monthLabel = (m: string) => MONTH_FMT.format(new Date(`${m}-15T00:00:00`));
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";

function AdminArchivePage() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deadFiles, setDeadFiles] = useState<DeadFileRow[] | null>(null);
  const [fileDownloading, setFileDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [runsRes, filesRes] = await Promise.all([
      supabase
        .from("monthly_archive_runs")
        .select("id, month, status, counts, error, triggered_by, finished_at")
        .order("month", { ascending: false }),
      supabase
        .from("dead_account_files")
        .select("id, portfolio_name, closed_at, account_count, size_bytes, created_at")
        .order("created_at", { ascending: false }),
    ]);
    if (runsRes.error) {
      // Almost always "relation does not exist": the migration has not been applied yet.
      toast.error(`Could not load the archive: ${runsRes.error.message}`);
      setRuns([]);
    } else {
      setRuns((runsRes.data ?? []) as unknown as RunRow[]);
    }
    // Quietly empty rather than a second toast: same cause (migration not applied) as above.
    setDeadFiles(filesRes.error ? [] : ((filesRes.data ?? []) as unknown as DeadFileRow[]));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const archiveNow = async () => {
    setArchiving(true);
    try {
      const { results, accounts, deadAccounts } = await runArchiveNow({
        data: { accessToken: await getAccessToken() },
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(`${failed.length} month(s) failed: ${failed[0].error}`);
      } else {
        toast.success(`Archived ${results.length} month${results.length === 1 ? "" : "s"}.`);
      }
      if (accounts.error) toast.error(`Account details were not saved: ${accounts.error}`);
      if (deadAccounts.error) {
        toast.error(`Closed accounts were not archived: ${deadAccounts.error}`);
      } else if (deadAccounts.failed.length) {
        toast.error(
          `${deadAccounts.failed[0].portfolio}: ${deadAccounts.failed[0].error}` +
            (deadAccounts.failed.length > 1 ? ` (+${deadAccounts.failed.length - 1} more)` : ""),
        );
      } else if (deadAccounts.archived) {
        toast.success(
          `Archived ${deadAccounts.archived} closed account${deadAccounts.archived === 1 ? "" : "s"} into ${deadAccounts.files} file${deadAccounts.files === 1 ? "" : "s"}.`,
        );
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Archive failed");
    } finally {
      setArchiving(false);
    }
  };

  const download = async (month: string) => {
    setDownloading(month);
    try {
      // Loaded on demand: the Excel writer is large and only admins on this page ever need it.
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "SamvadX";
      let sheets = 0;
      for (const { kind, sheet } of ARCHIVE_SHEETS) {
        const { data, error } = await fetchAllRows<{ data: Record<string, unknown> }>(
          (from, to) =>
            supabase
              .from("monthly_archive_rows")
              .select("data")
              .eq("month", month)
              .eq("kind", kind)
              .order("id", { ascending: true })
              .range(from, to) as unknown as PromiseLike<{
              data: { data: Record<string, unknown> }[] | null;
              error: { message: string } | null;
            }>,
        );
        if (error) throw new Error(`${sheet}: ${error.message}`);
        if (!data.length) continue;
        const { columns, values } = shapeSheet(data.map((r) => r.data));
        const ws = wb.addWorksheet(sheet);
        ws.addRow(columns).font = { bold: true };
        ws.views = [{ state: "frozen", ySplit: 1 }];
        for (const v of values) ws.addRow(v);
        sheets += 1;
      }
      if (!sheets) {
        toast.info("Nothing was saved for that month.");
        return;
      }
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(
        new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `samvadx-archive-${month}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(null);
    }
  };

  const downloadDeadFile = async (f: DeadFileRow) => {
    setFileDownloading(f.id);
    try {
      const { url } = await getDeadAccountFileUrl({
        data: { accessToken: await getAccessToken(), fileId: f.id },
      });
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      a.click();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    } finally {
      setFileDownloading(null);
    }
  };

  const total = (c: Record<string, number> | null) =>
    Object.values(c ?? {}).reduce((s, n) => s + (Number(n) || 0), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Archive History</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every month, all Insights lookups, calls and feedback notes, payments, messages,
            disputes and account details are saved permanently — even after a portfolio is closed or
            deleted. Saved lookups are also reused when the same phone number appears in a new
            upload, so you are not charged twice for the same borrower.
          </p>
        </div>
        <Button onClick={archiveNow} disabled={archiving}>
          {archiving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <DatabaseBackup className="mr-2 h-4 w-4" />
          )}
          Archive now
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saved months</CardTitle>
        </CardHeader>
        <CardContent>
          {runs === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing archived yet. Press “Archive now” to save everything up to today.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4">Month</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4 text-right">Lookups</th>
                    <th className="py-2 pr-4 text-right">Calls</th>
                    <th className="py-2 pr-4 text-right">Payments</th>
                    <th className="py-2 pr-4 text-right">Total rows</th>
                    <th className="py-2 pr-4">Last saved</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{monthLabel(r.month)}</td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={r.status === "failed" ? "destructive" : "secondary"}
                          title={r.error ?? undefined}
                        >
                          {r.status === "done"
                            ? "Saved"
                            : r.status === "running"
                              ? "Running"
                              : "Failed"}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.counts?.trace ?? 0}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.counts?.call_log ?? 0}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {r.counts?.payment ?? 0}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{total(r.counts)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{when(r.finished_at)}</td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={downloading !== null || r.status !== "done"}
                          onClick={() => download(r.month)}
                        >
                          {downloading === r.month ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Excel
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            The Accounts and Portfolios sheets list only records that were new or changed in that
            month, so the file stays a manageable size.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileArchive className="h-4 w-4" />
            Closed accounts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 max-w-3xl text-sm text-muted-foreground">
            60 days after a portfolio is closed, each account with nothing still open on it — no
            recent promise-to-pay or callback, no retention request — is saved to a file here: name,
            loan ID, phone, every call with its disposition and feedback, and every Insights result.
            The account itself is then slimmed down (the bank file&apos;s extra columns are cleared)
            so the platform stays fast. Payments, reports and call history are not affected, and
            Insights results are still reused if the same phone number comes back.
          </p>
          {deadFiles === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : deadFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No closed accounts archived yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4">Portfolio</th>
                    <th className="py-2 pr-4">Closed</th>
                    <th className="py-2 pr-4 text-right">Accounts</th>
                    <th className="py-2 pr-4 text-right">Size</th>
                    <th className="py-2 pr-4">Archived</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {deadFiles.map((f) => (
                    <tr key={f.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{f.portfolio_name}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{when(f.closed_at)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{f.account_count}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{kb(f.size_bytes)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{when(f.created_at)}</td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={fileDownloading !== null}
                          onClick={() => downloadDeadFile(f)}
                        >
                          {fileDownloading === f.id ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Excel
                        </Button>
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
