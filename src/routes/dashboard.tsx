import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { CallSessionProvider } from "@/lib/call-session";
import { GlobalCallBar } from "@/components/global-call-bar";
import { ManualDialDock } from "@/components/manual-dial-dock";
import { IncomingCallPopup } from "@/components/incoming-call-popup";
import { BrowserPhone } from "@/components/telephony/browser-phone";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && user?.role === "auditor") navigate({ to: "/auditor" });
  }, [user, loading, navigate]);
  if (user?.role === "auditor") return <AppShell>{null}</AppShell>;

  return (
    <CallSessionProvider>
      <AppShell>
        <Outlet />
      </AppShell>
      <GlobalCallBar />
      <IncomingCallPopup />
      {/* Always-available manual dialer, bottom-left — see manual-dial-dock.tsx. */}
      <ManualDialDock />
      <BrowserPhone />
    </CallSessionProvider>
  );
}
