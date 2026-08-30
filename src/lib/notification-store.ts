// Persisted in-app notifications — real delivery for things like the manager "Nudge".
// Backed by Supabase's `notifications` table (recipient-scoped RLS); cached in localStorage
// for synchronous reads, same cache-first pattern as team-store.ts's roster/teams.

import { supabase, getMyAgentRow } from "./supabase";

export interface AppNotification {
  id: string;
  toAgentId: string; // recipient — matches the account email used as operational identity
  fromName: string;
  message: string;
  createdAt: string; // ISO
  read: boolean;
}

const KEY = "recoveryai_notifications_cache";

export function getNotifications(): AppNotification[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AppNotification[]) : [];
  } catch {
    return [];
  }
}

export function getAgentNotifications(agentId: string): AppNotification[] {
  return getNotifications()
    .filter((n) => n.toAgentId === agentId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Pulls this user's own notifications from Supabase (RLS already restricts SELECT to the
 * recipient) and refreshes the local cache. */
export async function refreshNotifications(): Promise<void> {
  const [{ data: rows, error }, { data: agentRows }] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, to_agent_id, from_name, message, read, created_at")
      .order("created_at", { ascending: false }),
    supabase.from("agents").select("id, email"),
  ]);
  if (error || !rows || !agentRows) return;

  const emailById = new Map(agentRows.map((a) => [a.id, a.email]));
  const notifications: AppNotification[] = rows.map((n) => ({
    id: n.id,
    toAgentId: emailById.get(n.to_agent_id ?? "") ?? "",
    fromName: n.from_name,
    message: n.message,
    createdAt: n.created_at ?? "",
    read: n.read ?? false,
  }));

  localStorage.setItem(KEY, JSON.stringify(notifications));
  window.dispatchEvent(new CustomEvent("notifications-updated"));
}

export async function saveNotification(
  n: Omit<AppNotification, "id" | "createdAt" | "read">,
): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
  const toAgentUuid = idByEmail.get(n.toAgentId);
  if (!toAgentUuid) throw new Error(`No agent account found for ${n.toAgentId}`);

  const me = await getMyAgentRow();
  const { error } = await supabase.from("notifications").insert({
    client_id: me?.client_id,
    to_agent_id: toAgentUuid,
    from_name: n.fromName,
    message: n.message,
  });
  if (error) throw error;
  await refreshNotifications();
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("id", id);
  if (error) throw error;
  await refreshNotifications();
}

export async function markAllRead(agentId: string): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
  const myUuid = idByEmail.get(agentId);
  if (!myUuid) return;
  const { error } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("to_agent_id", myUuid);
  if (error) throw error;
  await refreshNotifications();
}
