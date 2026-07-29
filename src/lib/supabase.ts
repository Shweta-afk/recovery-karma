import { createClient } from "@supabase/supabase-js";

let supabaseInstance: ReturnType<typeof createClient> | null = null;

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      `Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars.\n` +
      `VITE_SUPABASE_URL: ${supabaseUrl ? "✓" : "missing"}\n` +
      `VITE_SUPABASE_ANON_KEY: ${supabaseAnonKey ? "✓" : "missing"}`,
    );
  }

  supabaseInstance = createClient(supabaseUrl, supabaseAnonKey);
  return supabaseInstance;
}

export const supabase = new Proxy(new Object(), {
  get(_, prop) {
    return (getSupabase() as any)[prop];
  },
}) as ReturnType<typeof createClient>;

/** The logged-in user's own `agents` row (id + client_id) — every write to a
 * client-scoped table needs client_id to satisfy RLS, and agent_id/uploaded_by
 * style FKs need the agents.id UUID rather than the auth uid or email. */
export async function getMyAgentRow(): Promise<{ id: string; client_id: string } | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("agents")
    .select("id, client_id")
    .eq("auth_user_id", user.id)
    .single();
  // Surface lookup failures instead of silently returning null — callers that write to
  // client-scoped tables need client_id, and a swallowed error here previously showed up
  // downstream as a confusing generic RLS violation instead of this actionable message.
  if (error)
    throw new Error(
      `Could not load your agent profile (${error.message}) — contact an admin to check your account is linked correctly`,
    );
  return data ?? null;
}
