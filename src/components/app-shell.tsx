import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Sun, Moon, Bell, Users, ChevronsUpDown } from "lucide-react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { useActiveTeam } from "@/lib/active-team-store";
import { cn } from "@/lib/utils";
import {
  getAgentNotifications,
  markAllRead,
  refreshNotifications,
  type AppNotification,
} from "@/lib/notification-store";
import { useStorageSync } from "@/lib/storage-sync";

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function NotificationBell({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>(() =>
    getAgentNotifications(agentId),
  );

  const reload = () => setNotifications(getAgentNotifications(agentId));
  useEffect(() => {
    reload();
    window.addEventListener("notifications-updated", reload);
    refreshNotifications();
    return () => window.removeEventListener("notifications-updated", reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  useStorageSync(reload);

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        className="relative"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
            {unread}
          </span>
        )}
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Notifications
              </span>
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    markAllRead(agentId).then(reload);
                  }}
                  className="text-[11px] text-primary hover:underline"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border">
              {notifications.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No notifications yet
                </p>
              ) : (
                notifications.map((n) => (
                  <div key={n.id} className={cn("px-3 py-2.5", !n.read && "bg-primary/5")}>
                    <p className="text-xs text-foreground leading-snug">{n.message}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {n.fromName} · {timeAgo(n.createdAt)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  // Always called (never behind the loading/!user return below) so hook order stays stable.
  // A no-op for agents/admins — teams only ever resolves for role "manager" (see manager.tsx).
  const { teams, activeTeam, clearActiveTeam } = useActiveTeam(user?.email ?? user?.id ?? "");

  useEffect(() => {
    if (!loading && user === null) {
      navigate({ to: "/login" });
    }
  }, [user, loading, navigate]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const handleLogout = async () => {
    await logout();
    navigate({ to: "/login" });
  };

  // A superadmin has no client_id, so companyStatus is always undefined for them — the gate
  // below only ever applies to agent/manager/admin. A missing companyStatus on an ordinary
  // user (a profile cached before this feature existed) fails OPEN rather than locking
  // everyone out on deploy day; the 2-minute profile cache TTL picks up the real value shortly.
  if (user.companyStatus && user.companyStatus !== "approved") {
    return (
      <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <span className="text-4xl">{user.companyStatus === "rejected" ? "🚫" : "⏳"}</span>
        <h2 className="text-lg font-semibold text-foreground">
          {user.companyStatus === "rejected"
            ? "This company was not approved"
            : "Awaiting verification"}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {user.companyStatus === "rejected"
            ? "SamvadX did not approve this company's signup. Contact support if you believe this is a mistake."
            : "A SamvadX superadmin needs to verify your company before you can sign in. You'll be able to get in as soon as that's done — no action needed from you right now."}
        </p>
        <Button variant="outline" size="sm" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar role={user.role} />

        {/* min-w-0 is load-bearing. A flex item defaults to min-width:auto, so this column
            refuses to shrink below the widest thing inside it — and a wide table (Call Queue,
            Debtors, Reports) then pushes the ENTIRE app sideways instead of scrolling within
            its own `overflow-auto` container. Measured on the live app: 1492px of content in a
            1440px viewport. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-border bg-card px-4">
            <div className="flex items-center gap-2">
              <SidebarTrigger />
              <div className="hidden text-sm text-muted-foreground sm:block">
                Recovery operations console
              </div>
              {user.role === "manager" && teams.length > 1 && (
                <button
                  type="button"
                  onClick={clearActiveTeam}
                  title="Switch to a different team"
                  className="hidden items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/50 sm:flex"
                >
                  <Users className="h-3 w-3 text-muted-foreground" />
                  {activeTeam?.name ?? "Choose team"}
                  <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-3 sm:flex">
                <div className="flex flex-col items-end leading-tight">
                  <span className="text-sm font-medium text-foreground">{user.name}</span>
                  <span className="text-xs text-muted-foreground">{user.email}</span>
                </div>
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <Badge variant="secondary" className="capitalize">
                  {user.role}
                </Badge>
              </div>
              <NotificationBell agentId={user.email} />
              <Button variant="outline" size="sm" onClick={toggle} title="Toggle theme">
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <Button variant="outline" size="sm" onClick={handleLogout}>
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
          </header>

          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}
