import { supabase } from "./supabase";
import { sendSms } from "@/lib/telephony/server";
import { getAccessToken } from "@/lib/access-token";

export type MessageChannel = "whatsapp" | "sms" | "email";
export type MessageDirection = "outbound" | "inbound";
export type MessageStatus = "sent" | "delivered" | "read" | "failed" | "replied";

export interface MessageRecord {
  id: string;
  debtorId: string;
  debtorName: string;
  phone: string;
  agentName: string;
  channel: MessageChannel;
  direction: MessageDirection;
  templateName?: string;
  content: string;
  status: MessageStatus;
  paymentLinkUrl?: string;
  sentAt: string;
}

const KEY = "recoveryai_messages_cache";

export function getMessages(): MessageRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as MessageRecord[]) : [];
  } catch {
    return [];
  }
}

/** Pulls the `messages` table (joined against debtors/agents) and refreshes the cache.
 * Mirrors disposition-store.refreshDispositions(). */
export async function refreshMessages(): Promise<void> {
  const [messages, debtors, agents] = await Promise.all([
    supabase.from("messages").select("*").order("sent_at", { ascending: true }),
    supabase.from("debtors").select("id, name, phone_primary"),
    supabase.from("agents").select("id, name"),
  ]);

  const named = [
    ["messages", messages] as const,
    ["debtors", debtors] as const,
    ["agents", agents] as const,
  ];
  let failed = false;
  for (const [table, res] of named) {
    if (res.error) {
      console.error(`[messages] ${table} query failed:`, res.error.message, res.error);
      failed = true;
    }
  }
  if (failed) return;

  const { data: rows } = messages;
  const { data: debtorRows } = debtors;
  const { data: agentRows } = agents;
  if (!rows || !debtorRows || !agentRows) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  type MessageRow = {
    id: string;
    debtor_id: string | null;
    agent_id: string | null;
    channel: string;
    direction: string;
    template_name: string | null;
    content: string;
    status: string;
    payment_link_url: string | null;
    sent_at: string;
  };

  const recs: MessageRecord[] = (rows as unknown as MessageRow[]).map((r) => {
    const debtor = r.debtor_id ? debtorById.get(r.debtor_id) : undefined;
    const agent = r.agent_id ? agentById.get(r.agent_id) : undefined;
    return {
      id: r.id,
      debtorId: r.debtor_id ?? "",
      debtorName: debtor?.name ?? "",
      phone: debtor?.phone_primary ?? "",
      agentName: agent?.name ?? "—",
      channel: r.channel as MessageChannel,
      direction: r.direction as MessageDirection,
      templateName: r.template_name ?? undefined,
      content: r.content,
      status: r.status as MessageStatus,
      paymentLinkUrl: r.payment_link_url ?? undefined,
      sentAt: r.sent_at,
    };
  });

  localStorage.setItem(KEY, JSON.stringify(recs));
  window.dispatchEvent(new CustomEvent("messages-updated"));
}

/** Records an outbound message against a real debtor, and — for sms — actually sends it via the
 * telephony provider before writing the row. `status` reflects whether the provider accepted the
 * send, not just an optimistic "sent".
 *
 * WhatsApp has no gateway wired (the Exotel WABA route was dropped 2026-09-05 and nothing has
 * replaced it), so a WhatsApp send is recorded as "failed" rather than pretending to deliver. */
export async function sendMessage(m: {
  debtorId: string;
  agentEmail: string;
  channel: MessageChannel;
  content: string;
  templateName?: string;
  paymentLinkUrl?: string;
}): Promise<void> {
  const [{ data: agentRows }, { data: debtorRows }] = await Promise.all([
    supabase.from("agents").select("id, email"),
    supabase.from("debtors").select("phone_primary").eq("id", m.debtorId),
  ]);
  const agentUuid = (agentRows ?? []).find((a) => a.email === m.agentEmail)?.id ?? null;
  const phone = debtorRows?.[0]?.phone_primary;

  let status: MessageStatus = "sent";
  if (m.channel === "whatsapp" || m.channel === "sms") {
    if (!phone) {
      console.error(
        `[messages] cannot send ${m.channel}: no phone on file for debtor ${m.debtorId}`,
      );
      status = "failed";
    } else {
      try {
        if (m.channel === "whatsapp") {
          throw new Error("no WhatsApp gateway is configured");
        } else {
          await sendSms({
            data: {
              accessToken: await getAccessToken(),
              to: phone,
              templateId: m.templateName ?? "generic_update",
              templateParams: [m.content],
            },
          });
        }
      } catch (err) {
        console.error(
          `[messages] ${m.channel} send failed:`,
          err instanceof Error ? err.message : String(err),
        );
        status = "failed";
      }
    }
  }

  const { error } = await supabase.from("messages").insert({
    debtor_id: m.debtorId,
    agent_id: agentUuid,
    channel: m.channel,
    direction: "outbound",
    template_name: m.templateName ?? null,
    content: m.content,
    status,
    payment_link_url: m.paymentLinkUrl ?? null,
  });
  if (error) throw error;

  await refreshMessages();
}
