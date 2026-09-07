// Admin-only: each manager's prepaid Insights wallet (migrations/20260907_profilex_manager_
// wallets.sql). Replaces the old single org-wide monthly budget — a manager's lookups are now
// gated by their own balance, which only ever moves via a top-up here or a charge when they run
// a lookup (see runProfilexTrace in profilex-actions.server.ts). Never auto-resets.
import { useEffect, useState } from "react";
import { Wallet, Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import {
  getManagerWallets,
  setManagerWallet,
  type ManagerWalletRow,
} from "@/lib/profilex-actions.server";

export function ManagerWalletsCard() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ManagerWalletRow[]>([]);
  // Uncommitted edits, keyed by manager_id — a row's input shows this while being edited,
  // falling back to the loaded balance once there's nothing pending for it.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const res = await getManagerWallets({ data: { accessToken: session.access_token } });
      setRows(res.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load manager wallets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async (row: ManagerWalletRow) => {
    const raw = drafts[row.manager_id];
    const balance = raw === undefined ? row.balance : Number(raw);
    if (Number.isNaN(balance) || balance < 0) {
      toast.error("Enter a valid, non-negative amount");
      return;
    }
    setSavingId(row.manager_id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await setManagerWallet({
        data: { accessToken: session.access_token, managerId: row.manager_id, balance },
      });
      setRows((prev) =>
        prev.map((r) =>
          r.manager_id === row.manager_id
            ? { ...r, balance, updated_at: new Date().toISOString() }
            : r,
        ),
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.manager_id];
        return next;
      });
      toast.success(`${row.name}'s Insights wallet set to ₹${balance.toFixed(2)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the wallet");
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
          Each manager spends Insights lookups from their own prepaid balance — set or top it up
          here. It never resets automatically; once it hits ₹0 that manager can't run more lookups
          until you add more.
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
              const draft = drafts[row.manager_id];
              const dirty = draft !== undefined && Number(draft) !== row.balance;
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
                    {row.balance <= 0 && (
                      <Badge
                        variant="outline"
                        className="text-[10px] border-destructive/40 text-destructive"
                      >
                        Empty
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">₹</span>
                    <Input
                      type="number"
                      min={0}
                      step="0.5"
                      value={draft ?? row.balance}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [row.manager_id]: e.target.value }))
                      }
                      className="w-24 h-8 text-xs text-right"
                    />
                    <Button
                      size="sm"
                      variant={dirty ? "default" : "outline"}
                      className="h-8 gap-1 text-xs flex-shrink-0"
                      disabled={!dirty || savingId === row.manager_id}
                      onClick={() => handleSave(row)}
                    >
                      {savingId === row.manager_id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="h-3 w-3" />
                      )}
                      Save
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
