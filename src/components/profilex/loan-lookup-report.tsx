// "Lookup data by Loan ID": pick a portfolio, see everything Insights found on each account —
// numbers, emails, identity, employment, addresses — beside what the bank file says about that
// loan, with a Match / Differs call on each comparable field. All lookups ever run on the
// portfolio, not a period. Download is an Excel file: one row per loan, plus every field of
// every lookup on a second sheet. Logic in src/lib/profilex/loan-lookup-data.ts.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  FileDown,
  Search,
  IdCard,
  PhoneCall,
  Briefcase,
  MapPin,
  IndianRupee,
  Loader2,
  Clock,
  Send,
  XCircle,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Stat } from "@/components/reports/stat-card";
import { ReportSection, DataTable } from "@/components/reports/data-table";
import { getAccessToken } from "@/lib/access-token";
import {
  getLookupExportStatus,
  getPortfolioLookupData,
  getPortfolioLookupExport,
  listInsightsPortfolios,
  requestLookupExport,
  type LookupExportStatus,
} from "@/lib/profilex-actions.server";
import { serviceLabel } from "@/lib/profilex-store";
import {
  COMPARE_LABEL,
  LOAN_EXPORT_HEADERS,
  buildServiceSheets,
  loanExportRow,
  type Compare,
  type LoanLookupRow,
} from "@/lib/profilex/loan-lookup-data";
import { errorText } from "@/lib/app-error";

interface PortfolioOption {
  id: string;
  name: string;
  lender: string;
  product: string;
  closed: boolean;
}

const ALL = "all";
const ROWS_SHOWN = 500;
const STORAGE_KEY = "insights-loan-data-portfolio";

