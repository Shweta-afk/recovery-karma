import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { homeRouteForRole, useAuth } from "@/lib/auth";

export const Route = createFileRoute("/sales")({
  component: SalesLayout,
});

// Phase 1 of the sales portal (2026-11-27). Salespeople land here; a superadmin may open it to
// manage the team and see every lead. Any other role is sent back to its own home.
function SalesLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading || !user) return;
    if (user.role !== "sales" && user.role !== "superadmin") {
      navigate({ to: homeRouteForRole(user.role) });
    }
  }, [user, loading, navigate]);

  if (loading || !user) return <AppShell>{null}</AppShell>;

  if (user.role !== "sales" && user.role !== "superadmin") {
    return (
      <AppShell>
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="text-4xl">🔒</span>
          <h2 className="text-lg font-semibold text-foreground">Sales portal</h2>
          <p className="max-w-xs text-sm text-muted-foreground">
            This section is for the SamvadX sales team. Redirecting you to your dashboard…
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
