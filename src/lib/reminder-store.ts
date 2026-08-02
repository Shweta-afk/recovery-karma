// Agent reminder store — backs PTP / callback follow-up reminders. Backed by Supabase's
// `reminders` table, joined against debtors at read time for display fields.

import { supabase, getMyAgentRow } from "./supabase";
import { isUuid } from "./disposition-store";

export type ReminderKind = "ptp" | "callback";

export interface Reminder {
  id: string;
  agentId: string; // email
  debtorId: string;
  debtorName: string;
  phone: string;
  kind: ReminderKind;
  amount?: number;
  dueDate: string; // ISO date (yyyy-mm-dd)
  dueTime?: string; // HH:mm (callbacks)
  message: string; // agent-facing reminder text
  createdAt: string; // ISO timestamp
  notified?: boolean;
}

const KEY = "recoveryai_reminders_cache";

export function getReminders(): Reminder[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Reminder[]) : [];
  } catch {
    return [];
  }
}

export async function refreshReminders(): Promise<void> {
  const [{ data: rows, error }, { data: debtorRows }, { data: agentRows }] = await Promise.all([
    supabase
      .from("reminders")
      .select(
        "id, agent_id, debtor_id, kind, amount, due_date, due_time, message, notified, created_at",
      ),
    supabase.from("debtors").select("id, name, phone_primary"),
    supabase.from("agents").select("id, email"),
  ]);
  if (error || !rows || !debtorRows || !agentRows) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const emailById = new Map(agentRows.map((a) => [a.id, a.email]));

  const reminders: Reminder[] = rows.map((r) => {
    const debtor = debtorById.get(r.debtor_id);
    return {
      id: r.id,
      agentId: emailById.get(r.agent_id) ?? "",
      debtorId: r.debtor_id,
      debtorName: debtor?.name ?? "",
      phone: debtor?.phone_primary ?? "",
      kind: r.kind as ReminderKind,
      amount: r.amount != null ? Number(r.amount) : undefined,
      dueDate: r.due_date,
      dueTime: r.due_time ?? undefined,
      message: r.message ?? "",
      createdAt: r.created_at,
      notified: r.notified,
    };
  });

  localStorage.setItem(KEY, JSON.stringify(reminders));
  window.dispatchEvent(new CustomEvent("reminders-updated"));
}

export async function saveReminder(r: Reminder): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
  const agentUuid = idByEmail.get(r.agentId);
  if (!agentUuid) throw new Error(`No agent account found for ${r.agentId}`);

  const me = await getMyAgentRow();
  // reminders.debtor_id is a UUID FK. Manual Dial invents an id like
  // `manual-1785496287078` for a number with no debtor row — passed straight through, that
  // is rejected as an invalid UUID before RLS even runs (same bug already fixed for
  // call_logs; this path was missed). A reminder just needs somewhere to send the follow-up,
  // so drop the FK for an ad-hoc call rather than losing the reminder entirely.
  const { error } = await supabase.from("reminders").insert({
    id: r.id,
    client_id: me?.client_id,
    agent_id: agentUuid,
    debtor_id: isUuid(r.debtorId) ? r.debtorId : null,
    kind: r.kind,
    amount: r.amount ?? null,
    due_date: r.dueDate,
    due_time: r.dueTime ?? null,
    message: r.message,
  });
  if (error) throw error;
  await refreshReminders();
}

export function getAgentReminders(agentId: string): Reminder[] {
  return getReminders().filter((r) => r.agentId === agentId);
}

/** Reminders for this agent that are due on/before `todayISO` and not yet shown. */
export function getDueReminders(agentId: string, todayISO: string): Reminder[] {
  return getReminders().filter(
    (r) => r.agentId === agentId && !r.notified && r.dueDate && r.dueDate <= todayISO,
  );
}

export async function markReminderNotified(id: string): Promise<void> {
  const { error } = await supabase.from("reminders").update({ notified: true }).eq("id", id);
  if (error) throw error;
  await refreshReminders();
}
