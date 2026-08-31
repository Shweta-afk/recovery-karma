import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { homeRouteForRole, useAuth } from "@/lib/auth";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

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
      <Outlet />
    </AppShell>
  );
}
