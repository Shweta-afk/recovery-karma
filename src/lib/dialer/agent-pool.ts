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
    .select("id, name, agent_phone, agent_extension, role, is_active")
    .eq("is_active", true);

  if (error) {
    console.error("[dialer] failed to load agent pool:", error.message);
    return [];
  }

  // No phone on file: the calling extension stands in, exactly as the server's own list does
  // (companyAgentPhones in telephony/server.ts). Phones only here meant an agent with an
  // extension but no phone — Richa, Sejal and 5 others on 2026-11-25 — couldn't start
  // Productive Dial: the browser sent only their manager's number and the server refused it
  // ("Your own phone number is not set up").
  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    agent_phone: string | null;
    agent_extension?: string | null;
  }>;
  return rows
    .map((a) => ({
      id: a.id,
      name: a.name,
      phone: a.agent_phone?.trim() || a.agent_extension?.trim() || "",
    }))
    .filter((a) => a.phone !== "");
}

/** Just the numbers, which is what the dialer run needs. */
export async function fetchDialerAgentNumbers(): Promise<string[]> {
  return (await fetchDialerAgents()).map((a) => a.phone);
}
