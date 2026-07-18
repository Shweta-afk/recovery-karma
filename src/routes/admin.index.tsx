import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Layers, Users, BarChart3, UserCog } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/admin/")({
  head: () => ({
    meta: [
      { title: "Admin · RecoveryAI" },
      {
        name: "description",
        content:
          "Administer portfolios, agent rosters and case assignment rules for your collections operation.",
      },
    ],
  }),
  component: AdminPage,
});

const tiles = [
  { title: "Users", desc: "Add, remove and manage roles for agents and managers.", icon: UserCog, action: "Manage users", url: "/admin/users" },
  { title: "Teams", desc: "Create teams, assign a manager, and add agents.", icon: Users, action: "Manage teams", url: "/admin/teams" },
  { title: "Portfolio Assignment", desc: "Assign uploaded portfolios to a manager and notify them.", icon: Layers, action: "Assign portfolios", url: "/admin/portfolio" },
  { title: "Reports", desc: "Team performance, agent rankings and call outcomes across the org.", icon: BarChart3, action: "View reports", url: "/admin/reports" },
] as const;

function AdminPage() {
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Admin panel</h1>
            <Badge variant="secondary">Restricted</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Configure your collections operation. Visible to managers and admins only.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {tiles.map((t) => (
          <Card key={t.title}>
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
                  <t.icon className="h-4 w-4" />
                </div>
                <div>
                  <CardTitle className="text-base font-semibold">{t.title}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{t.desc}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: t.url })}>
                {t.action}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Recent activity</CardTitle>
          <p className="text-sm text-muted-foreground">Admin actions will be logged here for audit.</p>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            No admin activity yet.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
