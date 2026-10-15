// Admin-only: each manager's prepaid Insights wallet (migrations/20260907_profilex_manager_
// wallets.sql). Replaces the old single org-wide monthly budget — a manager's lookups are now
// gated by their own balance, which only ever moves via a top-up here or a charge when they run
// a lookup (see runProfilexTrace in profilex-actions.server.ts). Never auto-resets.
import { useEffect, useState } from "react";
import { Wallet, PlusCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import {
  getManagerWallets,
  getCompanyWallet,
  allocateToManager,
  type ManagerWalletRow,
} from "@/lib/profilex-actions.server";
import { errorText } from "@/lib/app-error";

/** Standalone, prominent display of this company's own Insights budget — what a superadmin
 *  allocated to this company (see profilex_company_wallets / getCompanyWallet), as opposed to
 *  any one manager's balance below. Its own admin-only RLS SELECT policy
 *  (profilex_company_wallets_select) means this number is real even before the admin has
 *  topped up a single manager. */
export function CompanyWalletCard() {
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error("Your session expired — sign in again");
        const res = await getCompanyWallet({ data: { accessToken: session.access_token } });
        setBalance(res.balance);
        setUpdatedAt(res.updatedAt ?? null);
      } catch (e) {
        toast.error(errorText(e, "Could not load your company's wallet"));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" />
          Your Insights Budget
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Funded by SamvadX from the platform's ProfileX account. Hand it out to your managers below
          — you can never allocate more than what's shown here.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="text-2xl font-semibold text-foreground">
              ₹{(balance ?? 0).toFixed(2)}
            </div>
            {updatedAt && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Last updated {new Date(updatedAt).toLocaleString()}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ManagerWalletsCard() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ManagerWalletRow[]>([]);
  const [companyBalance, setCompanyBalance] = useState<number | null>(null);
  // Uncommitted top-up amounts, keyed by manager_id — cleared once a top-up is applied.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const [walletsRes, companyRes] = await Promise.all([
        getManagerWallets({ data: { accessToken: session.access_token } }),
        getCompanyWallet({ data: { accessToken: session.access_token } }),
      ]);
      setRows(walletsRes.rows);
      setCompanyBalance(companyRes.balance);
    } catch (e) {
      toast.error(errorText(e, "Could not load manager wallets"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleTopUp = async (row: ManagerWalletRow) => {
    const raw = drafts[row.manager_id];
    const amount = Number(raw);
    if (!raw || Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount to add");
      return;
    }
    setSavingId(row.manager_id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const res = await allocateToManager({
        data: { accessToken: session.access_token, managerId: row.manager_id, amount },
      });
      setRows((prev) =>
        prev.map((r) =>
          r.manager_id === row.manager_id
            ? { ...r, balance: res.balance, updated_at: new Date().toISOString() }
            : r,
        ),
      );
      setCompanyBalance((prev) => (prev === null ? prev : prev - amount));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.manager_id];
        return next;
      });
      toast.success(`Added ₹${amount.toFixed(2)} to ${row.name}'s Insights wallet`);
    } catch (e) {
      toast.error(errorText(e, "Could not update the wallet"));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" />
          Manager Wallets
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          Each manager spends Insights lookups from their own prepaid balance — top it up here,
          drawn from your Insights Budget above. It never resets automatically; once it hits ₹0 that
          manager can't run more lookups until you add more.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No managers on this account yet.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => {
              const draft = drafts[row.manager_id] ?? "";
              const canTopUp = draft !== "" && Number(draft) > 0;
              return (
                <div
                  key={row.manager_id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">{row.name}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{row.email}</div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-muted-foreground">
                      Balance ₹{row.balance.toFixed(2)}
                    </span>
                    {row.balance <= 0 && (
                      <Badge
                        variant="outline"
                        className="text-[10px] border-destructive/40 text-destructive"
                      >
                        Empty
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">+ ₹</span>
                    <Input
                      type="number"
                      min={0}
                      step="0.5"
                      placeholder="0"
                      value={draft}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [row.manager_id]: e.target.value }))
                      }
                      className="w-24 h-8 text-xs text-right"
                    />
                    <Button
                      size="sm"
                      variant={canTopUp ? "default" : "outline"}
                      className="h-8 gap-1 text-xs flex-shrink-0"
                      disabled={!canTopUp || savingId === row.manager_id}
                      onClick={() => handleTopUp(row)}
                    >
                      {savingId === row.manager_id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <PlusCircle className="h-3 w-3" />
                      )}
                      Top up
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
