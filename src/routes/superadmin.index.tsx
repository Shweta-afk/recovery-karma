import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Loader2, ShieldCheck, Check, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import {
  getCompanies,
  approveCompany,
  rejectCompany,
  type CompanyRow,
} from "@/lib/superadmin-actions.server";

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

const STATUS_BADGE: Record<
  CompanyRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", variant: "outline" },
  approved: { label: "Approved", variant: "secondary" },
  rejected: { label: "Rejected", variant: "destructive" },
};

function SuperadminCompaniesPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CompanyRow[]>([]);
  // Deliberately never auto-suggested (e.g. slugified from the company name) — the subdomain
  // is decided by calling the company and asking what they want, not guessed by the app.
  // Left blank means "approve without a subdomain yet"; approveCompany already treats an
  // empty/omitted subdomain as "leave it unset for now".
  const [subdomainDrafts, setSubdomainDrafts] = useState<Record<string, string>>({});
  const [actingId, setActingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
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
  };

  useEffect(() => {
    load();
  }, []);

  const handleApprove = async (row: CompanyRow) => {
    setActingId(row.id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await approveCompany({
        data: {
          accessToken: session.access_token,
          clientId: row.id,
          subdomain: subdomainDrafts[row.id],
        },
      });
      toast.success(`${row.companyName} approved`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve this company");
    } finally {
      setActingId(null);
    }
  };

  const handleReject = async (row: CompanyRow) => {
    setActingId(row.id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await rejectCompany({ data: { accessToken: session.access_token, clientId: row.id } });
      toast.success(`${row.companyName} rejected`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reject this company");
    } finally {
      setActingId(null);
    }
  };

  const pending = rows.filter((r) => r.status === "pending");

  // Which company names appear more than once — see the warning rendered on each such row
  // below. Two rows can legitimately share a name (nothing in the schema stops it), and
  // picking the wrong one by name alone is exactly how a subdomain once ended up on an empty
  // duplicate "Axiotta Technologies" instead of the real company.
  const nameCounts = new Map<string, number>();
  for (const r of rows) nameCounts.set(r.companyName, (nameCounts.get(r.companyName) ?? 0) + 1);
  const duplicateNames = new Set(
    [...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );

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

      {!loading && pending.length > 0 && (
        <Card className="border-amber-400/40">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-amber-500" />
              Pending verification ({pending.length})
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Nobody at these companies can sign in until you approve or reject them. Optionally
              assign a subdomain slug while approving.
            </p>
          </CardHeader>
          <CardContent className="pt-4 space-y-2">
            {pending.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground truncate">
                    {row.companyName}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {row.adminEmails.length > 0 ? row.adminEmails.join(", ") : "No admin yet"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Created {new Date(row.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-muted-foreground">Subdomain</span>
                  <Input
                    value={subdomainDrafts[row.id] ?? ""}
                    onChange={(e) =>
                      setSubdomainDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))
                    }
                    placeholder="acme"
                    className="h-8 w-32 text-xs"
                  />
                  <span className="text-[10px] text-muted-foreground">.samvadx.com</span>
                  <Button
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    disabled={actingId === row.id}
                    onClick={() => handleApprove(row)}
                  >
                    {actingId === row.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 text-xs border-destructive/40 text-destructive hover:text-destructive"
                    disabled={actingId === row.id}
                    onClick={() => handleReject(row)}
                  >
                    <X className="h-3 w-3" />
                    Reject
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

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
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Subdomain</th>
                    <th className="py-2 pr-4 font-medium">Plan</th>
                    <th className="py-2 pr-4 font-medium text-right">Admins</th>
                    <th className="py-2 pr-4 font-medium text-right">Managers</th>
                    <th className="py-2 pr-4 font-medium text-right">Agents</th>
                    <th className="py-2 pr-4 font-medium text-right">Insights budget</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const badge = STATUS_BADGE[r.status];
                    const isDuplicateName = duplicateNames.has(r.companyName);
                    return (
                      <tr
                        key={r.id}
                        className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50"
                        onClick={() => navigate({ to: `/superadmin/companies/${r.id}` })}
                      >
                        <td className="py-2.5 pr-4 font-medium text-foreground">
                          {r.companyName}
                          {/* Two companies can share a name — this is exactly what let a
                              subdomain get set on the wrong "Axiotta Technologies" row once
                              already. Surface the id + creation date whenever a name collides
                              so that mistake can't happen silently again. */}
                          {isDuplicateName && (
                            <div className="mt-0.5 flex items-center gap-1 text-[10px] font-normal text-amber-600">
                              <AlertTriangle className="h-3 w-3" />
                              <span className="font-mono">{r.id.slice(0, 8)}</span>
                              <span className="text-muted-foreground">
                                · created {new Date(r.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-4">
                          <Badge variant={badge.variant} className="text-[10px]">
                            {badge.label}
                          </Badge>
                        </td>
                        <td className="py-2.5 pr-4 text-muted-foreground">
                          {r.subdomain ? `${r.subdomain}.samvadx.com` : "—"}
                        </td>
                        <td className="py-2.5 pr-4 capitalize text-muted-foreground">{r.plan}</td>
                        <td className="py-2.5 pr-4 text-right">{r.adminCount}</td>
                        <td className="py-2.5 pr-4 text-right">{r.managerCount}</td>
                        <td className="py-2.5 pr-4 text-right">{r.agentCount}</td>
                        <td className="py-2.5 pr-4 text-right font-medium text-foreground">
                          ₹{r.walletBalance.toFixed(2)}
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
