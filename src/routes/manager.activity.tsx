import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Info,
  Users,
  Settings2,
  Check,
  Loader2,
  X,
  Plus,
  Trash2,
} from "lucide-react";
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
import { useActiveTeam } from "@/lib/active-team-store";
import {
  useTeamAgents,
  useRoster,
  getTeams,
  saveTeam,
  deleteTeam,
  MAX_TEAMS_PER_MANAGER,
  type Team,
  type AgentRef,
} from "@/lib/team-store";
import {
  getDispositions,
  refreshDispositions,
  calcStats,
  getTeamPtpFollowups,
  type DispositionRecord,
} from "@/lib/disposition-store";
import { escalateMissedPtpsToAdmin } from "@/lib/ptp-escalation-store";
import {
  getAgentTimeStats,
  formatDuration,
  formatClockTime,
  pctOfShift,
  type AgentTimeStats,
} from "@/lib/agent-time-stats";
import { formatINR } from "@/lib/mock-debtors";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/manager/activity")({
  head: () => ({
    meta: [
      { title: "Team Activity · SamvadX" },
      {
        name: "description",
        content:
          "Your team's roster, today's calls/PTPs/collections, login/logout, and time breakdown.",
      },
    ],
  }),
  component: TeamActivityPage,
});

// Manager/admin-only by design: login/logout times and a per-agent idle breakdown read like
// attendance monitoring, which shouldn't be visible peer-to-peer. This route lives under
// /manager (role-gated by manager.tsx's layout) rather than /dashboard — agents never see it.
//
// Merged with the old "My Team" page (roster + Manage Team) — there was never a reason for two
// separate pages, and the old Team Activity table read every agent in the org via useRoster()
// (a manager could see other managers' agents' login/logout times), while My Team correctly
// scoped per-team. This page is the single source now, scoped to whichever team is currently
// active (see active-team-store.ts) — switching teams happens via the header's "Change Team",
// not from this page.

function isSameDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

type SortKey = "name" | "calls" | "collected" | "calling" | "idle" | "loggedIn";
type SortDir = "asc" | "desc";

const SEGMENTS: { key: keyof AgentTimeStats; label: string; cls: string }[] = [
  { key: "ringingSeconds", label: "Ringing", cls: "bg-blue-500" },
  { key: "callingSeconds", label: "Calling", cls: "bg-primary" },
  { key: "dispositionSeconds", label: "Disposition", cls: "bg-amber-500" },
  { key: "breakSeconds", label: "Break", cls: "bg-orange-400" },
  { key: "idleSeconds", label: "Idle", cls: "bg-muted-foreground/30" },
];

/** One stacked horizontal bar per agent — Ringing/Calling/Disposition/Break/Idle as
 * proportional segments of their logged-in day, in place of five separate numeric columns. */
function ActivityBar({ stats }: { stats: AgentTimeStats }) {
  const title = SEGMENTS.map(
    (s) =>
      `${s.label}: ${formatDuration(stats[s.key] as number)} (${pctOfShift(stats[s.key] as number, stats)}%)`,
  ).join(" · ");
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="flex h-2.5 w-32 overflow-hidden rounded-full bg-muted">
        {SEGMENTS.map((s) => {
          const pct = pctOfShift(stats[s.key] as number, stats);
          return pct > 0 ? (
            <div key={s.key} className={s.cls} style={{ width: `${pct}%` }} />
          ) : null;
        })}
      </div>
      <span className="text-[11px] text-muted-foreground whitespace-nowrap">
        {formatDuration(stats.callingSeconds)} calling
      </span>
    </div>
  );
}

function useAllDispositions(): DispositionRecord[] {
  const [disps, setDisps] = useState<DispositionRecord[]>(() => getDispositions());
  useEffect(() => {
    const reload = () => setDisps(getDispositions());
    window.addEventListener("dispositions-updated", reload);
    refreshDispositions().then(reload);
    return () => window.removeEventListener("dispositions-updated", reload);
  }, []);
  return disps;
}

