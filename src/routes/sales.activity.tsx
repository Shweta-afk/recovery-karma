import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { History, Loader2 } from "lucide-react";
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
import { getAccessToken } from "@/lib/access-token";
import { useAuth, homeRouteForRole } from "@/lib/auth";
import {
  listSalesActivity,
  listSalesTeam,
  type SalesActivityLogRow,
  type SalesPerson,
} from "@/lib/sales.server";
import { fmtDateTime } from "@/lib/sales/sales-store";

export const Route = createFileRoute("/sales/activity")({
  head: () => ({ meta: [{ title: "Sales Activity · SamvadX" }] }),
  component: SalesActivityPage,
});

const ACTION_LABEL: Record<string, string> = {
  lead_created: "Lead created",
  lead_updated: "Lead changed",
  lead_stage: "Stage changed",
  lead_assigned: "Assigned",
  lead_email: "Email sent",
  lead_import: "Import",
  lead_deleted: "Lead deleted",
  sales_user_created: "Added salesperson",
  sales_user_active: "Reactivated salesperson",
  sales_user_inactive: "Deactivated salesperson",
};

function SalesActivityPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [actor, setActor] = useState<string>("all");
  const [people, setPeople] = useState<SalesPerson[]>([]);
  const [rows, setRows] = useState<SalesActivityLogRow[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    if (!loading && user && user.role !== "superadmin") {
      navigate({ to: homeRouteForRole(user.role) });
    }
  }, [user, loading, navigate]);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const token = await getAccessToken();
      const [team, feed] = await Promise.all([
        listSalesTeam({ data: { accessToken: token } }),
        listSalesActivity({
          data: {
            accessToken: token,
            actorId: actor === "all" ? null : actor,
            limit: 200,
          },
        }),
      ]);
      setPeople(team.people);
      setRows(feed.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [actor]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byActor = useMemo(() => new Map(people.map((p) => [p.id, p.name] as const)), [people]);

  if (loading || !user || user.role !== "superadmin") return null;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sales Activity</h1>
          <p className="text-xs text-muted-foreground">
            What everyone in the sales team has done. Latest 200 events.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={actor} onValueChange={setActor}>
            <SelectTrigger className="h-8 w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">Everyone</SelectItem>
              {people.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4" /> Events
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Detail</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {busy ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    No activity yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="hover:bg-accent/30">
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{fmtDateTime(r.created_at)}</td>
                    <td className="px-3 py-2 text-foreground">
                      {r.sales_user_id
                        ? byActor.get(r.sales_user_id) ?? r.actor_name ?? "—"
                        : r.actor_name ?? "Superadmin"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className="text-[11px]">
                        {ACTION_LABEL[r.action] ?? r.action}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-foreground/90">{r.summary}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {r.lead_id && (
                        <Link
                          to="/sales/leads/$id"
                          params={{ id: r.lead_id }}
                          className="text-primary hover:underline"
                        >
                          Open
                        </Link>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={reload}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
