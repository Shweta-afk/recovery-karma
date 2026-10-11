import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { homeRouteForRole, useAuth } from "@/lib/auth";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, FileSignature } from "lucide-react";
import { getAccessToken } from "@/lib/access-token";
import { getMyPendingContractCount } from "@/lib/contracts.server";
import { CONTRACTS_VISIBLE_TO_COMPANIES } from "@/lib/contracts";
import { getMyCompanyDetailsStatus } from "@/lib/company-details.server";
import { COMPANY_DETAILS_UPDATED } from "@/components/company-details-card";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

/** Shown on every admin page while a contract change is waiting for this company's acceptance —
 *  hidden on the Contracts page itself, where the changes are listed. Recounts when an
 *  acceptance is recorded (the "contracts-updated" event from admin.contracts.tsx). */
function PendingContractsBanner() {
  const [pending, setPending] = useState(0);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const accessToken = await getAccessToken();
        const res = await getMyPendingContractCount({ data: { accessToken } });
        if (!cancelled) setPending(res.pending);
      } catch {
        // Silent: a failed check must not block the admin pages. The Contracts page itself
        // reports load errors.
      }
    };
    load();
    window.addEventListener("contracts-updated", load);
    return () => {
      cancelled = true;
      window.removeEventListener("contracts-updated", load);
    };
  }, []);

  if (pending === 0 || pathname.startsWith("/admin/contracts")) return null;
  return (
    <Link
      to="/admin/contracts"
      className="flex items-center gap-2 border-b border-amber-400/50 bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-800 hover:bg-amber-500/15 dark:text-amber-300"
    >
      <FileSignature className="h-3.5 w-3.5 flex-shrink-0" />
      {pending === 1
        ? "A contract change needs your acceptance."
        : `${pending} contract changes need your acceptance.`}{" "}
      Review under Contracts →
    </Link>
  );
}

/** Red, on every admin page, and deliberately not dismissible: shown until the company's details
 *  for invoices and agreements are complete (company-details.ts). Rechecks when they are saved. */
function CompanyDetailsBanner() {
  const [missing, setMissing] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getMyCompanyDetailsStatus({
          data: { accessToken: await getAccessToken() },
        });
        if (!cancelled) setMissing(res.complete ? [] : res.missing);
      } catch {
        // Network blip: leave the last answer in place rather than flashing the banner.
      }
    };
    void load();
    window.addEventListener(COMPANY_DETAILS_UPDATED, load);
    return () => {
      cancelled = true;
      window.removeEventListener(COMPANY_DETAILS_UPDATED, load);
    };
  }, []);

  if (!missing || missing.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <p className="font-semibold">Your company details are incomplete.</p>
          <p className="text-xs">
            They are required for your invoices and agreement with SamvadX. Still needed:{" "}
            {missing.join(", ")}.
          </p>
        </div>
      </div>
      <Link
        to="/admin/settings"
        hash="company-details"
        className="inline-flex flex-shrink-0 items-center justify-center rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
      >
        Fill in company details
      </Link>
    </div>
  );
}

function AdminLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user && user.role !== "admin") {
      navigate({ to: homeRouteForRole(user.role) });
    }
  }, [user, loading, navigate]);

  if (loading || !user) return null;

  if (user.role !== "admin") {
    return (
      <AppShell>
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center p-8">
          <span className="text-4xl">🔒</span>
          <h2 className="text-lg font-semibold text-foreground">Admin Only</h2>
          <p className="text-sm text-muted-foreground max-w-xs">
            This section requires admin privileges. Redirecting you to your dashboard…
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <CompanyDetailsBanner />
      {CONTRACTS_VISIBLE_TO_COMPANIES && <PendingContractsBanner />}
      <Outlet />
    </AppShell>
  );
}
