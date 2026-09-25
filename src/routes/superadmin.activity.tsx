import { createFileRoute } from "@tanstack/react-router";
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
import { supabase } from "@/lib/supabase";
import {
  getCompanies,
  getSuperadminActivity,
  type CompanyRow,
  type SuperadminActivityRow,
} from "@/lib/superadmin-actions.server";

export const Route = createFileRoute("/superadmin/activity")({
  head: () => ({ meta: [{ title: "Superadmin Activity · SamvadX Platform" }] }),
  component: SuperadminActivityPage,
});

/** Machine action tag -> a short label for the "Type" badge. Falls back to the raw tag (and,
 * for money rows, the ledger scope) so a new action/scope added later never renders blank. */
const ACTION_LABEL: Record<string, string> = {
  company_approved: "Company approved",
  company_rejected: "Company rejected",
  subdomain_set: "Subdomain set",
  seat_limits_set: "Seat limits set",
  user_role_changed: "Role changed",
  insights_services_changed: "Insights settings",
  master_topup: "Master wallet top-up",
  master_to_company: "Budget allocated",
  actual_topup: "ProfileX top-up recorded",
  actual_charge: "Actual wallet correction",
};

function ActionBadge({ row }: { row: SuperadminActivityRow }) {
  const label = ACTION_LABEL[row.action] ?? row.action;
  if (row.kind === "money") {
    return (
      <Badge variant="secondary" className="whitespace-nowrap">
        {label}
      </Badge>
    );
  }
  if (row.action === "company_rejected") {
    return (
      <Badge variant="destructive" className="whitespace-nowrap">
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="whitespace-nowrap">
      {label}
    </Badge>
  );
}

function SuperadminActivityPage() {
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [rows, setRows] = useState<SuperadminActivityRow[]>([]);

  const load = async (clientId?: string) => {
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const [companiesRes, activityRes] = await Promise.all([
        // Only needed once for the filter dropdown, but cheap enough to just re-fetch — avoids
        // a second effect/loading state for something this small.
        getCompanies({ data: { accessToken: session.access_token } }),
        getSuperadminActivity({
          data: { accessToken: session.access_token, clientId, limit: 300 },
        }),
      ]);
      setCompanies(companiesRes.rows);
      setRows(activityRes.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load superadmin activity");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(companyFilter === "all" ? undefined : companyFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyFilter]);

  const moneyTotal = useMemo(
    () =>
      rows
        .filter((r) => r.kind === "money" && r.action === "master_to_company")
        .reduce((sum, r) => sum + (r.amount ?? 0), 0),
    [rows],
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Superadmin Activity
          </h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Every action a superadmin has taken across the platform — company approvals,
          subdomains, seat limits, role changes, Insights settings, and every money movement
          (e.g. how much budget was assigned to each company). Automatic per-lookup ProfileX
          debits are left out; those live on the{" "}
          <span className="font-medium text-foreground">Insights Activity</span> page instead.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            History
            {companyFilter !== "all" && rows.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                · ₹{moneyTotal.toFixed(2)} allocated to this company
              </span>
            )}
          </CardTitle>
          <div className="pt-2">
            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger className="h-8 w-64 text-xs">
                <SelectValue placeholder="All companies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All companies</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.companyName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No superadmin activity yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">By</th>
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium">Details</th>
                    <th className="py-2 pr-4 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.kind}-${row.id}`} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4">
                        <ActionBadge row={row} />
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                        {row.actorName ?? "—"}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {row.companyName ?? "—"}
                      </td>
                      <td className="py-2 pr-4 text-foreground max-w-md">{row.summary}</td>
                      <td className="py-2 pr-4 text-right font-medium text-foreground whitespace-nowrap">
                        {row.amount !== null ? `₹${row.amount.toFixed(2)}` : "—"}
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
