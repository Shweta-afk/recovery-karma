import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  Users,
  Plus,
  Trash2,
  Pencil,
  UserCheck,
  Crown,
  X,
  Check,
  ChevronDown,
  Building2,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useTeams,
  getTeams,
  saveTeam,
  deleteTeam,
  getAgentById,
  useRoster,
  type Team,
  type AgentRef,
} from "@/lib/team-store";
import { getVisiblePortfolioMeta, refreshVisiblePortfolioMeta } from "@/lib/scoped-debtors";

export const Route = createFileRoute("/admin/teams")({
  head: () => ({ meta: [{ title: "Teams · SamvadX Admin" }] }),
  component: AdminTeamsPage,
});

function AdminTeamsPage() {
  const teams = useTeams();
  const [showCreate, setShowCreate] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const roster = useRoster();
  const agentCount = roster.filter((r) => r.role === "agent").length;

  // Only each team's portfolio count is shown, so the portfolio list is enough — this used to
  // run the full debtor sync (growth plan #3). The tick re-renders the cards once it lands.
  const [, setPortfolioTick] = useState(0);
  useEffect(() => {
    const bump = () => setPortfolioTick((t) => t + 1);
    window.addEventListener("visible-portfolio-meta-updated", bump);
    void refreshVisiblePortfolioMeta();
    return () => window.removeEventListener("visible-portfolio-meta-updated", bump);
  }, []);

  const handleDelete = async (id: string, name: string) => {
    setDeletingId(id);
    try {
      await deleteTeam(id);
      toast.success(`Team "${name}" removed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove team");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between animate-in fade-in slide-in-from-top-4 duration-500">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Teams</h1>
          <p className="text-sm text-muted-foreground">
            Create teams, assign a manager, and add agents. Managers distribute portfolio work
            within their team.
          </p>
        </div>
        <Button className="gap-2 shrink-0" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          New Team
        </Button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Teams", value: teams.length },
          { label: "Agents Rostered", value: new Set(teams.flatMap((t) => t.agentIds)).size },
          {
            label: "Available Agents",
            value: agentCount - new Set(teams.flatMap((t) => t.agentIds)).size,
          },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-4">
              <div className="text-2xl font-bold text-foreground">{value}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Team cards */}
      {teams.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <Building2 className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-foreground">No teams yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create a team to assign a manager and roster agents.
            </p>
            <Button className="mt-4 gap-2" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              Create first team
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {teams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              onEdit={() => setEditingTeam(team)}
              onDelete={handleDelete}
              deleting={deletingId === team.id}
            />
          ))}
        </div>
      )}

      <CreateTeamDialog open={showCreate} onClose={() => setShowCreate(false)} />
      {editingTeam && <EditTeamDialog team={editingTeam} onClose={() => setEditingTeam(null)} />}
    </div>
  );
}

function TeamCard({
  team,
  onEdit,
  onDelete,
  deleting,
}: {
  team: Team;
  onEdit: () => void;
  onDelete: (id: string, name: string) => void;
  deleting: boolean;
}) {
  const activePortfolios = getVisiblePortfolioMeta().filter((p) => p.teamId === team.id).length;
  const agentRefs = team.agentIds.map((id) => getAgentById(id)).filter(Boolean) as AgentRef[];

  return (
    <Card className="animate-in fade-in duration-300">
      <CardHeader className="border-b border-border pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-semibold text-foreground">{team.name}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Created{" "}
              {new Date(team.createdAt).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onEdit}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(team.id, team.name)}
              disabled={deleting}
              className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-3 space-y-3">
        {/* Manager */}
        <div className="flex items-center gap-2">
          <Crown className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <div className="text-xs">
            <span className="text-muted-foreground">Manager · </span>
            <span className="font-medium text-foreground">{team.managerName}</span>
          </div>
        </div>

        {/* Agents */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {agentRefs.length} Agent{agentRefs.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agentRefs.map((a) => (
              <Badge key={a.id} variant="secondary" className="text-[10px] gap-1 font-normal">
                <UserCheck className="h-2.5 w-2.5" />
                {a.name}
              </Badge>
            ))}
            {agentRefs.length === 0 && (
              <span className="text-xs text-muted-foreground italic">No agents added yet</span>
            )}
          </div>
        </div>

        {/* Portfolio assignments */}
        <div className="pt-2 border-t border-border flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Active portfolios</span>
          <span className="font-semibold text-foreground">{activePortfolios}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateTeamDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const roster = useRoster();
  const MANAGERS = roster.filter((r) => r.role === "manager");
  const AGENTS = roster.filter((r) => r.role === "agent");

  const [name, setName] = useState("");
  const [selectedManager, setSelectedManager] = useState<AgentRef | null>(null);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [managerOpen, setManagerOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const rostered = new Set(getTeams().flatMap((t) => t.agentIds));
  const availableAgents = AGENTS.filter(
    (a) =>
      !rostered.has(a.id) &&
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

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error("Enter a team name");
      return;
    }
    if (!selectedManager) {
      toast.error("Select a manager");
      return;
    }
    if (selectedAgentIds.size === 0) {
      toast.error("Add at least one agent");
      return;
    }
    const team: Team = {
      id: crypto.randomUUID(),
      name: name.trim(),
      managerId: selectedManager.id,
      managerName: selectedManager.name,
      agentIds: Array.from(selectedAgentIds),
      createdAt: new Date().toISOString(),
    };
    setSaving(true);
    try {
      await saveTeam(team);
      toast.success(`Team "${team.name}" created with ${selectedAgentIds.size} agents`);
      setName("");
      setSelectedManager(null);
      setSelectedAgentIds(new Set());
      setAgentSearch("");
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create team");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create New Team</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Team name */}
          <div className="space-y-1.5">
            <Label>
              Team Name <span className="text-destructive">*</span>
            </Label>
            <Input
              placeholder="e.g. NPA Recovery Team A"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Manager select */}
          <div className="space-y-1.5">
            <Label>
              Manager <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setManagerOpen((o) => !o)}
                className="w-full flex items-center justify-between h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {selectedManager ? (
                  <span className="font-medium">{selectedManager.name}</span>
                ) : (
                  <span className="text-muted-foreground">Select manager…</span>
                )}
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </button>
              {managerOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border border-border bg-card shadow-lg py-1">
                  {MANAGERS.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => {
                        setSelectedManager(m);
                        setManagerOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-muted/50",
                        selectedManager?.id === m.id && "bg-muted/30 font-medium",
                      )}
                    >
                      <span>{m.name}</span>
                      <span className="text-xs text-muted-foreground">{m.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Agents */}
          <div className="space-y-1.5">
            <Label>
              Agents <span className="text-destructive">*</span>
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
                  No available agents
                </p>
              )}
              {availableAgents.map((a) => {
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

            {/* Already-rostered agents also selectable (shown as "in another team") */}
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
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name || !selectedManager || selectedAgentIds.size === 0 || saving}
            className="gap-1.5"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create Team
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit team dialog ──────────────────────────────────────────────────────
// Add/remove agents (and reassign the manager) on an EXISTING team — previously the only
// options were "Create New" or delete the whole team, so changing membership meant
// recreating it from scratch and losing history.

function EditTeamDialog({ team, onClose }: { team: Team; onClose: () => void }) {
  const roster = useRoster();
  const MANAGERS = roster.filter((r) => r.role === "manager");
  const AGENTS = roster.filter((r) => r.role === "agent");

  const [name, setName] = useState(team.name);
  const [selectedManager, setSelectedManager] = useState<AgentRef | null>(
    roster.find((r) => r.id === team.managerId) ?? null,
  );
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set(team.agentIds));
  const [managerOpen, setManagerOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Agents already on a DIFFERENT team are excluded from the picker (same exclusivity rule
  // as Create Team); agents already on THIS team stay pickable so they can be removed.
  const rosteredElsewhere = new Set(
    getTeams()
      .filter((t) => t.id !== team.id)
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
    if (!selectedManager) {
      toast.error("Select a manager");
      return;
    }
    setSaving(true);
    try {
      await saveTeam({
        id: team.id,
        name: name.trim(),
        managerId: selectedManager.id,
        managerName: selectedManager.name,
        agentIds: Array.from(selectedAgentIds),
        createdAt: team.createdAt,
      });
      toast.success(`"${name.trim()}" updated with ${selectedAgentIds.size} agents`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update team");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Team</DialogTitle>
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
              Manager <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setManagerOpen((o) => !o)}
                className="w-full flex items-center justify-between h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {selectedManager ? (
                  <span className="font-medium">{selectedManager.name}</span>
                ) : (
                  <span className="text-muted-foreground">Select manager…</span>
                )}
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </button>
              {managerOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border border-border bg-card shadow-lg py-1">
                  {MANAGERS.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => {
                        setSelectedManager(m);
                        setManagerOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-muted/50",
                        selectedManager?.id === m.id && "bg-muted/30 font-medium",
                      )}
                    >
                      <span>{m.name}</span>
                      <span className="text-xs text-muted-foreground">{m.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                  No available agents
                </p>
              )}
              {availableAgents.map((a) => {
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
          <Button
            onClick={handleSave}
            disabled={!name || !selectedManager || saving}
            className="gap-1.5"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
