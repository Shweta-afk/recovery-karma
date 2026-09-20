// Who the dialer may ring, sourced from OUR database rather than the telephony vendor's CRM.
//
// The provider identifies an agent by the phone number it rings — for click-to-call vendors that is the
// agent's registered number/extension, which is what agents.agent_phone must hold. If the two
// drift apart the provider can't route the leg to the right agent, so this is the one field
// that has to stay in sync with the vendor dashboard.

import { supabase } from "@/lib/supabase";

export interface DialerAgent {
  id: string;
  name: string;
  phone: string;
}

/**
 * Active agents on this client that have a phone the provider can ring.
 * RLS scopes the query to the caller's client, so no manual filtering is needed.
 */
export async function fetchDialerAgents(): Promise<DialerAgent[]> {
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, agent_phone, role, is_active")
    .eq("is_active", true)
    .not("agent_phone", "is", null);

  if (error) {
    console.error("[dialer] failed to load agent pool:", error.message);
    return [];
  }

  const rows = (data ?? []) as Array<{ id: string; name: string; agent_phone: string | null }>;
  return rows
    .filter((a) => typeof a.agent_phone === "string" && a.agent_phone.trim() !== "")
    .map((a) => ({ id: a.id, name: a.name, phone: String(a.agent_phone) }));
}

/** Just the numbers, which is what the dialer run needs. */
export async function fetchDialerAgentNumbers(): Promise<string[]> {
  return (await fetchDialerAgents()).map((a) => a.phone);
}
