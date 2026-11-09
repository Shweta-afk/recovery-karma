import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppShell } from "@/components/app-shell";
import { homeRouteForRole, useAuth } from "@/lib/auth";

export const Route = createFileRoute("/auditor")({
  component: AuditorLayout,
});

// No dialer here on purpose: an auditor listens and reviews, and never calls anyone. Admins may
// look in (read-only); the server enforces that, this only keeps other roles off the pages.
function AuditorLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const allowed = user?.role === "auditor" || user?.role === "admin";

  useEffect(() => {
    if (!loading && user && !allowed) navigate({ to: homeRouteForRole(user.role) });
  }, [user, loading, allowed, navigate]);

  if (loading || !user || !allowed) return <AppShell>{null}</AppShell>;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
