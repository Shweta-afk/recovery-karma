import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Wallet, PlusCircle, Send, Loader2, AlertTriangle, Landmark } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import {
  getMasterWallet,
  topUpMasterWallet,
  allocateToCompany,
  getCompanies,
  getActualWallet,
  topUpActualWallet,
  setActualWalletThreshold,
  type CompanyRow,
} from "@/lib/superadmin-actions.server";
import { WalletHistoryCard } from "@/components/superadmin/wallet-history-card";
import { ExcelButton } from "@/components/superadmin/usage-shared";
import { downloadXlsx } from "@/lib/xlsx-export";
import { todayIstKey } from "@/lib/date-filter";

export const Route = createFileRoute("/superadmin/wallet")({
  head: () => ({ meta: [{ title: "Insights Wallet · SamvadX Platform" }] }),
  component: SuperadminWalletPage,
});

function SuperadminWalletPage() {
  const [loading, setLoading] = useState(true);
  const [masterBalance, setMasterBalance] = useState(0);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [toppingUp, setToppingUp] = useState(false);
  const [allocDrafts, setAllocDrafts] = useState<Record<string, string>>({});
  const [allocatingId, setAllocatingId] = useState<string | null>(null);

  // The actual wallet: the true remaining balance with ProfileX/Neokred (see
  // 20260910_profilex_actual_wallet.sql). Kept in separate state from the master wallet above —
  // the two numbers are allowed to diverge, that divergence is the point.
  const [actualBalance, setActualBalance] = useState(0);
  const [actualThreshold, setActualThreshold] = useState(500);
  const [actualTopUpAmount, setActualTopUpAmount] = useState("");
  const [actualToppingUp, setActualToppingUp] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState("");
  const [savingThreshold, setSavingThreshold] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const [walletRes, companiesRes, actualRes] = await Promise.all([
        getMasterWallet({ data: { accessToken: session.access_token } }),
        getCompanies({ data: { accessToken: session.access_token } }),
        getActualWallet({ data: { accessToken: session.access_token } }),
      ]);
      setMasterBalance(walletRes.balance);
      setCompanies(companiesRes.rows);
      setActualBalance(actualRes.balance);
      setActualThreshold(actualRes.lowBalanceThreshold);
      setThresholdDraft(String(actualRes.lowBalanceThreshold));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the wallet");
    } finally {
      setLoading(false);
    }
  };

  const handleActualTopUp = async () => {
    const amount = Number(actualTopUpAmount);
    if (!actualTopUpAmount || Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    setActualToppingUp(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const res = await topUpActualWallet({
        data: { accessToken: session.access_token, amount },
      });
      setActualBalance(res.balance);
      setActualTopUpAmount("");
      toast.success(`Recorded ₹${amount.toFixed(2)} paid to ProfileX/Neokred`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Top-up failed");
    } finally {
      setActualToppingUp(false);
    }
  };

  const handleSaveThreshold = async () => {
    const threshold = Number(thresholdDraft);
    if (thresholdDraft === "" || Number.isNaN(threshold) || threshold < 0) {
      toast.error("Enter a valid alert threshold");
      return;
    }
    setSavingThreshold(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      await setActualWalletThreshold({ data: { accessToken: session.access_token, threshold } });
      setActualThreshold(threshold);
      toast.success(`Low-balance alert set at ₹${threshold.toFixed(2)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the threshold");
    } finally {
      setSavingThreshold(false);
    }
  };

  const isLow = !loading && actualBalance <= actualThreshold;

  useEffect(() => {
    load();
  }, []);

  const handleTopUp = async () => {
    const amount = Number(topUpAmount);
    if (!topUpAmount || Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    setToppingUp(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const res = await topUpMasterWallet({
        data: { accessToken: session.access_token, amount },
      });
      setMasterBalance(res.balance);
      setTopUpAmount("");
      toast.success(`Added ₹${amount.toFixed(2)} to the master Insights wallet`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Top-up failed");
    } finally {
      setToppingUp(false);
    }
  };

  const handleAllocate = async (company: CompanyRow) => {
    const raw = allocDrafts[company.id];
    const amount = Number(raw);
    if (!raw || Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount to allocate");
      return;
    }
    setAllocatingId(company.id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your session expired — sign in again");
      const res = await allocateToCompany({
        data: { accessToken: session.access_token, clientId: company.id, amount },
      });
      setCompanies((prev) =>
        prev.map((c) => (c.id === company.id ? { ...c, walletBalance: res.companyBalance } : c)),
      );
      setMasterBalance((prev) => prev - amount);
      setAllocDrafts((prev) => {
        const next = { ...prev };
        delete next[company.id];
        return next;
      });
      toast.success(`Allocated ₹${amount.toFixed(2)} to ${company.companyName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Allocation failed");
    } finally {
      setAllocatingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Insights Wallet</h1>
          <Badge variant="secondary">Superadmin</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Two separate numbers on purpose: the <strong>actual wallet</strong> is the true balance
          left with ProfileX/Neokred, debited automatically by the real price on every lookup. The{" "}
          <strong>master wallet</strong> below it is just your internal allocation pool — top it up
          with any figure and hand slices of it to companies as their Insights budget.
        </p>
      </div>

      {isLow && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive bg-destructive/10 px-4 py-3">
          <AlertTriangle className="h-5 w-5 flex-shrink-0 text-destructive mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-destructive">
              Actual ProfileX balance is low: ₹{actualBalance.toFixed(2)}
            </p>
            <p className="text-destructive/90 mt-0.5">
              This is at or below your ₹{actualThreshold.toFixed(2)} alert threshold. Recharge your
              real ProfileX/Neokred account, then record what you paid in the "Actual wallet" card
              below.
            </p>
          </div>
        </div>
      )}

      <Card className={isLow ? "border-destructive" : undefined}>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Landmark className="h-4 w-4 text-primary" />
            Actual wallet
            <Badge variant="outline" className="text-[10px] font-normal">
              real ProfileX balance
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            What's really left with ProfileX/Neokred. Only a top-up here should ever increase it —
            every billable lookup, from every company, debits it automatically at ProfileX's real
            price.
          </p>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div
                className={`text-2xl font-semibold ${isLow ? "text-destructive" : "text-foreground"}`}
              >
                ₹{actualBalance.toFixed(2)}
              </div>
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="actualTopUpAmount" className="text-xs">
                      Record a real ProfileX top-up (₹)
                    </Label>
                    <Input
                      id="actualTopUpAmount"
                      type="number"
                      min={0}
                      step="0.5"
                      value={actualTopUpAmount}
                      onChange={(e) => setActualTopUpAmount(e.target.value)}
                      className="w-48 h-9 text-sm"
                    />
                  </div>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={actualToppingUp}
                    onClick={handleActualTopUp}
                  >
                    {actualToppingUp ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <PlusCircle className="h-3.5 w-3.5" />
                    )}
                    Record top-up
                  </Button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="thresholdDraft" className="text-xs">
                      Alert me below (₹)
                    </Label>
                    <Input
                      id="thresholdDraft"
                      type="number"
                      min={0}
                      step="1"
                      value={thresholdDraft}
                      onChange={(e) => setThresholdDraft(e.target.value)}
                      className="w-32 h-9 text-sm"
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={savingThreshold}
                    onClick={handleSaveThreshold}
                  >
                    {savingThreshold ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Master wallet
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="text-2xl font-semibold text-foreground">
                ₹{masterBalance.toFixed(2)}
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="topUpAmount" className="text-xs">
                    Add funds (₹)
                  </Label>
                  <Input
                    id="topUpAmount"
                    type="number"
                    min={0}
                    step="0.5"
                    value={topUpAmount}
                    onChange={(e) => setTopUpAmount(e.target.value)}
                    className="w-40 h-9 text-sm"
                  />
                </div>
                <Button size="sm" className="gap-1.5" disabled={toppingUp} onClick={handleTopUp}>
                  {toppingUp ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PlusCircle className="h-3.5 w-3.5" />
                  )}
                  Top up
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Send className="h-4 w-4 text-primary" />
              Allocate to a company
            </CardTitle>
            <ExcelButton
              label="Download budgets"
              disabled={loading || companies.length === 0}
              onExport={() =>
                downloadXlsx(`samvadx-insights-budgets-${todayIstKey()}.xlsx`, [
                  {
                    name: "Company budgets",
                    headers: ["Company", "Status", "Insights budget (₹)"],
                    rows: companies.map((c) => [
                      c.companyName,
                      c.status,
                      +c.walletBalance.toFixed(2),
                    ]),
                  },
                ])
              }
            />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each company's admin can then top up their own managers, but never past this budget.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : companies.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No companies yet.</p>
          ) : (
            <div className="space-y-2">
              {companies.map((c) => {
                const draft = allocDrafts[c.id] ?? "";
                const canAllocate = draft !== "" && Number(draft) > 0;
                return (
                  <div
                    key={c.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground truncate">
                        {c.companyName}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        Budget: ₹{c.walletBalance.toFixed(2)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-muted-foreground">+ ₹</span>
                      <Input
                        type="number"
                        min={0}
                        step="0.5"
                        placeholder="0"
                        value={draft}
                        onChange={(e) =>
                          setAllocDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))
                        }
                        className="w-24 h-8 text-xs text-right"
                      />
                      <Button
                        size="sm"
                        variant={canAllocate ? "default" : "outline"}
                        className="h-8 gap-1 text-xs flex-shrink-0"
                        disabled={!canAllocate || allocatingId === c.id}
                        onClick={() => handleAllocate(c)}
                      >
                        {allocatingId === c.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Send className="h-3 w-3" />
                        )}
                        Allocate
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <WalletHistoryCard />
    </div>
  );
}
