import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Users, Mail, PhoneCall, HandCoins } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/lib/auth";
import { useManagerTeamAgents, getTeamByManager, useTeams } from "@/lib/team-store";
import { getAgentDispositions, refreshDispositions, calcStats } from "@/lib/disposition-store";
import { useStorageSync } from "@/lib/storage-sync";
import { formatINR } from "@/lib/mock-debtors";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/manager/team")({
  head: () => ({
    meta: [
      { title: "My Team · SamvadX" },
      { name: "description", content: "Roster and today's performance for your team." },
    ],
  }),
  component: ManagerTeamPage,
});

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** Re-reads dispositions on the same triggers dashboard.history.tsx does, so each row's
 * "today" stats stay live without a manual refresh. */
function useAgentTodayStats(agentId: string) {
  const compute = () => calcStats(getAgentDispositions(agentId).filter((d) => isToday(d.time)));
  const [stats, setStats] = useState(compute);
  useEffect(() => {
    const reload = () => setStats(compute());
    window.addEventListener("dispositions-updated", reload);
    return () => window.removeEventListener("dispositions-updated", reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  useStorageSync(() => setStats(compute()));
  return stats;
}

function TeamMemberRow({ agentId, name, email }: { agentId: string; name: string; email: string }) {
  const stats: ReturnType<typeof calcStats> = useAgentTodayStats(agentId);
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex items-center gap-4 px-4 py-3 hover:bg-muted/20 transition-colors">
      <div className="h-9 w-9 shrink-0 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm text-foreground truncate">{name}</div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground truncate">
          <Mail className="h-3 w-3 shrink-0" />
          {email}
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-6 text-right">
        <div>
          <div className="flex items-center justify-end gap-1 text-sm font-semibold text-foreground">
            <PhoneCall className="h-3 w-3 text-muted-foreground" />
            {stats.total}
          </div>
          <div className="text-[10px] text-muted-foreground">Calls today</div>
        </div>
        <div>
          <div className="flex items-center justify-end gap-1 text-sm font-semibold text-blue-600">
            <HandCoins className="h-3 w-3" />
            {stats.ptps}
          </div>
          <div className="text-[10px] text-muted-foreground">PTPs today</div>
        </div>
        <div className="w-20">
          <div className="text-sm font-semibold text-success">{formatINR(stats.paidAmount)}</div>
          <div className="text-[10px] text-muted-foreground">Collected</div>
        </div>
      </div>
    </div>
  );
}

function ManagerTeamPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const agents = useManagerTeamAgents(managerId);
  useTeams(); // keeps getTeamByManager's cache fresh for the name lookup below
  const team = getTeamByManager(managerId);

  useEffect(() => {
    refreshDispositions();
  }, []);

  const sorted = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents]);

  return (
    <div className="space-y-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">My Team</h1>
        <p className="text-sm text-muted-foreground">
          {team ? team.name : "Roster and today's performance."} · Adding or removing members is
          done by an admin under Admin → Teams.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {sorted.length === 0 ? (
            <div className="py-16 text-center">
              <Users className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
              <p className="text-sm font-medium text-foreground">No agents on your team yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Ask an admin to assign agents to your team under Admin → Teams.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {sorted.map((a) => (
                <TeamMemberRow key={a.id} agentId={a.id} name={a.name} email={a.email} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Badge variant="outline" className={cn("text-xs")}>
          {sorted.length} agent{sorted.length === 1 ? "" : "s"}
        </Badge>
      </div>
    </div>
  );
}
