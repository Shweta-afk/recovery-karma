import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { getInsightsActivity, type InsightsActivityRow } from "@/lib/superadmin-actions.server";
import { PROFILEX_SERVICES } from "@/lib/profilex/catalogue";

export const Route = createFileRoute("/superadmin/insights")({
  head: () => ({ meta: [{ title: "Insights Activity · SamvadX Platform" }] }),
  component: SuperadminInsightsPage,
});

const serviceLabel = (id: string) => PROFILEX_SERVICES.find((s) => s.id === id)?.label ?? id;

function stateBadge(row: InsightsActivityRow) {
  if (row.state === "failed") return { label: "Failed", variant: "destructive" as const };
  if (row.state === "pending") return { label: "Pending", variant: "outline" as const };
  if (row.providerStatus === "1") return { label: "Found", variant: "default" as const };
  return { label: "Not found", variant: "secondary" as const };
}

interface CompanySummary {
  companyName: string;
  lookups: number;
  found: number;
  failed: number;
  companyCost: number;
  realCost: number;
}

function SuperadminInsightsPage() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<InsightsActivityRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired — sign in again");
        const res = await getInsightsActivity({ data: { accessToken: session.access_token } });
        setRows(res.rows);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load Insights activity");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const totalSpend = rows.reduce((sum, r) => sum + r.cost, 0);
  const totalRealCost = rows.reduce((sum, r) => sum + r.realCost, 0);
  const totalDelta = totalRealCost - totalSpend;

  const byCompany = new Map<string, CompanySummary>();
  for (const r of rows) {
    const name = r.companyName ?? "Unassigned";
    const entry = byCompany.get(name) ?? {
      companyName: name,
      lookups: 0,
      found: 0,
      failed: 0,
      companyCost: 0,
      realCost: 0,
    };
    entry.lookups += 1;
    if (r.state === "failed") entry.failed += 1;
    else if (r.providerStatus === "1") entry.found += 1;
    entry.companyCost += r.cost;
    entry.realCost += r.realCost;
    byCompany.set(name, entry);
  }
  const companySummaries = [...byCompany.values()].sort((a, b) => b.realCost - a.realCost);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Insights Activity
          </h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Every ProfileX skip-tracing lookup across every company — who ran it, on which debtor, and
          two costs side by side: what that company's own wallet was charged (its rate card) versus
          what ProfileX actually charged (their real published price). Most recent 200 shown.
        </p>
      </div>

      {!loading && companySummaries.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm font-semibold">
              Company-charged vs. actual ProfileX cost
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              A non-zero delta means that company's rate card is priced differently from what
              ProfileX really bills for the same lookups.
            </p>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium text-right">Lookups</th>
                    <th className="py-2 pr-4 font-medium text-right">Found</th>
                    <th className="py-2 pr-4 font-medium text-right">Failed</th>
                    <th className="py-2 pr-4 font-medium text-right">Company charged</th>
                    <th className="py-2 pr-4 font-medium text-right">Actual ProfileX cost</th>
                    <th className="py-2 pr-4 font-medium text-right">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {companySummaries.map((c) => {
                    const delta = c.realCost - c.companyCost;
                    return (
                      <tr key={c.companyName} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4 text-foreground font-medium">{c.companyName}</td>
                        <td className="py-2 pr-4 text-right">{c.lookups}</td>
                        <td className="py-2 pr-4 text-right">{c.found}</td>
                        <td className="py-2 pr-4 text-right">{c.failed}</td>
                        <td className="py-2 pr-4 text-right">₹{c.companyCost.toFixed(2)}</td>
                        <td className="py-2 pr-4 text-right">₹{c.realCost.toFixed(2)}</td>
                        <td
                          className={`py-2 pr-4 text-right font-medium ${
                            delta === 0
                              ? "text-muted-foreground"
                              : delta > 0
                                ? "text-destructive"
                                : "text-emerald-600"
                          }`}
                        >
                          {delta > 0 ? "+" : ""}₹{delta.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="text-left font-semibold text-foreground">
                    <td className="py-2 pr-4">Total</td>
                    <td className="py-2 pr-4 text-right">{rows.length}</td>
                    <td className="py-2 pr-4 text-right" />
                    <td className="py-2 pr-4 text-right" />
                    <td className="py-2 pr-4 text-right">₹{totalSpend.toFixed(2)}</td>
                    <td className="py-2 pr-4 text-right">₹{totalRealCost.toFixed(2)}</td>
                    <td
                      className={`py-2 pr-4 text-right ${
                        totalDelta === 0
                          ? "text-muted-foreground"
                          : totalDelta > 0
                            ? "text-destructive"
                            : "text-emerald-600"
                      }`}
                    >
                      {totalDelta > 0 ? "+" : ""}₹{totalDelta.toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Recent lookups
          </CardTitle>
          {!loading && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Total spend shown: ₹{totalSpend.toFixed(2)} across {rows.length} lookups
            </p>
          )}
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No Insights lookups yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium">Manager</th>
                    <th className="py-2 pr-4 font-medium">Service</th>
                    <th className="py-2 pr-4 font-medium">Result</th>
                    <th className="py-2 pr-4 font-medium text-right">Company charged</th>
                    <th className="py-2 pr-4 font-medium text-right">Actual ProfileX cost</th>
                    <th className="py-2 pr-4 font-medium text-right">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const badge = stateBadge(row);
                    const delta = row.realCost - row.cost;
                    return (
                      <tr key={row.id} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4 text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-foreground">{row.companyName ?? "—"}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {row.managerName ?? "—"}
                        </td>
                        <td className="py-2 pr-4">{serviceLabel(row.serviceId)}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={badge.variant} className="text-[10px]">
                            {badge.label}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4 text-right font-medium text-foreground">
                          {row.billable ? `₹${row.cost.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-2 pr-4 text-right font-medium text-foreground">
                          {row.billable ? `₹${row.realCost.toFixed(2)}` : "—"}
                        </td>
                        <td
                          className={`py-2 pr-4 text-right ${
                            !row.billable || delta === 0
                              ? "text-muted-foreground"
                              : delta > 0
                                ? "text-destructive"
                                : "text-emerald-600"
                          }`}
                        >
                          {row.billable ? `${delta > 0 ? "+" : ""}₹${delta.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
