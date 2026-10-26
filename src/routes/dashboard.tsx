import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { CallSessionProvider } from "@/lib/call-session";
import { GlobalCallBar } from "@/components/global-call-bar";
import { ManualDialDock } from "@/components/manual-dial-dock";
import { IncomingCallPopup } from "@/components/incoming-call-popup";

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
      <IncomingCallPopup />
      {/* Always-available manual dialer, bottom-left — see manual-dial-dock.tsx. */}
      <ManualDialDock />
    </CallSessionProvider>
  );
}
