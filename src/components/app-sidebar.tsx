import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  PhoneCall,
  Users,
  MessageSquare,
  History,
  CreditCard,
  FileBarChart,
  Upload,
  UserCog,
  Settings,
  BarChart3,
  Layers,
  AudioLines,
  FolderOpen,
  Timer,
  RadioTower,
  Building2,
  Wallet,
  Sparkles,
  DatabaseBackup,
  FileText,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { homeRouteForRole, type Role } from "@/lib/auth";

const agentItems = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Call Queue", url: "/dashboard/call-queue", icon: PhoneCall },
  { title: "Activity History", url: "/dashboard/history", icon: History },
  { title: "Debtors", url: "/dashboard/debtors", icon: Users },
  { title: "Messages", url: "/dashboard/messages", icon: MessageSquare },
  { title: "Payments", url: "/dashboard/payments", icon: CreditCard },
  { title: "Reports", url: "/dashboard/reports", icon: FileBarChart },
];

const managerItems = [
  { title: "Dashboard", url: "/manager", icon: BarChart3 },
  { title: "Call Queue", url: "/manager/queue", icon: PhoneCall },
  { title: "Live Calls", url: "/manager/live-calls", icon: RadioTower },
  { title: "Call History", url: "/dashboard/history", icon: History },
  { title: "Team Activity", url: "/manager/activity", icon: Timer },
  { title: "Portfolio Overview", url: "/manager/portfolio", icon: FolderOpen },
  { title: "Portfolio Upload", url: "/manager/upload", icon: Upload },
  { title: "Call Audit", url: "/manager/audit", icon: AudioLines },
  // Reuses the agent route, same as Call History above. A manager had no way to reach payments
  // at all, which meant the bank paid-file they upload themselves (Portfolio Overview ->
  // Upload Paid File) had nowhere to show up — the rows render as "Bank Reported" here.
  // Both reuse the agent routes, same as Call History. The debtors page is role-aware: a
  // manager sees their active team's whole book rather than the (empty) set assigned to them.
  { title: "Debtors", url: "/dashboard/debtors", icon: Users },
  { title: "Payments", url: "/dashboard/payments", icon: CreditCard },
  { title: "Reports", url: "/manager/reports", icon: FileBarChart },
  { title: "Settings", url: "/dashboard/settings", icon: Settings },
];

const adminItems = [
  { title: "Overview", url: "/admin", icon: LayoutDashboard },
  { title: "Live Calls", url: "/admin/live-calls", icon: RadioTower },
  { title: "Users", url: "/admin/users", icon: UserCog },
  { title: "Teams", url: "/admin/teams", icon: Users },
  { title: "Reports", url: "/admin/reports", icon: BarChart3 },
  { title: "Insights", url: "/admin/insights", icon: Sparkles },
  { title: "Archive History", url: "/admin/archive", icon: DatabaseBackup },
  { title: "Portfolio Assignment", url: "/admin/portfolio", icon: Layers },
  { title: "System Settings", url: "/admin/settings", icon: Settings },
];

const superadminItems = [
  { title: "Overview", url: "/superadmin", icon: LayoutDashboard },
  { title: "Companies", url: "/superadmin/companies", icon: Building2 },
  { title: "Insights Wallet", url: "/superadmin/wallet", icon: Wallet },
  { title: "Insights Activity", url: "/superadmin/insights", icon: Sparkles },
  { title: "Invoices", url: "/superadmin/invoices", icon: FileText },
  { title: "Superadmin Activity", url: "/superadmin/activity", icon: History },
];

export function AppSidebar({ role }: { role: Role }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isActive = (url: string) =>
    url === "/manager" || url === "/admin" || url === "/superadmin"
      ? pathname === url
      : pathname.startsWith(url);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        {/* The role's own landing page, NOT a hardcoded /dashboard - that dropped
            managers and admins onto the agent dashboard. */}
        <Link to={homeRouteForRole(role)} className="flex flex-col items-start gap-1.5">
          <div className="rounded-md px-3 py-1.5 dark:bg-white">
            <img src="/logo.png" alt="SamvadX" className="h-7 w-auto object-contain" />
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {/* Agent workspace — agents only. Managers/admins aren't individually assigned
            debtors, so these per-agent pages would just show empty/irrelevant data. */}
        {role === "agent" && (
          <SidebarGroup>
            <SidebarGroupLabel>Agent Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {agentItems.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={isActive(item.url)}>
                      <Link to={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Manager — manager only. Admins get their own Administration section below
            instead — they don't need the day-to-day call queue/audit/portfolio-upload
            operational views a manager uses. */}
        {role === "manager" && (
          <SidebarGroup>
            <SidebarGroupLabel>Manager</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {managerItems.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={isActive(item.url)}>
                      <Link to={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Admin — visible to admin only */}
        {role === "admin" && (
          <SidebarGroup>
            <SidebarGroupLabel>Administration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminItems.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={isActive(item.url)}>
                      <Link to={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Superadmin — spans every company, so it gets none of the client-scoped groups above */}
        {role === "superadmin" && (
          <SidebarGroup>
            <SidebarGroupLabel>Platform</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {superadminItems.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton asChild isActive={isActive(item.url)}>
                      <Link to={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
    </Sidebar>
  );
}
