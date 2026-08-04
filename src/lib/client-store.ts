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
  if (!me) return null;
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
  if (!me) throw new Error("Not signed in");
  const { error } = await supabase
    .from("clients")
    .update({ company_name: name })
    .eq("id", me.client_id);
  if (error) throw error;
}
