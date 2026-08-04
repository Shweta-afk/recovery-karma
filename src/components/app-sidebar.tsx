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
  ShieldCheck,
  BarChart3,
  Layers,
  AudioLines,
  FolderOpen,
  Radio,
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
import type { Role } from "@/lib/auth";

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
  { title: "Channel Contribution", url: "/manager/channels", icon: Radio },
  { title: "Portfolio Overview", url: "/manager/portfolio", icon: FolderOpen },
  { title: "Portfolio Upload", url: "/manager/upload", icon: Upload },
  { title: "Call Audit", url: "/manager/audit", icon: AudioLines },
  { title: "Settings", url: "/dashboard/settings", icon: Settings },
];

const adminItems = [
  { title: "Overview", url: "/admin", icon: LayoutDashboard },
  { title: "Users", url: "/admin/users", icon: UserCog },
  { title: "Teams", url: "/admin/teams", icon: Users },
  { title: "Reports", url: "/admin/reports", icon: BarChart3 },
  { title: "Portfolio Assignment", url: "/admin/portfolio", icon: Layers },
  { title: "System Settings", url: "/admin/settings", icon: Settings },
];

export function AppSidebar({ role }: { role: Role }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isActive = (url: string) =>
    url === "/manager" || url === "/admin" ? pathname === url : pathname.startsWith(url);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        <Link to="/dashboard" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-sidebar-foreground">RecoveryAI</span>
            <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/60">
              Collections Platform
            </span>
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
      </SidebarContent>
    </Sidebar>
  );
}
