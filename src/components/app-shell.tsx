import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, Sun, Moon, Bell } from "lucide-react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AppSidebar } from "@/components/app-sidebar";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
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

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar role={user.role} />

        <div className="flex flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-border bg-card px-4">
            <div className="flex items-center gap-2">
              <SidebarTrigger />
              <div className="hidden text-sm text-muted-foreground sm:block">
                Recovery operations console
              </div>
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
