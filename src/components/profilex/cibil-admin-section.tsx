// CIBIL Reports on Admin → Insights — the only place CIBIL appears in the app. Admins have no
// debtor-profile screen, so they find the borrower here (loan ID, name or number), pull the report
// and see every report the company has pulled. Managers and agents never reach this page, and the
// server refuses them anyway (cibil-actions.server.ts).
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FileText, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getAccessToken } from "@/lib/access-token";
import {
  listCibilReports,
  searchCibilDebtors,
  type CibilDebtorHit,
  type CibilReportListRow,
} from "@/lib/cibil-actions.server";
import { CibilPanel } from "@/components/profilex/cibil-panel";

export function CibilAdminSection() {
  const [loaded, setLoaded] = useState(false);
  const [onPlan, setOnPlan] = useState(false);
  const [reports, setReports] = useState<CibilReportListRow[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<CibilDebtorHit[] | null>(null);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listCibilReports({ data: { accessToken: await getAccessToken() } });
      setOnPlan(res.onPlan);
      setReports(res.rows);
    } catch {
      setOnPlan(false);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A new pull lands in cibil_reports; refresh the list when the panel reports one.
  useEffect(() => {
    const onPulled = () => void load();
    window.addEventListener("cibil-report-pulled", onPulled);
    return () => window.removeEventListener("cibil-report-pulled", onPulled);
  }, [load]);

  if (!loaded || (!onPlan && reports.length === 0)) return null;

  const search = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      setHits(
        await searchCibilDebtors({
          data: { accessToken: await getAccessToken(), query: query.trim() },
        }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          CIBIL Reports
          <Badge variant="secondary" className="text-[10px] ml-1">
            Admins only
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Pull a borrower's credit report. Only admins can pull or see these — managers and agents
          don't see that a report was pulled.
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {onPlan && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Loan ID, borrower name or mobile number"
              className="h-9 text-sm"
              maxLength={60}
            />
            <Button
              type="submit"
              size="sm"
              className="h-9 gap-1.5"
              disabled={searching || query.trim().length < 2}
            >
              {searching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Find
            </Button>
          </form>
        )}

        {hits && (
          <div className="rounded-md border border-border divide-y divide-border max-h-64 overflow-y-auto">
            {hits.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No borrower matches that.</p>
            ) : (
              hits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    setSelected({ id: h.id, name: h.name });
                    setHits(null);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-2 hover:bg-muted/50 flex items-center justify-between gap-3",
                    selected?.id === h.id && "bg-muted/50",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-foreground truncate">
                      {h.name}
                    </span>
                    <span className="block text-[11px] text-muted-foreground truncate">
                      {h.loanReference || "No loan ID"}
                      {h.portfolio && ` · ${h.portfolio}`}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground flex-shrink-0">
                    ••••{h.phoneTail}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {selected && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">{selected.name}</p>
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:underline"
                onClick={() => setSelected(null)}
              >
                Close
              </button>
            </div>
            <CibilPanel key={selected.id} debtorId={selected.id} debtorName={selected.name} />
          </div>
        )}

        <div>
          <p className="text-xs font-medium text-foreground mb-2">Pulled reports</p>
          {reports.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No reports pulled yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Pulled</th>
                    <th className="py-2 pr-3 font-medium">Borrower</th>
                    <th className="py-2 pr-3 font-medium">Loan ID</th>
                    <th className="py-2 pr-3 font-medium text-right">Score</th>
                    <th className="py-2 pr-3 font-medium">By</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleString("en-IN")}
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          className="text-primary hover:underline text-left"
                          onClick={() => setSelected({ id: r.debtorId, name: r.debtorName })}
                        >
                          {r.debtorName || "—"}
                        </button>
                      </td>
                      <td className="py-2 pr-3">{r.loanReference || "—"}</td>
                      <td className="py-2 pr-3 text-right font-semibold">{r.score ?? "—"}</td>
                      <td className="py-2 pr-3">{r.requestedByName ?? "—"}</td>
                      <td className="py-2 text-right">
                        {r.htmlUrl && (
                          <a
                            href={r.htmlUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline inline-flex items-center gap-1"
                          >
                            Open <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
