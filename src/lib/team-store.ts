import { useEffect, useState } from "react";
import { supabase, getMyAgentRow } from "./supabase";
import { useStorageSync } from "./storage-sync";

// Live roster of agents/managers — sourced from the Supabase `agents` table (RLS-scoped to
// the caller's client_id), cached in localStorage so components that render agent lists
// (team cards, assignment dropdowns) can read synchronously without threading async state
// through every consumer. Refreshed on mount by useRoster()/useManagerTeamAgents(), and
// after any agents-table mutation (invite/edit/delete — see admin.users.tsx).
export interface AgentRef {
  id: string; // account email — matches the operational identity used everywhere else
  name: string;
  email: string;
  role: "agent" | "manager";
}

const ROSTER_KEY = "recoveryai_roster_cache";

export function getRoster(): AgentRef[] {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    return raw ? (JSON.parse(raw) as AgentRef[]) : [];
  } catch {
    return [];
  }
}

export function getAgentById(id: string): AgentRef | undefined {
  return getRoster().find((a) => a.id === id);
}

export async function refreshRoster(): Promise<void> {
  const { data, error } = await supabase
    .from("agents")
    .select("email, name, role")
    .in("role", ["agent", "manager"]);
  if (error || !data) return;
  const roster: AgentRef[] = data.map((a) => ({
    id: a.email,
    name: a.name,
    email: a.email,
    role: a.role as "agent" | "manager",
  }));
  localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  window.dispatchEvent(new CustomEvent("roster-updated"));
}

/** Reads the cache immediately, then refreshes from Supabase in the background and
 * updates when new data lands (same tab, and cross-tab via storage-sync). */
export function useRoster(): AgentRef[] {
  const [roster, setRoster] = useState<AgentRef[]>(() => getRoster());
  useEffect(() => {
    const reload = () => setRoster(getRoster());
    window.addEventListener("roster-updated", reload);
    refreshRoster();
    return () => window.removeEventListener("roster-updated", reload);
  }, []);
  useStorageSync(() => setRoster(getRoster()));
  return roster;
}

export interface Team {
  id: string;
  name: string;
  managerId: string; // manager's email — matches AgentRef.id
  managerName: string;
  agentIds: string[]; // agent emails
  createdAt: string;
}

const TEAMS_KEY = "recoveryai_teams_cache";

/** Synchronous read of the cache — same cache-first pattern as getRoster(). */
export function getTeams(): Team[] {
  try {
    const raw = localStorage.getItem(TEAMS_KEY);
    return raw ? (JSON.parse(raw) as Team[]) : [];
  } catch {
    return [];
  }
}

/** Pulls teams + membership from Supabase and refreshes the local cache. */
export async function refreshTeams(): Promise<void> {
  const [{ data: teamRows }, { data: memberRows }, { data: agentRows }] = await Promise.all([
    supabase.from("teams").select("id, name, manager_id, created_at"),
    supabase.from("team_agents").select("team_id, agent_id"),
    supabase.from("agents").select("id, email, name"),
  ]);
  if (!teamRows || !memberRows || !agentRows) return;

  const byId = new Map(agentRows.map((a) => [a.id, a]));
  const teams: Team[] = teamRows.map((t) => {
    const manager = byId.get(t.manager_id);
    const agentIds = memberRows
      .filter((m) => m.team_id === t.id)
      .map((m) => byId.get(m.agent_id)?.email)
      .filter((e): e is string => !!e);
    return {
      id: t.id,
      name: t.name,
      managerId: manager?.email ?? "",
      managerName: manager?.name ?? "",
      agentIds,
      createdAt: t.created_at,
    };
  });

  localStorage.setItem(TEAMS_KEY, JSON.stringify(teams));
  window.dispatchEvent(new CustomEvent("teams-updated"));
}

/** Reads the cache immediately, then refreshes from Supabase in the background. */
export function useTeams(): Team[] {
  const [teams, setTeams] = useState<Team[]>(() => getTeams());
  useEffect(() => {
    const reload = () => setTeams(getTeams());
    window.addEventListener("teams-updated", reload);
    refreshTeams();
    return () => window.removeEventListener("teams-updated", reload);
  }, []);
  useStorageSync(() => setTeams(getTeams()));
  return teams;
}

export async function saveTeam(t: Team): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const emailToId = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
  const managerAgentId = emailToId.get(t.managerId);
  if (!managerAgentId) throw new Error(`No agent account found for manager email ${t.managerId}`);

  const me = await getMyAgentRow();

  const { error: teamErr } = await supabase.from("teams").upsert({
    id: t.id,
    client_id: me?.client_id,
    name: t.name,
    manager_id: managerAgentId,
    created_at: t.createdAt,
  });
  if (teamErr) throw teamErr;

  const { error: clearErr } = await supabase.from("team_agents").delete().eq("team_id", t.id);
  if (clearErr) throw clearErr;

  const memberIds = t.agentIds.map((email) => emailToId.get(email)).filter((x): x is string => !!x);
  if (memberIds.length) {
    const { error: membersErr } = await supabase
      .from("team_agents")
      .insert(memberIds.map((agentId) => ({ team_id: t.id, agent_id: agentId })));
    if (membersErr) throw membersErr;
  }

  await refreshTeams();
}

export async function deleteTeam(id: string): Promise<void> {
  const { error } = await supabase.from("teams").delete().eq("id", id);
  if (error) throw error;
  await refreshTeams();
}

export function getTeamByManager(managerId: string): Team | undefined {
  return getTeams().find((t) => t.managerId === managerId);
}

export function getTeamByAgent(agentId: string): Team | undefined {
  return getTeams().find((t) => t.agentIds.includes(agentId));
}

/** Agents belonging to this manager's own team — [] if they have no team yet, never "everyone". */
export function getManagerTeamAgents(managerId: string): AgentRef[] {
  const team = getTeamByManager(managerId);
  if (!team) return [];
  return team.agentIds.map(getAgentById).filter((a): a is AgentRef => !!a);
}

/** Reactive version of getManagerTeamAgents — updates when teams or the roster change,
 * including in another tab of the same browser (see storage-sync.ts). Used by manager-facing
 * pages so a manager only ever sees their own team's agents, correctly, even once multiple
 * teams/managers exist. */
export function useManagerTeamAgents(managerId: string): AgentRef[] {
  const [agents, setAgents] = useState<AgentRef[]>(() => getManagerTeamAgents(managerId));
  const reload = () => setAgents(getManagerTeamAgents(managerId));
  useEffect(() => {
    reload();
    window.addEventListener("teams-updated", reload);
    window.addEventListener("roster-updated", reload);
    refreshRoster();
    refreshTeams();
    return () => {
      window.removeEventListener("teams-updated", reload);
      window.removeEventListener("roster-updated", reload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerId]);
  useStorageSync(reload);
  return agents;
}
