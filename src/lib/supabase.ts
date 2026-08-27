import { createClient } from "@supabase/supabase-js";

/**
 * A permissive stand-in for generated Supabase types.
 *
 * `createClient(url, key)` with no schema generic resolves `.from(anything)` to `never`, so
 * every column read in this codebase was a type error — 315 of them on main, which made
 * `bun run typecheck` (and therefore CI) fail permanently and buried any REAL type error in
 * the noise. `never` gives no safety either, so this is not a trade of rigour for green: it is
 * strictly better than what it replaces.
 *
 * The proper fix is generated types:
 *
 *   bunx supabase gen types typescript --project-id <id> > src/lib/database.types.ts
 *
 * then swap `GenericSchema` for that `Database`. Until someone runs it against the live
 * project, this keeps typecheck meaningful for everything that is NOT a Supabase row.
 */
type GenericRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface GenericSchema {
  public: {
    Tables: {
      [table: string]: {
        Row: GenericRow;
        Insert: GenericRow;
        Update: GenericRow;
        Relationships: [];
      };
    };
    Views: {
      [view: string]: { Row: GenericRow; Relationships: [] };
    };
    Functions: {
      [fn: string]: { Args: GenericRow; Returns: unknown };
    };
    Enums: { [name: string]: string };
    CompositeTypes: { [name: string]: GenericRow };
  };
}

let supabaseInstance: ReturnType<typeof createClient<GenericSchema>> | null = null;

export function getSupabaseConfig() {
  // Server-side: read from process.env (Railway production)
  if (typeof process !== "undefined" && process.env.SUPABASE_URL) {
    return {
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    };
  }

  // Client-side or dev: use VITE_* vars (baked at build time)
  return {
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
}

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance;

  const { supabaseUrl, supabaseAnonKey } = getSupabaseConfig();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      `Missing Supabase config.\n` +
        `Set SUPABASE_URL and SUPABASE_ANON_KEY env vars (production)\n` +
        `or VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (development).\n` +
        `SUPABASE_URL: ${supabaseUrl ? "✓" : "missing"}\n` +
        `SUPABASE_ANON_KEY: ${supabaseAnonKey ? "✓" : "missing"}`,
    );
  }

  supabaseInstance = createClient<GenericSchema>(supabaseUrl, supabaseAnonKey);
  return supabaseInstance;
}

export const supabase = new Proxy(new Object(), {
  get(_, prop) {
    return (getSupabase() as any)[prop];
  },
}) as ReturnType<typeof createClient<GenericSchema>>;

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