const inr = (n: number) =>
  `₹${n.toLocaleString("en-IN", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;

type Focus = "all" | "numbers" | "employer" | "address" | "differs";
const FOCUS: { value: Focus; label: string; test: (r: LoanLookupRow) => boolean }[] = [
  { value: "numbers", label: "New numbers found", test: (r) => r.newNumbers.length > 0 },
  { value: "employer", label: "Employer found", test: (r) => !!r.employer },
  { value: "address", label: "Addresses found", test: (r) => r.addresses.length > 0 },
  {
    value: "differs",
    label: "Differs from bank file",
    test: (r) => Object.values(r.compare).includes("differs"),
  },
];

function CompareChip({ label, value }: { label: string; value: Compare }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1 text-[10px] whitespace-nowrap",
        value === "match"
          ? "border-success/30 bg-success/10 text-success"
          : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      )}
    >
      {label} {COMPARE_LABEL[value].toLowerCase()}
    </span>
  );
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function LoanLookupReport() {
  const [portfolios, setPortfolios] = useState<PortfolioOption[]>([]);
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [rows, setRows] = useState<LoanLookupRow[]>([]);
  const [exportState, setExportState] = useState<LookupExportStatus | null>(null);
  const [requestNote, setRequestNote] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<Focus>("all");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await listInsightsPortfolios({
          data: { accessToken: await getAccessToken() },
        });
        setPortfolios(res.portfolios);
        const stored = readStored();
        if (stored && res.portfolios.some((p) => p.id === stored)) setPortfolioId(stored);
      } catch (e) {
        setError(errorText(e, "Could not load portfolios"));
      }
    })();
  }, []);

  useEffect(() => {
    if (!portfolioId) return;
    try {
      localStorage.setItem(STORAGE_KEY, portfolioId);
    } catch {
      /* per-viewer convenience only */
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const accessToken = await getAccessToken();
        const [res, status] = await Promise.all([
          getPortfolioLookupData({ data: { accessToken, portfolioId } }),
          getLookupExportStatus({ data: { accessToken, portfolioId } }).catch(() => null),
        ]);
        if (cancelled) return;
        setRows(res.rows);
        setExportState(status);
      } catch (e) {
        if (!cancelled) setError(errorText(e, "Could not load lookup data"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [portfolioId]);

  const portfolio = portfolios.find((p) => p.id === portfolioId);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const f = FOCUS.find((x) => x.value === focus);
    return rows.filter(
      (r) =>
        (!f || f.test(r)) &&
        (!q ||
          r.loanReference.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          r.phonePrimary.includes(q) ||
          r.newNumbers.some((n) => n.includes(q))),
    );
  }, [rows, query, focus]);

  const stats = useMemo(() => {
    const count = (t: (r: LoanLookupRow) => boolean) => rows.filter(t).length;
    return {
      accounts: rows.length,
      lookups: rows.reduce((s, r) => s + r.lookups, 0),
      spend: rows.reduce((s, r) => s + r.cost, 0),
      withNumbers: count((r) => r.newNumbers.length > 0),
      numbers: rows.reduce((s, r) => s + r.newNumbers.length, 0),
      withEmployer: count((r) => !!r.employer),
      employerDiffers: count((r) => r.compare.employer === "differs"),
      withAddress: count((r) => r.addresses.length > 0),
      cityDiffers: count((r) => r.compare.city === "differs"),
      withIdentity: count((r) => !!(r.pan || r.uan || r.dob)),
      nameDiffers: count((r) => r.compare.name === "differs"),
    };
  }, [rows]);

  const sendRequest = async () => {
    if (!portfolioId) return;
    setRequesting(true);
    try {
      const status = await requestLookupExport({
        data: {
          accessToken: await getAccessToken(),
          portfolioId,
          note: requestNote.trim() || undefined,
        },
      });
      setExportState(status);
      setRequestNote("");
      toast.success("Request sent — you'll be notified when it's approved");
    } catch (e) {
      toast.error(errorText(e, "Could not send the request"));
    } finally {
      setRequesting(false);
    }
  };

  const exportXlsx = async () => {
    if (!portfolio || !portfolioId) return;
    setExporting(true);
    try {
      // The full data comes from the gated export call — it refuses without an approval (or the
      // company's direct-download exemption), so this is not just a hidden button.
      const { rows: allRows, details } = await getPortfolioLookupExport({
        data: { accessToken: await getAccessToken(), portfolioId },
      });
      // Loaded on demand, as on Admin > Archive: the Excel writer is large.
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = "SamvadX";
      const ids = new Set(filtered.map((r) => r.debtorId));
      const byLoan = wb.addWorksheet("By Loan ID");
      byLoan.addRow([...LOAN_EXPORT_HEADERS]).font = { bold: true };
      byLoan.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
      for (const r of allRows) {
        if (ids.has(r.debtorId)) byLoan.addRow(loanExportRow(r, serviceLabel));
      }
      // Then one sheet per service with every field ProfileX returned as its own column.
      const sheets = buildServiceSheets(
        details.filter((d) => ids.has(d.debtorId)),
        serviceLabel,
      );
      for (const sh of sheets) {
        const ws = wb.addWorksheet(sh.name);
        ws.addRow(sh.columns).font = { bold: true };
        ws.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
        for (const r of sh.rows) ws.addRow(r);
      }
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(
        new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `insights-${portfolio.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-by-loan-id.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      if (exportState && !exportState.direct && exportState.request) {
        const r = exportState.request;
        setExportState({ ...exportState, request: { ...r, downloadCount: r.downloadCount + 1 } });
      }
    } catch (e) {
      toast.error(errorText(e, "Download failed"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card/50 p-3">
        <div className="space-y-1 min-w-0 w-full sm:w-auto">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Portfolio
          </div>
          <Select value={portfolioId ?? undefined} onValueChange={setPortfolioId}>
            <SelectTrigger className="h-8 w-full sm:w-80 text-xs">
              <SelectValue placeholder="Choose a portfolio" />
            </SelectTrigger>
            <SelectContent>
              {portfolios.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {[p.name, p.lender].filter(Boolean).join(" · ")}
                  {p.closed ? " (closed)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Show</div>
          <Select value={focus} onValueChange={(v) => setFocus(v as Focus)}>
            <SelectTrigger className="h-8 w-full sm:w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="text-xs">
                All accounts looked up
              </SelectItem>
              {FOCUS.map((f) => (
                <SelectItem key={f.value} value={f.value} className="text-xs">
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 min-w-0 flex-1 sm:flex-none">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Account</div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Loan ID, name, any number"
              className="h-8 pl-7 text-xs w-full sm:w-56"
            />
          </div>
        </div>
      </div>

      {!portfolioId && !error && (
        <div className="rounded-lg border border-border bg-card/40 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            Choose a portfolio to see the Insights data saved against each Loan ID.
          </p>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {loading && <p className="text-xs text-muted-foreground py-6">Loading lookup data…</p>}

      {portfolioId && !loading && !error && (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
            <Stat
              icon={Search}
              label="Accounts looked up"
              value={String(stats.accounts)}
              sub={`${stats.lookups} lookups`}
            />
            <Stat
              icon={PhoneCall}
              label="New numbers"
              value={String(stats.numbers)}
              sub={`on ${stats.withNumbers} accounts`}
            />
            <Stat
              icon={Briefcase}
              label="Employer found"
              value={String(stats.withEmployer)}
              sub={`${stats.employerDiffers} differ from bank file`}
            />
            <Stat
              icon={MapPin}
              label="Addresses found"
              value={String(stats.withAddress)}
              sub={`${stats.cityDiffers} in a different city`}
            />
            <Stat
              icon={IndianRupee}
              label="Spend"
              value={inr(stats.spend)}
              sub={`${stats.withIdentity} with PAN/UAN/DOB · ${stats.nameDiffers} name differs`}
            />
          </div>

          {rows.length > 0 && exportState && (
            <ExportPanel
              state={exportState}
              note={requestNote}
              onNote={setRequestNote}
              onRequest={sendRequest}
              requesting={requesting}
            />
          )}

          <ReportSection
            title="Lookup data by Loan ID"
            description={`${portfolio?.name ?? ""} · ${filtered.length} account${
              filtered.length === 1 ? "" : "s"
            } · every lookup ever run${
              filtered.length > ROWS_SHOWN ? ` · showing ${ROWS_SHOWN}, download has all` : ""
            }`}
            icon={IdCard}
            action={
              filtered.length > 0 && exportState?.canDownload ? (
                <button
                  type="button"
                  onClick={exportXlsx}
                  disabled={exporting}
                  className="inline-flex items-center gap-1.5 h-7 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {exporting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileDown className="h-3.5 w-3.5" />
                  )}
                  Download Excel
                </button>
              ) : undefined
            }
          >
            <DataTable
              rows={filtered.slice(0, ROWS_SHOWN)}
              keyOf={(r) => r.debtorId}
              empty="No lookups on this portfolio yet."
              maxHeight="max-h-[640px]"
              columns={[
                {
                  key: "loan",
                  header: "Loan ID",
                  render: (r) => (
                    <div className="min-w-[150px]">
                      <div className="font-mono text-foreground">{r.loanReference || "—"}</div>
                      <div className="text-[10px] text-muted-foreground">{r.name}</div>
                    </div>
                  ),
                },
                {
                  key: "bank",
                  header: "Bank file",
                  render: (r) => (
                    <div className="min-w-[170px] text-[11px] space-y-0.5">
                      <div className="font-mono">{r.phonePrimary}</div>
                      {r.bank.employer && (
                        <div className="text-muted-foreground">{r.bank.employer}</div>
                      )}
                      {r.bank.address && (
                        <div
                          className="text-muted-foreground truncate max-w-[220px]"
                          title={r.bank.address}
                        >
                          {r.bank.address}
                        </div>
                      )}
                      {r.bank.dob && <div className="text-muted-foreground">DOB {r.bank.dob}</div>}
                    </div>
                  ),
                },
                {
                  key: "numbers",
                  header: "Numbers / email",
                  render: (r) => (
                    <div className="min-w-[140px] text-[11px] space-y-0.5">
                      {r.newNumbers.length ? (
                        r.newNumbers.map((n) => (
                          <div key={n} className="font-mono text-foreground">
                            {n}
                          </div>
                        ))
                      ) : (
                        <div className="text-muted-foreground">No new numbers</div>
                      )}
                      {r.emails.map((e) => (
                        <div key={e} className="text-muted-foreground truncate max-w-[200px]">
                          {e}
                        </div>
                      ))}
                    </div>
                  ),
                },
                {
                  key: "identity",
                  header: "Identity / employment",
                  render: (r) => (
                    <div className="min-w-[180px] text-[11px] space-y-0.5">
                      {r.employer && (
                        <div className="text-foreground">
                          {r.employer}
                          {r.employed && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {r.employed === "Yes" ? "employed" : "left"}
                            </span>
                          )}
                        </div>
                      )}
                      {r.namesFound[0] && (
                        <div className="text-muted-foreground">{r.namesFound[0]}</div>
                      )}
                      {r.fatherName && (
                        <div className="text-muted-foreground">Father: {r.fatherName}</div>
                      )}
                      <div className="text-muted-foreground">
                        {[r.dob && `DOB ${r.dob}`, r.uan && `UAN ${r.uan}`, r.pan && `PAN ${r.pan}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      {!r.employer && !r.namesFound[0] && !r.dob && !r.uan && !r.pan && (
                        <div className="text-muted-foreground">—</div>
                      )}
                    </div>
                  ),
                },
                {
                  key: "addr",
                  header: "Addresses / UPI",
                  render: (r) => (
                    <div className="min-w-[180px] text-[11px] space-y-0.5">
                      {r.addresses.slice(0, 2).map((a) => (
                        <div key={a} className="truncate max-w-[240px]" title={a}>
                          {a}
                        </div>
                      ))}
                      {r.addresses.length > 2 && (
                        <div className="text-muted-foreground">+{r.addresses.length - 2} more</div>
                      )}
                      {r.upiIds.length > 0 && (
                        <div className="text-muted-foreground">UPI {r.upiIds.join(", ")}</div>
                      )}
                      {r.addresses.length === 0 && r.upiIds.length === 0 && (
                        <div className="text-muted-foreground">—</div>
                      )}
                    </div>
                  ),
                },
                {
                  key: "compare",
                  header: "vs bank file",
                  render: (r) => {
                    const chips = (
                      [
                        ["Name", r.compare.name],
                        ["DOB", r.compare.dob],
                        ["Employer", r.compare.employer],
                        ["Email", r.compare.email],
                        ["City", r.compare.city],
                      ] as [string, Compare][]
                    ).filter(([, v]) => v);
                    return chips.length ? (
                      <div className="flex flex-wrap gap-1 min-w-[120px] max-w-[180px]">
                        {chips.map(([l, v]) => (
                          <CompareChip key={l} label={l} value={v} />
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">Nothing to compare</span>
                    );
                  },
                },
                {
                  key: "lookups",
                  header: "Lookups",
                  render: (r) => (
                    <div className="min-w-[130px] text-[11px]">
                      <div className="flex flex-wrap gap-1">
                        {r.services.map((s) => (
                          <Badge key={s} variant="secondary" className="text-[10px] px-1 py-0">
                            {serviceLabel(s)}
                          </Badge>
                        ))}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {r.lookupsFound}/{r.lookups} with data · {inr(r.cost)} ·{" "}
                        {new Date(r.lastLookupAt).toLocaleDateString("en-IN")}
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </ReportSection>
          <p className="text-[11px] text-muted-foreground">
            "New numbers" leave out the loan's primary number. Match / Differs compares the lookup
            with the bank file's own name, DOB, employer, email and city; a blank means one side had
            nothing to compare. The Excel has a sheet per lookup type with every field ProfileX
            returned as its own column (plus the raw response); it needs SamvadX's approval unless
            your company has direct download.
          </p>
        </>
      )}
    </div>
  );
}

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/** Where this company stands on the portfolio's Excel: exempt, approved (until when), waiting,
 *  declined, or not asked yet — with the Request action where it applies. */
function ExportPanel({
  state,
  note,
  onNote,
  onRequest,
  requesting,
}: {
  state: LookupExportStatus;
  note: string;
  onNote: (s: string) => void;
  onRequest: () => void;
  requesting: boolean;
}) {
  if (state.direct) return null; // exempt company — the Download button is all it needs
  const r = state.request;
  const box = "rounded-xl border px-4 py-3 text-xs flex flex-wrap items-center gap-3";

  if (state.canDownload && r) {
    return (
      <div className={cn(box, "border-success/30 bg-success/5")}>
        <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
        <span className="text-foreground">
          Excel approved {fmtDate(r.decidedAt)} — download available until{" "}
          <strong>{fmtDate(r.expiresAt)}</strong>
          {r.downloadCount ? ` · downloaded ${r.downloadCount}×` : ""}.
        </span>
      </div>
    );
  }
  if (r?.status === "pending") {
    return (
      <div className={cn(box, "border-amber-500/30 bg-amber-500/5")}>
        <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="text-foreground">
          Excel requested {fmtDate(r.createdAt)} — waiting for SamvadX to approve. You'll get a
          notification.
        </span>
      </div>
    );
  }

  const declined = r?.status === "rejected";
  const expired = r?.status === "approved";
  return (
    <div
      className={cn(
        box,
        declined ? "border-destructive/30 bg-destructive/5" : "border-border bg-card/50",
      )}
    >
      {declined ? (
        <XCircle className="h-4 w-4 text-destructive shrink-0" />
      ) : (
        <FileDown className="h-4 w-4 text-muted-foreground shrink-0" />
      )}
      <span className="text-foreground flex-1 min-w-[220px]">
        {declined
          ? `Your last request was declined${r?.decisionNote ? `: "${r.decisionNote}"` : "."} You can ask again.`
          : expired
            ? "Your approval for this Excel has expired. Request it again to download."
            : "The Excel download (every field of every lookup on this portfolio) needs approval from SamvadX."}
      </span>
      <Input
        value={note}
        onChange={(e) => onNote(e.target.value)}
        maxLength={500}
        placeholder="Reason (optional)"
        className="h-7 text-xs w-full sm:w-56"
      />
      <button
        type="button"
        onClick={onRequest}
        disabled={requesting}
        className="inline-flex items-center gap-1.5 h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {requesting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Send className="h-3.5 w-3.5" />
        )}
        Request Excel
      </button>
    </div>
  );
}