function TeamActivityPage() {
  const { user } = useAuth();
  const managerId = user?.email ?? user?.id ?? "";
  const managerName = user?.name ?? "Manager";
  const { teams, activeTeam, setActiveTeam, clearActiveTeam } = useActiveTeam(managerId);
  const agents = useTeamAgents(activeTeam?.id);
  const [showManage, setShowManage] = useState(false);
  // Whether the open dialog is creating a new team or editing the active one — activeTeam is
  // only ever undefined here when the manager has zero teams (ManagerLayout's picker gate
  // already forces a pick whenever there are 2+), so "creating" is really "no team yet or
  // adding another".
  const [creatingTeam, setCreatingTeam] = useState(false);

  const openManageTeam = () => {
    setCreatingTeam(false);
    setShowManage(true);
  };
  const openCreateTeam = () => {
    setCreatingTeam(true);
    setShowManage(true);
  };

  const allDisps = useAllDispositions();
  const [sortKey, setSortKey] = useState<SortKey>("calling");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Missed-PTP escalation, step 2 of the chain (manager -> admin) — see
  // ptp-escalation-store.ts. Only escalates a PTP that was already sent to this manager on a
  // previous day and is still unresolved today; runs opportunistically whenever this page
  // loads, same as the agent-side step 1 on Call Queue.
  useEffect(() => {
    const agentIds = agents.map((a) => a.id);
    if (!agentIds.length) return;
    escalateMissedPtpsToAdmin(getTeamPtpFollowups(agentIds)).catch(() => {});
  }, [agents, allDisps]);

  const rows = useMemo(() => {
    const now = new Date();
    return agents.map((agent: AgentRef) => {
      const todayDisps = allDisps.filter((d) => d.agentId === agent.id && isSameDay(d.time, now));
      return {
        agent,
        stats: getAgentTimeStats(agent.id, todayDisps),
        today: calcStats(todayDisps),
      };
    });
  }, [agents, allDisps]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.agent.name.localeCompare(b.agent.name) * dir;
        case "calls":
          return (a.today.total - b.today.total) * dir;
        case "collected":
          return (a.today.paidAmount - b.today.paidAmount) * dir;
        case "calling":
          return (a.stats.callingSeconds - b.stats.callingSeconds) * dir;
        case "idle":
          return (a.stats.idleSeconds - b.stats.idleSeconds) * dir;
        case "loggedIn":
          return (a.stats.loggedInSeconds - b.stats.loggedInSeconds) * dir;
        default:
          return 0;
      }
    });
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const SortHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <button
      type="button"
      onClick={() => toggleSort(sortKeyName)}
      className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
    >
      {label}
      {sortKey === sortKeyName ? (
        sortDir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="animate-in fade-in slide-in-from-top-4 duration-500 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Team Activity</h1>
          <p className="text-sm text-muted-foreground">
            {activeTeam ? activeTeam.name : "Roster and today's performance for your team."}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground rounded-lg border border-border bg-card px-2.5 py-1.5"
            title="Calling time is real, from logged calls. Ringing, idle, disposition, break and login/logout times are estimated — real presence tracking is coming soon."
          >
            <Info className="h-3.5 w-3.5 flex-shrink-0" />
            Ringing/idle/disposition/break/login times are estimated
          </span>
          {activeTeam && (
            <Button variant="outline" className="gap-1.5 shrink-0" onClick={openManageTeam}>
              <Settings2 className="h-3.5 w-3.5" />
              Manage Team
            </Button>
          )}
          {teams.length === 0 ? (
            <Button className="gap-1.5 shrink-0" onClick={openCreateTeam}>
              <Settings2 className="h-3.5 w-3.5" />
              Create Team
            </Button>
          ) : (
            teams.length < MAX_TEAMS_PER_MANAGER && (
              <Button variant="outline" className="gap-1.5 shrink-0" onClick={openCreateTeam}>
                <Plus className="h-3.5 w-3.5" />
                Add Team
              </Button>
            )
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
        <span>Legend:</span>
        {SEGMENTS.map((s) => (
          <span key={s.key} className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${s.cls}`} />
            {s.label}
          </span>
        ))}
        <Badge variant="outline" className="ml-auto text-xs">
          {agents.length} agent{agents.length === 1 ? "" : "s"}
        </Badge>
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Users className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-foreground">No agents on your team yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              {activeTeam
                ? "Add agents to this team with Manage Team above."
                : "Create a team and add agents to see their activity here."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/20">
                    <th className="py-2 pl-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Agent" sortKeyName="name" />
                    </th>
                    <th className="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Login
                    </th>
                    <th className="py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Logout
                    </th>
                    <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Logged In" sortKeyName="loggedIn" />
                    </th>
                    <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Calls" sortKeyName="calls" />
                    </th>
                    <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      PTPs
                    </th>
                    <th className="py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Collected" sortKeyName="collected" />
                    </th>
                    <th className="py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      <SortHeader label="Activity Breakdown" sortKeyName="calling" />
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.map(({ agent, stats, today }) => (
                    <tr key={agent.id} className="hover:bg-muted/20 transition-colors">
                      <td className="py-2.5 pl-4">
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-primary/15 flex items-center justify-center text-[10px] font-semibold text-primary/80 flex-shrink-0">
                            {agent.name
                              .split(" ")
                              .map((n) => n[0])
                              .slice(0, 2)
                              .join("")
                              .toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-foreground truncate">
                              {agent.name}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {agent.email}
                              {agent.agentCode && (
                                <span className="ml-1.5 font-mono opacity-70">
                                  · {agent.agentCode}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {formatClockTime(stats.loginTime)}
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {stats.logoutTime ? (
                          formatClockTime(stats.logoutTime)
                        ) : (
                          <span className="inline-flex items-center gap-1 text-success">
                            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                            Active
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right text-xs font-medium text-foreground tabular-nums">
                        {formatDuration(stats.loggedInSeconds)}
                      </td>
                      <td className="py-2.5 text-right text-xs font-semibold text-foreground tabular-nums">
                        {today.total}
                      </td>
                      <td className="py-2.5 text-right text-xs font-medium text-blue-600 tabular-nums">
                        {today.ptps}
                      </td>
                      <td className="py-2.5 text-right text-xs font-semibold text-success tabular-nums">
                        {formatINR(today.paidAmount)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <ActivityBar stats={stats} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <ManageTeamDialog
        open={showManage}
        onClose={() => setShowManage(false)}
        team={creatingTeam ? undefined : activeTeam}
        existingTeamCount={teams.length}
        managerId={managerId}
        managerName={managerName}
        onCreated={(teamId) => setActiveTeam(teamId)}
        onDeleted={() => {
          clearActiveTeam();
          setShowManage(false);
        }}
      />
    </div>
  );
}

// ─── Manage team dialog ──────────────────────────────────────────────────────
// Same shape as admin.teams.tsx's CreateTeamDialog, minus the manager picker — a manager can
// only ever manage their own team(s). RLS (20260806_managers_write_own_team.sql) enforces that
// server-side; this dialog just can't offer anything else. Doubles as both the create-team and
// edit-team form — `team` undefined means create (saveTeam upserts on a fresh id either way),
// enforced up to MAX_TEAMS_PER_MANAGER by saveTeam() itself.

function ManageTeamDialog({
  open,
  onClose,
  team,
  existingTeamCount,
  managerId,
  managerName,
  onCreated,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  team: Team | undefined;
  existingTeamCount: number;
  managerId: string;
  managerName: string;
  /** Fired after a brand-new team is saved (team was undefined going in) so the page can
   * switch the manager's active team into it — creating a team you can't immediately see
   * would be a strange dead end. */
  onCreated: (teamId: string) => void;
  /** Fired after the team is deleted — the page clears the active-team selection, which
   * re-triggers ManagerLayout's picker gate (or the empty "Create Team" state if none are
   * left). Only ever offered when editing an existing team, not while creating one. */
  onDeleted: () => void;
}) {
  const roster = useRoster();
  const AGENTS = roster.filter((r) => r.role === "agent");

  // First team ever created for this manager defaults to a friendly name; subsequent ones are
  // left blank so a second/third/fourth team doesn't silently default to the same name.
  const defaultName = () => (existingTeamCount > 0 ? "" : `${managerName}'s Team`);

  const [name, setName] = useState(team?.name ?? defaultName());
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(team?.agentIds ?? []),
  );
  const [agentSearch, setAgentSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset to the current team's state each time the dialog opens, not just on mount.
  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? defaultName());
    setSelectedAgentIds(new Set(team?.agentIds ?? []));
    setAgentSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const id = team?.id ?? crypto.randomUUID();
      await saveTeam({
        id,
        name: name.trim(),
        managerId,
        managerName,
        agentIds: Array.from(selectedAgentIds),
        createdAt: team?.createdAt ?? new Date().toISOString(),
      });
      toast.success(`Team "${name.trim()}" saved with ${selectedAgentIds.size} agent(s)`);
      if (!team) onCreated(id);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save team");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!team) return;
    if (
      !confirm(
        `Delete "${team.name}"? This can't be undone — its agents lose access to any portfolios assigned to this team.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await deleteTeam(team.id);
      toast.success(`Team "${team.name}" removed`);
      onDeleted();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove team");
    } finally {
      setDeleting(false);
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

        <DialogFooter className="sm:justify-between">
          {team && (
            <Button
              variant="ghost"
              onClick={handleDelete}
              disabled={saving || deleting}
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive sm:mr-auto"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Delete Team
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving || deleting}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || saving || deleting}
              className="gap-1.5"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
