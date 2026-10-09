import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { homeRouteForRole, useAuth } from "@/lib/auth";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileSignature } from "lucide-react";
import { getAccessToken } from "@/lib/access-token";
import { getMyPendingContractCount } from "@/lib/contracts.server";

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
      <PendingContractsBanner />
      <Outlet />
    </AppShell>
  );
}
