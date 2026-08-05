import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Users, Mail, PhoneCall, HandCoins, Settings2, Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import {
  useManagerTeamAgents,
  getTeamByManager,
  useTeams,
  useRoster,
  getTeams,
  saveTeam,
  type Team,
  type AgentRef,
} from "@/lib/team-store";
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
  const managerName = user?.name ?? "Manager";
  const agents = useManagerTeamAgents(managerId);
  useTeams(); // keeps getTeamByManager's cache fresh for the name lookup below
  const team = getTeamByManager(managerId);
  const [showManage, setShowManage] = useState(false);

  useEffect(() => {
    refreshDispositions();
  }, []);

  const sorted = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between animate-in fade-in slide-in-from-top-4 duration-500">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">My Team</h1>
          <p className="text-sm text-muted-foreground">
            {team ? team.name : "Roster and today's performance."}
          </p>
        </div>
        <Button className="gap-1.5 shrink-0" onClick={() => setShowManage(true)}>
          <Settings2 className="h-3.5 w-3.5" />
          {team ? "Manage Team" : "Create Team"}
        </Button>
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

      <ManageTeamDialog
        open={showManage}
        onClose={() => setShowManage(false)}
        team={team}
        managerId={managerId}
        managerName={managerName}
      />
    </div>
  );
}

// ─── Manage team dialog ──────────────────────────────────────────────────────
// Same shape as admin.teams.tsx's CreateTeamDialog, minus the manager picker — a manager can
// only ever manage their own team. RLS (20260806_managers_write_own_team.sql) enforces that
// server-side; this dialog just can't offer anything else.

function ManageTeamDialog({
  open,
  onClose,
  team,
  managerId,
  managerName,
}: {
  open: boolean;
  onClose: () => void;
  team: Team | undefined;
  managerId: string;
  managerName: string;
}) {
  const roster = useRoster();
  const AGENTS = roster.filter((r) => r.role === "agent");

  const [name, setName] = useState(team?.name ?? `${managerName}'s Team`);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(team?.agentIds ?? []),
  );
  const [agentSearch, setAgentSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset to the current team's state each time the dialog opens, not just on mount.
  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? `${managerName}'s Team`);
    setSelectedAgentIds(new Set(team?.agentIds ?? []));
    setAgentSearch("");
  }, [open, team, managerName]);

  // Agents already on someone else's team are hidden from the picker — same exclusivity the
  // admin's Create Team dialog enforces, so a manager can't accidentally double-roster
  // someone else's agent. Agents already on THIS team stay pickable (to remove them).
  const rosteredElsewhere = new Set(
    getTeams()
      .filter((t) => t.id !== team?.id)
      .flatMap((t) => t.agentIds),
  );
  const availableAgents = AGENTS.filter(
    (a) =>
      !rosteredElsewhere.has(a.id) &&
      (agentSearch === "" || a.name.toLowerCase().includes(agentSearch.toLowerCase())),
  );

  const toggleAgent = (id: string) => {
    setSelectedAgentIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Enter a team name");
      return;
    }
    setSaving(true);
    try {
      await saveTeam({
        id: team?.id ?? crypto.randomUUID(),
        name: name.trim(),
        managerId,
        managerName,
        agentIds: Array.from(selectedAgentIds),
        createdAt: team?.createdAt ?? new Date().toISOString(),
      });
      toast.success(`Team "${name.trim()}" saved with ${selectedAgentIds.size} agent(s)`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save team");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{team ? "Manage Team" : "Create Your Team"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>
              Team Name <span className="text-destructive">*</span>
            </Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>
              Agents
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({selectedAgentIds.size} selected)
              </span>
            </Label>
            <Input
              placeholder="Search agents…"
              value={agentSearch}
              onChange={(e) => setAgentSearch(e.target.value)}
              className="h-8 text-xs"
            />
            <div className="max-h-48 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {availableAgents.length === 0 && (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No available agents — everyone else is already on another team.
                </p>
              )}
              {availableAgents.map((a: AgentRef) => {
                const selected = selectedAgentIds.has(a.id);
                return (
                  <button
                    type="button"
                    key={a.id}
                    onClick={() => toggleAgent(a.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors",
                      selected && "bg-primary/5",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded border flex-shrink-0",
                        selected ? "bg-primary border-primary" : "border-border",
                      )}
                    >
                      {selected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-foreground">{a.name}</div>
                      <div className="text-[10px] text-muted-foreground">{a.email}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            {selectedAgentIds.size > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {Array.from(selectedAgentIds).map((id) => {
                  const a = roster.find((r) => r.id === id);
                  if (!a) return null;
                  return (
                    <Badge key={id} variant="secondary" className="text-[10px] gap-1">
                      {a.name}
                      <button type="button" onClick={() => toggleAgent(id)}>
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving} className="gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
