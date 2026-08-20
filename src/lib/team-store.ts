import { useEffect, useState } from "react";
import { supabase, getMyAgentRow } from "./supabase";
import { useStorageSync } from "./storage-sync";

// Live roster of agents/managers — sourced from the Supabase `agents` table (RLS-scoped to
// the caller's client_id), cached in localStorage so components that render agent lists
// (team cards, assignment dropdowns) can read synchronously without threading async state
// through every consumer. Refreshed on mount by useRoster()/useTeamAgents(), and
// after any agents-table mutation (invite/edit/delete — see admin.users.tsx).
export interface AgentRef {
  id: string; // account email — matches the operational identity used everywhere else
  name: string;
  email: string;
  role: "agent" | "manager";
  // Short auto-generated identifier (AGT-0001, MGR-0002, ...) — see
  // migrations/20260820_agent_code.sql. Preferred match key for mapping-CSV
  // "agent" cells since it's exact by construction, unlike name (spelling
  // variants, duplicate names) or email (easy to mistype/paste wrong).
  // Null only for rows inserted before that migration ran and not yet backfilled.
  agentCode: string | null;
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
    .select("email, name, role, agent_code")
    .in("role", ["agent", "manager"]);
  if (error || !data) return;
  const roster: AgentRef[] = data.map((a) => ({
    id: a.email,
    name: a.name,
    email: a.email,
    role: a.role as "agent" | "manager",
    agentCode: a.agent_code,
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

/** A manager can own more than one team (e.g. split by portfolio/vertical) — capped so the
 * team switcher on Team Activity and the picker on Portfolio Upload stay usable. Enforced in
 * saveTeam() so the cap holds regardless of whether the team is created by the manager
 * themselves or by an admin via admin.teams.tsx. */
export const MAX_TEAMS_PER_MANAGER = 4;

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
  const existingForManager = getTeams().filter(
    (team) => team.managerId === t.managerId && team.id !== t.id,
  );
  if (existingForManager.length >= MAX_TEAMS_PER_MANAGER) {
    throw new Error(
      `${t.managerName || "This manager"} already manages the maximum of ${MAX_TEAMS_PER_MANAGER} teams`,
    );
  }

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

/** Any one of this manager's teams — a manager can own up to MAX_TEAMS_PER_MANAGER teams, and
 * this just returns whichever one getTeams() happens to return first. Fine for call sites that
 * only need "a" team (e.g. a display fallback); anything that needs the manager's full team
 * list should use getTeamsByManager() instead, or active-team-store.ts's useActiveTeam() for
 * "whichever team the manager is currently working in". */
export function getTeamByManager(managerId: string): Team | undefined {
  return getTeams().find((t) => t.managerId === managerId);
}

/** Every team this manager owns, in no particular order. */
export function getTeamsByManager(managerId: string): Team[] {
  return getTeams().filter((t) => t.managerId === managerId);
}

export function getTeamByAgent(agentId: string): Team | undefined {
  return getTeams().find((t) => t.agentIds.includes(agentId));
}

/** Every admin's email in the caller's own company — RLS scopes the query to their client_id
 * same as everywhere else. Admins deliberately aren't in the roster (refreshRoster() only
 * pulls agent/manager, since My Team/Team Activity never need to list them as assignable), so
 * this is a separate one-off query rather than a filter over useRoster(). Used to fan out the
 * final step of the PTP miss-escalation chain (manager -> admin) — see ptp-escalation-store.ts. */
export async function getAdminEmails(): Promise<string[]> {
  const { data, error } = await supabase.from("agents").select("email").eq("role", "admin");
  if (error || !data) return [];
  return data.map((a) => a.email as string);
}

/** Agents on one specific team — the scoping every manager-facing page actually uses now that
 * a manager works one team at a time (see active-team-store.ts). [] if teamId is undefined
 * (e.g. no active team chosen yet) or the team has no agents. */
export function getTeamAgents(teamId: string | undefined): AgentRef[] {
  if (!teamId) return [];
  const team = getTeams().find((t) => t.id === teamId);
  if (!team) return [];
  return team.agentIds.map(getAgentById).filter((a): a is AgentRef => !!a);
}

/** Reactive version of getTeamAgents — updates when teams or the roster change, including in
 * another tab of the same browser (see storage-sync.ts) or when the active team is switched. */
export function useTeamAgents(teamId: string | undefined): AgentRef[] {
  const [agents, setAgents] = useState<AgentRef[]>(() => getTeamAgents(teamId));
  const reload = () => setAgents(getTeamAgents(teamId));
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
  }, [teamId]);
  useStorageSync(reload);
  return agents;
}
