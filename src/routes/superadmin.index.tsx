import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { getCompanies, type CompanyRow } from "@/lib/superadmin-actions.server";

export const Route = createFileRoute("/superadmin/")({
  head: () => ({
    meta: [
      { title: "Companies · SamvadX Platform" },
      {
        name: "description",
        content: "Every company on SamvadX, its users, and its ProfileX Insights budget.",
      },
    ],
  }),
  component: SuperadminCompaniesPage,
});

function SuperadminCompaniesPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CompanyRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired — sign in again");
        const res = await getCompanies({ data: { accessToken: session.access_token } });
        setRows(res.rows);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load companies");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Companies</h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Every company on the platform, its admins/managers/agents, and its ProfileX Insights
          budget.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            All companies
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No companies on the platform yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Company</th>
                    <th className="py-2 pr-4 font-medium">Plan</th>
                    <th className="py-2 pr-4 font-medium text-right">Admins</th>
                    <th className="py-2 pr-4 font-medium text-right">Managers</th>
                    <th className="py-2 pr-4 font-medium text-right">Agents</th>
                    <th className="py-2 pr-4 font-medium text-right">Insights budget</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50"
                      onClick={() => navigate({ to: `/superadmin/companies/${r.id}` })}
                    >
                      <td className="py-2.5 pr-4 font-medium text-foreground">{r.companyName}</td>
                      <td className="py-2.5 pr-4 capitalize text-muted-foreground">{r.plan}</td>
                      <td className="py-2.5 pr-4 text-right">{r.adminCount}</td>
                      <td className="py-2.5 pr-4 text-right">{r.managerCount}</td>
                      <td className="py-2.5 pr-4 text-right">{r.agentCount}</td>
                      <td className="py-2.5 pr-4 text-right font-medium text-foreground">
                        ₹{r.walletBalance.toFixed(2)}
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
