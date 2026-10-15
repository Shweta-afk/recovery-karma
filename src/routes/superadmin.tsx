import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { homeRouteForRole, useAuth } from "@/lib/auth";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getActualWallet } from "@/lib/superadmin-actions.server";

export const Route = createFileRoute("/superadmin")({
  component: SuperadminLayout,
});

/** Sitewide nudge so a low ProfileX/Neokred balance is visible from any superadmin page, not
 *  only the wallet page itself — the whole point of the actual wallet is catching this before a
 *  company's manager hits a dead lookup. Polled once per mount; the wallet page's own numbers
 *  are the source of truth if this and that page ever disagree momentarily. */
function ActualWalletBanner() {
  const [state, setState] = useState<{ balance: number; threshold: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) return;
        const res = await getActualWallet({ data: { accessToken: session.access_token } });
        setState({ balance: res.balance, threshold: res.lowBalanceThreshold });
      } catch {
        // Silent — a failed banner check shouldn't block the page. The wallet page itself
        // surfaces load errors via toast.
      }
    })();
  }, []);

  if (!state || state.balance > state.threshold) return null;

  return (
    <Link
      to="/superadmin/wallet"
      className="flex items-center gap-2 border-b border-destructive bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive hover:bg-destructive/15"
    >
      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
      Actual ProfileX balance is low: ₹{state.balance.toFixed(2)} (alert at ₹
      {state.threshold.toFixed(2)}). Top up your Insights wallet →
    </Link>
  );
}

function SuperadminLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user && user.role !== "superadmin") {
      navigate({ to: homeRouteForRole(user.role) });
    }
  }, [user, loading, navigate]);

  // AppShell shows "Loading…" and, once it's clear nobody is signed in, sends them to /login
  // (returning here afterwards). Returning null instead left a signed-out visitor — e.g. one
  // opening an invoice link from an email — on a blank page forever.
  if (loading || !user) return <AppShell>{null}</AppShell>;

  if (user.role !== "superadmin") {
    return (
      <AppShell>
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center p-8">
          <span className="text-4xl">🔒</span>
          <h2 className="text-lg font-semibold text-foreground">Superadmin Only</h2>
          <p className="text-sm text-muted-foreground max-w-xs">
            This section requires superadmin privileges. Redirecting you to your dashboard…
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <ActualWalletBanner />
      <Outlet />
    </AppShell>
  );
}
