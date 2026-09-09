import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Users, Loader2, Wallet } from "lucide-react";
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
  getCompanyUsers,
  getWalletLedger,
  updateCompanyUserRole,
  type CompanyUserRow,
  type WalletLedgerRow,
} from "@/lib/superadmin-actions.server";

type EditableRole = "agent" | "manager" | "admin";

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
  const [users, setUsers] = useState<CompanyUserRow[]>([]);
  const [ledger, setLedger] = useState<WalletLedgerRow[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
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
        setUsers(usersRes.rows);
        setLedger(ledgerRes.rows);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load this company");
      } finally {
        setLoading(false);
      }
    })();
  }, [clientId]);

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
          <Badge variant="secondary">Superadmin</Badge>
        </div>
      </div>

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
