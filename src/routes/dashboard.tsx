import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { CallSessionProvider } from "@/lib/call-session";
import { GlobalCallBar } from "@/components/global-call-bar";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  return (
    <CallSessionProvider>
      <AppShell>
        <Outlet />
      </AppShell>
      <GlobalCallBar />
    </CallSessionProvider>
  );
}
