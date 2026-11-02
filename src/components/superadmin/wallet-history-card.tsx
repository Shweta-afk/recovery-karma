// Every Insights wallet movement across all companies for the chosen dates — top-ups,
// allocations to companies, companies' allocations to managers, and lookup spend — with
// per-type totals and an Excel download. Lives on the superadmin Insights Wallet page.

import { useEffect, useMemo, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAccessToken } from "@/lib/access-token";
import { getWalletLedger, type WalletLedgerRow } from "@/lib/superadmin-actions.server";
import { openRangeInstants } from "@/lib/superadmin-range";
import { downloadXlsx, reportFilename } from "@/lib/xlsx-export";
import {
  ExcelButton,
  fmtMoney,
  SuperadminDateFilter,
  useSuperadminRange,
} from "@/components/superadmin/usage-shared";

const SCOPE_LABEL: Record<string, string> = {
  master_topup: "Master wallet top-up",
  master_to_company: "Allocated to company",
  company_to_manager: "Allocated to manager",
  manager_charge: "Insights lookup spend",
  admin_charge: "Admin lookup spend",
  actual_topup: "ProfileX top-up recorded",
  actual_charge: "ProfileX charge",
};
const scopeLabel = (s: string) => SCOPE_LABEL[s] ?? s;

const LIMIT = 1000;

export function WalletHistoryCard() {
  const [range, setRange] = useSuperadminRange();
  const [scope, setScope] = useState<string>("all");
  const [rows, setRows] = useState<WalletLedgerRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const accessToken = await getAccessToken();
        const { since, until } = openRangeInstants(range);
        const res = await getWalletLedger({
          data: {
            accessToken,
            limit: LIMIT,
            since,
            until,
            scope: scope === "all" ? undefined : scope,
          },
        });
        if (!cancelled) setRows(res.rows);
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Could not load wallet history");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, scope]);

  const totals = useMemo(() => {
    const m = new Map<string, { count: number; amount: number }>();
    for (const r of rows) {
      const t = m.get(r.scope) ?? { count: 0, amount: 0 };
      t.count += 1;
      t.amount += r.amount;
      m.set(r.scope, t);
    }
    return [...m.entries()];
  }, [rows]);

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <History className="h-4 w-4 text-primary" />
            Wallet history
          </CardTitle>
          <ExcelButton
            disabled={loading || rows.length === 0}
            onExport={() =>
              downloadXlsx(reportFilename("wallet-history", range), [
                {
                  name: "Wallet history",
                  headers: ["When", "Type", "Company", "Manager", "Amount (₹)", "Note"],
                  rows: rows.map((r) => [
                    new Date(r.createdAt).toLocaleString("en-IN"),
                    scopeLabel(r.scope),
                    r.companyName ?? "",
                    r.managerName ?? "",
                    +r.amount.toFixed(2),
                    r.note ?? "",
                  ]),
                },
                {
                  name: "Totals by type",
                  headers: ["Type", "Entries", "Amount (₹)"],
                  rows: totals.map(([s, t]) => [scopeLabel(s), t.count, +t.amount.toFixed(2)]),
                },
              ])
            }
          />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every top-up, allocation and lookup charge across all companies.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <SuperadminDateFilter value={range} onChange={setRange} allowAll />
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="h-8 w-52 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                All types
              </SelectItem>
              {Object.keys(SCOPE_LABEL).map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {scopeLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No wallet movements in this period.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {totals.map(([s, t]) => (
                <Badge key={s} variant="outline" className="text-[10px] font-normal">
                  {scopeLabel(s)}: {fmtMoney(t.amount)} ({t.count})
                </Badge>
              ))}
            </div>
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium">Manager</th>
                    <th className="py-2 pr-4 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString("en-IN")}
                      </td>
                      <td className="py-2 pr-4">{scopeLabel(r.scope)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{r.companyName ?? "—"}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{r.managerName ?? "—"}</td>
                      <td className="py-2 pr-4 text-right font-medium text-foreground">
                        {fmtMoney(r.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length >= LIMIT && (
              <p className="text-[11px] text-muted-foreground">
                Showing the latest {LIMIT.toLocaleString("en-IN")} entries — narrow the dates or
                type to see older ones.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
