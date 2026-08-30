// The real tenant identity — src/supabase/schema.sql's `clients` table. Distinct from
// org-settings-store.ts, which is a purely local (per-browser) set of preferences unrelated
// to RLS/tenant identity.

import { supabase, getMyAgentRow } from "./supabase";

export interface Client {
  id: string;
  company_name: string;
  plan: string;
}

export async function getMyClient(): Promise<Client | null> {
  const me = await getMyAgentRow();
  // client_id is nullable: an agents row can exist before it is attached to a client, and
  // querying clients with a null id would return every row the caller can see.
  if (!me?.client_id) return null;
  const { data, error } = await supabase
    .from("clients")
    .select("id, company_name, plan")
    .eq("id", me.client_id)
    .single();
  if (error) return null;
  return data as Client;
}

export async function updateCompanyName(name: string): Promise<void> {
  const me = await getMyAgentRow();
  if (!me?.client_id) throw new Error("Your account is not linked to a company yet");
  const { error } = await supabase
    .from("clients")
    .update({ company_name: name })
    .eq("id", me.client_id);
  if (error) throw error;
}
