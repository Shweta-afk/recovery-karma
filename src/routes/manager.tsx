import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { TeamPickerScreen } from "@/components/team-picker-screen";
import { useAuth } from "@/lib/auth";
import { useActiveTeam } from "@/lib/active-team-store";
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/manager")({
  component: ManagerLayout,
});

function ManagerLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const managerId = user?.email ?? user?.id ?? "";
  // Admins aren't scoped to a single team (they see everything org-wide), so this hook only
  // matters — and is only called meaningfully — for role "manager"; harmless no-op otherwise
  // since managerId won't match any team's managerId for a non-manager.
  const { teams, activeTeam, setActiveTeam } = useActiveTeam(managerId);

  useEffect(() => {
    if (!loading && user && user.role === "agent") {
      navigate({ to: "/dashboard" });
    }
  }, [user, loading, navigate]);

  if (loading || !user) return null;

  if (user.role === "agent") {
    return (
      <AppShell>
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center p-8">
          <span className="text-4xl">🔒</span>
          <h2 className="text-lg font-semibold text-foreground">Access Restricted</h2>
          <p className="text-sm text-muted-foreground max-w-xs">
            This section is only available to managers and admins. Redirecting you to your
            dashboard…
          </p>
        </div>
      </AppShell>
    );
  }

  if (user.role === "manager" && teams.length > 1 && !activeTeam) {
    return (
      <AppShell>
        <TeamPickerScreen teams={teams} managerName={user.name} onPick={setActiveTeam} />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
