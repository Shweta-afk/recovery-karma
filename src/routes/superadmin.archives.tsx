import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Download, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageGuide } from "@/components/superadmin/help";
import { ExcelButton, Explained } from "@/components/superadmin/usage-shared";
import { getAccessToken } from "@/lib/access-token";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import { errorText } from "@/lib/app-error";
import {
  getSavedArchiveDownload,
  listSavedArchives,
  saveArchiveCopyNow,
  type SavedArchiveRow,
  type UnsavedEnding,
  type UnsavedMonth,
} from "@/lib/saved-archive-actions.server";

export const Route = createFileRoute("/superadmin/archives")({
  head: () => ({ meta: [{ title: "Saved Archives · SamvadX Platform" }] }),
  component: SavedArchivesPage,
});

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
const size = (n: number | null) =>
  n == null
    ? "—"
    : n < 1024 * 1024
      ? `${Math.max(1, Math.round(n / 1024))} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

const what = (r: SavedArchiveRow) =>
  r.kind === "month"
    ? `Month: ${r.month ? monthLabel(r.month) : ""}`
    : (r.portfolioName ?? "Portfolio");
const ended = (r: { endedOn: string | null; endedBy: string | null }) =>
  r.endedOn ? `${r.endedOn}${r.endedBy === "closed" ? " (closed)" : " (end date)"}` : "—";
const accounts = (r: SavedArchiveRow) => r.sheetCounts?.Accounts ?? null;

function SavedArchivesPage() {
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<SavedArchiveRow[]>([]);
  const [unsavedEndings, setUnsavedEndings] = useState<UnsavedEnding[]>([]);
  const [unsavedMonths, setUnsavedMonths] = useState<UnsavedMonth[]>([]);
  const [company, setCompany] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listSavedArchives({ data: { accessToken: await getAccessToken() } });
      setSaved(res.saved);
      setUnsavedEndings(res.unsavedEndings);
      setUnsavedMonths(res.unsavedMonths);
    } catch (e) {
      toast.error(errorText(e, "Could not load saved archives"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const companies = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of [...saved, ...unsavedEndings, ...unsavedMonths])
      m.set(r.clientId, r.companyName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [saved, unsavedEndings, unsavedMonths]);

  const pick = <T extends { clientId: string }>(rows: T[]) =>
    company === "all" ? rows : rows.filter((r) => r.clientId === company);
  const shownSaved = pick(saved);
  const shownEndings = pick(unsavedEndings);
  const shownMonths = pick(unsavedMonths);

  const download = async (r: SavedArchiveRow) => {
    setBusy(r.id);
    try {
      const { url } = await getSavedArchiveDownload({
        data: { accessToken: await getAccessToken(), id: r.id },
      });
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener";
      a.click();
      setSaved((rows) =>
        rows.map((x) =>
          x.id === r.id
            ? {
                ...x,
                downloadCount: x.downloadCount + 1,
                lastDownloadedAt: new Date().toISOString(),
              }
            : x,
        ),
      );
    } catch (e) {
      toast.error(errorText(e, "Download failed"));
    } finally {
      setBusy(null);
    }
  };

  const saveCopy = async (
    key: string,
    target: { clientId: string; portfolioId?: string; month?: string },
  ) => {
    setBusy(key);
    try {
      const res = await saveArchiveCopyNow({
        data: { accessToken: await getAccessToken(), ...target },
      });
      if (res.saved) toast.success("Copy saved");
      else toast.info(`Not saved: ${res.note}`);
      await load();
    } catch (e) {
      toast.error(errorText(e, "Could not save the copy"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Saved Archives</h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          SamvadX&apos;s own copy of every company&apos;s archives — each portfolio when it ends,
          and each month&apos;s Archive History file — so you can hand one over if a company asks
          for a file it forgot to download. Companies do not see this page.
        </p>
      </div>

      <PageGuide page="archives" />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={company} onValueChange={setCompany}>
          <SelectTrigger className="h-8 w-64 text-xs">
            <SelectValue placeholder="All companies" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All companies</SelectItem>
            {companies.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ExcelButton
          disabled={loading || shownSaved.length === 0}
          onExport={() =>
            downloadXlsx(reportFilename("saved-archives"), [
              {
                name: "Saved archives",
                headers: [
                  "Company",
                  "Archive",
                  "Ended",
                  "Accounts",
                  "Size (KB)",
                  "Saved",
                  "Saved by",
                  "Downloads",
                  "Last downloaded",
                ],
                rows: shownSaved.map((r) => [
                  r.companyName,
                  what(r),
                  ended(r),
                  accounts(r),
                  r.sizeBytes == null ? null : Math.round(r.sizeBytes / 1024),
                  when(r.createdAt),
                  r.savedBy === "schedule" ? "Automatic" : "Superadmin",
                  r.downloadCount,
                  r.lastDownloadedAt ? when(r.lastDownloadedAt) : "",
                ]),
              },
            ])
          }
        />
      </div>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Archive className="h-4 w-4 text-primary" />
            <Explained k="savedArchive">Saved copies</Explained>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : shownSaved.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No copies saved yet. The first ones appear the day after a portfolio ends, or on the
              1st of the month.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium">Archive</th>
                    <th className="py-2 pr-4 font-medium">Ended</th>
                    <th className="py-2 pr-4 text-right font-medium">Accounts</th>
                    <th className="py-2 pr-4 text-right font-medium">Size</th>
                    <th className="py-2 pr-4 font-medium">Saved</th>
                    <th className="py-2 pr-4 text-right font-medium">
                      <Explained k="downloads">Downloads</Explained>
                    </th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {shownSaved.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4 text-muted-foreground">{r.companyName}</td>
                      <td className="py-2 pr-4 font-medium text-foreground">{what(r)}</td>
                      <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                        {ended(r)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{accounts(r) ?? "—"}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{size(r.sizeBytes)}</td>
                      <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                        {when(r.createdAt)}
                        {r.savedBy === "superadmin" && (
                          <span className="ml-1 text-[10px]">(by hand)</span>
                        )}
                      </td>
                      <td
                        className="py-2 pr-4 text-right tabular-nums"
                        title={r.lastDownloadedAt ? `Last: ${when(r.lastDownloadedAt)}` : undefined}
                      >
                        {r.downloadCount}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={busy !== null}
                          onClick={() => download(r)}
                        >
                          {busy === r.id ? (
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

      {!loading && (shownEndings.length > 0 || shownMonths.length > 0) && (
        <Card>
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm font-semibold">
              <Explained k="notSavedYet">Not saved yet</Explained>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium">Archive</th>
                    <th className="py-2 pr-4 font-medium">Ended</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {shownEndings.map((e) => {
                    const key = `p:${e.portfolioId}`;
                    return (
                      <tr key={key} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4 text-muted-foreground">{e.companyName}</td>
                        <td className="py-2 pr-4 font-medium text-foreground">{e.portfolioName}</td>
                        <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                          {ended(e)}
                        </td>
                        <td className="py-2 text-right">
                          <SaveButton
                            busy={busy === key}
                            disabled={busy !== null}
                            onClick={() =>
                              saveCopy(key, { clientId: e.clientId, portfolioId: e.portfolioId })
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {shownMonths.map((m) => {
                    const key = `m:${m.clientId}:${m.month}`;
                    return (
                      <tr key={key} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4 text-muted-foreground">{m.companyName}</td>
                        <td className="py-2 pr-4 font-medium text-foreground">
                          Month: {monthLabel(m.month)}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground">—</td>
                        <td className="py-2 text-right">
                          <SaveButton
                            busy={busy === key}
                            disabled={busy !== null}
                            onClick={() => saveCopy(key, { clientId: m.clientId, month: m.month })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SaveButton({
  busy,
  disabled,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? (
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
      ) : (
        <Save className="mr-1.5 h-3.5 w-3.5" />
      )}
      Save copy
    </Button>
  );
}
