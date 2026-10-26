// How a company's Insights budget is split between its managers — what the company admin gave
// each one, what they spent and what is left. Lives on the company page's Billing tab.

import { useEffect, useState } from "react";
import { Loader2, PieChart } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAccessToken } from "@/lib/access-token";
import { getCompanyManagerBudgets, type ManagerBudgetRow } from "@/lib/superadmin-actions.server";
import { InfoTip } from "@/components/superadmin/help";
import { ExcelButton, fmtInt, fmtMoney } from "@/components/superadmin/usage-shared";
import { downloadXlsx } from "@/lib/xlsx-export";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";

export function ManagerBudgetCard({
  clientId,
  companyName,
}: {
  clientId: string;
  companyName: string;
}) {
  const [rows, setRows] = useState<ManagerBudgetRow[]>([]);
  const [received, setReceived] = useState(0);
  const [unallocated, setUnallocated] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const accessToken = await getAccessToken();
        const res = await getCompanyManagerBudgets({ data: { accessToken, clientId } });
        if (cancelled) return;
        setRows(res.rows);
        setReceived(res.receivedFromSamvadx);
        setUnallocated(res.unallocated);
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Could not load manager budgets");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const totalAllocated = rows.reduce((s, r) => s + r.allocated, 0);
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const totalBalance = rows.reduce((s, r) => s + r.balance, 0);
  const totalLookups = rows.reduce((s, r) => s + r.lookups, 0);
  const share = (n: number) => (totalAllocated > 0 ? (n / totalAllocated) * 100 : 0);
  const used = (r: { allocated: number; spent: number }) =>
    r.allocated > 0 ? Math.min(100, (r.spent / r.allocated) * 100) : 0;

  const exportRows = () =>
    downloadXlsx(`manager-budgets-${companyName.replace(/\W+/g, "-").toLowerCase()}.xlsx`, [
      {
        name: "Budget by manager",
        headers: [
          "Manager",
          "Email",
          "Role",
          "Allocated (₹)",
          "Share of allocations (%)",
          "Spent (₹)",
          "Lookups charged",
          "Used (%)",
          "Balance now (₹)",
          "Last allocation",
          "Last spend",
        ],
        rows: rows.map((r) => [
          r.name,
          r.email,
          r.role,
          +r.allocated.toFixed(2),
          +share(r.allocated).toFixed(1),
          +r.spent.toFixed(2),
          r.lookups,
          +used(r).toFixed(1),
          +r.balance.toFixed(2),
          r.lastAllocatedAt ? new Date(r.lastAllocatedAt).toLocaleString("en-IN") : "",
          r.lastSpentAt ? new Date(r.lastSpentAt).toLocaleString("en-IN") : "",
        ]),
      },
      {
        name: "Company totals",
        headers: ["Item", "Amount (₹)"],
        rows: [
          ["Received from SamvadX", +received.toFixed(2)],
          ["Allocated to managers", +totalAllocated.toFixed(2)],
          ["Not yet allocated (company wallet)", +unallocated.toFixed(2)],
          ["Spent by managers", +totalSpent.toFixed(2)],
          ["Left in manager wallets", +totalBalance.toFixed(2)],
        ],
      },
    ]);

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <PieChart className="h-4 w-4 text-primary" />
            Budget by manager
            <InfoTip k="managerBudget" />
          </CardTitle>
          <ExcelButton disabled={loading || rows.length === 0} onExport={exportRows} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          How this company's admin has split its Insights budget between managers, and what each has
          spent. All time — not affected by the date filter.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-[11px] font-normal">
                Received from SamvadX: {fmtMoney(received)}
              </Badge>
              <Badge variant="outline" className="text-[11px] font-normal">
                Given to managers: {fmtMoney(totalAllocated)}
              </Badge>
              <Badge variant="outline" className="text-[11px] font-normal">
                Not yet given out: {fmtMoney(unallocated)}
              </Badge>
              <Badge variant="outline" className="text-[11px] font-normal">
                Spent: {fmtMoney(totalSpent)}
              </Badge>
              <Badge variant="outline" className="text-[11px] font-normal">
                Left with managers: {fmtMoney(totalBalance)}
              </Badge>
            </div>

            {rows.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                This company has no managers yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Manager</th>
                      <th className="py-2 pr-4 text-right font-medium">Allocated</th>
                      <th className="py-2 pr-4 font-medium">Share</th>
                      <th className="py-2 pr-4 text-right font-medium">Spent</th>
                      <th className="py-2 pr-4 text-right font-medium">Lookups</th>
                      <th className="py-2 pr-4 font-medium">Used</th>
                      <th className="py-2 pr-4 text-right font-medium">Balance now</th>
                      <th className="py-2 pr-4 font-medium">Last top-up</th>
                      <th className="py-2 pr-4 font-medium">Last spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.managerId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4">
                          <div className="font-medium text-foreground">{r.name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {r.email}
                            {r.role !== "manager" && ` · now ${r.role}`}
                            {!r.isActive && " · inactive"}
                          </div>
                        </td>
                        <td className="py-2 pr-4 text-right font-medium text-foreground">
                          {fmtMoney(r.allocated)}
                        </td>
                        <td className="py-2 pr-4">
                          <Bar pct={share(r.allocated)} />
                        </td>
                        <td className="py-2 pr-4 text-right">{fmtMoney(r.spent)}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">
                          {fmtInt(r.lookups)}
                        </td>
                        <td className="py-2 pr-4">
                          {r.allocated > 0 ? <Bar pct={used(r)} /> : "—"}
                        </td>
                        <td className="py-2 pr-4 text-right font-medium text-foreground">
                          {fmtMoney(r.balance)}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                          {fmtDate(r.lastAllocatedAt)}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                          {fmtDate(r.lastSpentAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border font-medium text-foreground">
                      <td className="py-2 pr-4">Total</td>
                      <td className="py-2 pr-4 text-right">{fmtMoney(totalAllocated)}</td>
                      <td className="py-2 pr-4" />
                      <td className="py-2 pr-4 text-right">{fmtMoney(totalSpent)}</td>
                      <td className="py-2 pr-4 text-right">{fmtInt(totalLookups)}</td>
                      <td className="py-2 pr-4" />
                      <td className="py-2 pr-4 text-right">{fmtMoney(totalBalance)}</td>
                      <td className="py-2 pr-4" colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground">{pct.toFixed(0)}%</span>
    </div>
  );
}
