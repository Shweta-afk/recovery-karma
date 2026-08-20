import { useEffect, useState } from "react";
import { useTeams, type Team } from "./team-store";

// Which of a manager's teams they're currently working in — a manager can own up to
// MAX_TEAMS_PER_MANAGER (team-store.ts) and every operational page (Dashboard, Call Queue,
// Portfolio Overview, Call Audit, Portfolio Upload, Team Activity) is scoped to exactly one at
// a time, not pooled across all of them. Persisted per-manager in localStorage so logging back
// in stays in the same team; switching goes through setActiveTeam/clearActiveTeam, which
// ManagerLayout (manager.tsx) reacts to — clearing with 2+ teams re-shows the picker screen.

const KEY_PREFIX = "recoveryai_active_team::";

function storageKey(managerId: string): string {
  return `${KEY_PREFIX}${managerId}`;
}

export function getActiveTeamId(managerId: string): string | null {
  if (!managerId) return null;
  try {
    return localStorage.getItem(storageKey(managerId));
  } catch {
    return null;
  }
}

export function setActiveTeamId(managerId: string, teamId: string): void {
  if (!managerId) return;
  localStorage.setItem(storageKey(managerId), teamId);
  window.dispatchEvent(new CustomEvent("active-team-changed"));
}

export function clearActiveTeamId(managerId: string): void {
  if (!managerId) return;
  localStorage.removeItem(storageKey(managerId));
  window.dispatchEvent(new CustomEvent("active-team-changed"));
}

export interface ActiveTeamState {
  /** Every team this manager owns. */
  teams: Team[];
  /** The team currently in scope — always set when the manager has exactly one team (no
   * picker ever needed), otherwise whatever's stored, or undefined if nothing valid is stored
   * yet (ManagerLayout renders the picker screen in that case). */
  activeTeam: Team | undefined;
  setActiveTeam: (teamId: string) => void;
  /** Drops the stored selection — ManagerLayout's gate re-shows the picker on next render. */
  clearActiveTeam: () => void;
}

export function useActiveTeam(managerId: string): ActiveTeamState {
  const allTeams = useTeams();
  const teams = allTeams.filter((t) => t.managerId === managerId);

  // useTeams() already re-renders on team/roster changes; this just adds a listener for the
  // active-team selection itself changing (switch/clear), which lives outside that store.
  const [, bump] = useState(0);
  useEffect(() => {
    const reload = () => bump((n) => n + 1);
    window.addEventListener("active-team-changed", reload);
    return () => window.removeEventListener("active-team-changed", reload);
  }, []);

  const storedId = getActiveTeamId(managerId);
  const activeTeam = teams.length === 1 ? teams[0] : teams.find((t) => t.id === storedId);

  return {
    teams,
    activeTeam,
    setActiveTeam: (teamId: string) => setActiveTeamId(managerId, teamId),
    clearActiveTeam: () => clearActiveTeamId(managerId),
  };
}
