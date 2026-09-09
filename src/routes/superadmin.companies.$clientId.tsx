import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Users, Loader2, Wallet, ShieldCheck, Check, X, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import {
  getCompanyUsers,
  getWalletLedger,
  updateCompanyUserRole,
  approveCompany,
  rejectCompany,
  setCompanySubdomain,
  type CompanyUserRow,
  type WalletLedgerRow,
} from "@/lib/superadmin-actions.server";
import { CompanyInsightsSettingsCard } from "@/components/profilex/company-insights-settings-card";

type EditableRole = "agent" | "manager" | "admin";
type CompanyStatus = "pending" | "approved" | "rejected";

const STATUS_BADGE: Record<
  CompanyStatus,
  { label: string; variant: "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", variant: "outline" },
  approved: { label: "Approved", variant: "secondary" },
  rejected: { label: "Rejected", variant: "destructive" },
};

export const Route = createFileRoute("/superadmin/companies/$clientId")({
  head: () => ({ meta: [{ title: "Company · SamvadX Platform" }] }),
  component: SuperadminCompanyDetailPage,
});

const SCOPE_LABEL: Record<string, string> = {
  master_topup: "Superadmin top-up",
  master_to_company: "Allocated to company",
  company_to_manager: "Allocated to manager",
  manager_charge: "Insights lookup spend",
};

function SuperadminCompanyDetailPage() {
  const { clientId } = useParams({ from: "/superadmin/companies/$clientId" });
  const [loading, setLoading] = useState(true);
  const [companyName, setCompanyName] = useState("");
  const [status, setStatus] = useState<CompanyStatus>("approved");
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const [subdomainDraft, setSubdomainDraft] = useState("");
  const [users, setUsers] = useState<CompanyUserRow[]>([]);
  const [ledger, setLedger] = useState<WalletLedgerRow[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [savingSubdomain, setSavingSubdomain] = useState(false);

  const load = async () => {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const [usersRes, ledgerRes] = await Promise.all([
        getCompanyUsers({ data: { accessToken: session.access_token, clientId } }),
        getWalletLedger({ data: { accessToken: session.access_token, clientId, limit: 100 } }),
      ]);
      setCompanyName(usersRes.companyName);
      setStatus(usersRes.status);
      setSubdomain(usersRes.subdomain);
      setSubdomainDraft(usersRes.subdomain ?? "");
      setUsers(usersRes.rows);
      setLedger(ledgerRes.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load this company");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const handleApprove = async () => {
    setVerifying(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await approveCompany({
        data: { accessToken: session.access_token, clientId, subdomain: subdomainDraft },
      });
      toast.success(`${companyName} approved`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve this company");
    } finally {
      setVerifying(false);
    }
  };

  const handleReject = async () => {
    setVerifying(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await rejectCompany({ data: { accessToken: session.access_token, clientId } });
      toast.success(`${companyName} rejected`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reject this company");
    } finally {
      setVerifying(false);
    }
  };

  const handleSaveSubdomain = async () => {
    setSavingSubdomain(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await setCompanySubdomain({
        data: { accessToken: session.access_token, clientId, subdomain: subdomainDraft },
      });
      setSubdomain(subdomainDraft.trim().toLowerCase());
      toast.success("Subdomain updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the subdomain");
    } finally {
      setSavingSubdomain(false);
    }
  };

  const handleRoleChange = async (user: CompanyUserRow, role: EditableRole) => {
    if (role === user.role) return;
    setSavingId(user.id);
    const previousRole = user.role;
    // Optimistic — reverted below if the write fails, so the dropdown doesn't silently snap
    // back with no explanation.
    setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role } : u)));
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await updateCompanyUserRole({
        data: { accessToken: session.access_token, clientId, userId: user.id, role },
      });
      toast.success(`${user.name} is now ${role === "agent" ? "an" : "a"} ${role}`);
    } catch (e) {
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: previousRole } : u)));
      toast.error(e instanceof Error ? e.message : "Could not update role");
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/superadmin"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> All companies
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{companyName}</h1>
          <Badge variant={STATUS_BADGE[status].variant}>{STATUS_BADGE[status].label}</Badge>
        </div>
      </div>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Verification &amp; subdomain
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          {status === "pending" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="gap-1.5" disabled={verifying} onClick={handleApprove}>
                {verifying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 border-destructive/40 text-destructive hover:text-destructive"
                disabled={verifying}
                onClick={handleReject}
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </Button>
            </div>
          )}
          {status === "rejected" && (
            <Button size="sm" className="gap-1.5" disabled={verifying} onClick={handleApprove}>
              {verifying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Approve anyway
            </Button>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Subdomain</span>
            <Input
              value={subdomainDraft}
              onChange={(e) => setSubdomainDraft(e.target.value)}
              placeholder="acme"
              className="h-8 w-40 text-xs"
            />
            <span className="text-[11px] text-muted-foreground">.samvadx.com</span>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              disabled={
                savingSubdomain || subdomainDraft.trim().toLowerCase() === (subdomain ?? "")
              }
              onClick={handleSaveSubdomain}
            >
              {savingSubdomain ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <CompanyInsightsSettingsCard clientId={clientId} />

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Users
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {users.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No users yet.</p>
          ) : (
            <div className="space-y-2">
              {users.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">{u.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{u.email}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!u.isActive && (
                      <Badge variant="outline" className="text-[10px]">
                        Inactive
                      </Badge>
                    )}
                    {savingId === u.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    <Select
                      value={u.role}
                      disabled={savingId === u.id}
                      onValueChange={(v) => handleRoleChange(u, v as EditableRole)}
                    >
                      <SelectTrigger className="h-7 w-28 text-[11px] capitalize">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="agent">Agent</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Wallet activity
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every allocation into and spend out of this company's Insights budget.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {ledger.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No wallet activity yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Manager</th>
                    <th className="py-2 pr-4 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((row) => (
                    <tr key={row.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4 text-muted-foreground">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4">{SCOPE_LABEL[row.scope] ?? row.scope}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{row.managerName ?? "—"}</td>
                      <td className="py-2 pr-4 text-right font-medium text-foreground">
                        ₹{row.amount.toFixed(2)}
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
