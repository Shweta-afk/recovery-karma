// Server-only Supabase client authenticated with the service-role key — bypasses RLS
// entirely (Supabase's `service_role` Postgres role has BYPASSRLS). Never import this from
// client code; there is no VITE_-prefixed fallback for the key on purpose, so it can never
// end up in a browser bundle.
//
// Because this client bypasses RLS, nothing in the database backstops a caller that trusts
// client-supplied identity fields (e.g. a client_id sent from the browser). Every privileged
// action built on top of this file MUST call verifyCaller() first and use its returned
// clientId/role — never a value passed in from the request body.

import { createClient } from "@supabase/supabase-js";
import type { Role } from "./auth";

let adminInstance: ReturnType<typeof createClient> | null = null;

export function getSupabaseAdmin() {
  if (adminInstance) return adminInstance;

  const url = typeof process !== "undefined" ? process.env?.SUPABASE_URL : undefined;
  const serviceRoleKey =
    typeof process !== "undefined" ? process.env?.SUPABASE_SERVICE_ROLE_KEY : undefined;

  if (!url || !serviceRoleKey) {
    throw new Error(
      `Missing service-role Supabase config.\n` +
        `Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server env, never VITE_-prefixed).\n` +
        `SUPABASE_URL: ${url ? "✓" : "missing"}\n` +
        `SUPABASE_SERVICE_ROLE_KEY: ${serviceRoleKey ? "✓" : "missing"}`,
    );
  }

  adminInstance = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminInstance;
}

export interface VerifiedCaller {
  authUserId: string;
  clientId: string;
  role: Role;
}

/**
 * The one chokepoint every privileged (service-role) server action must call before doing
 * anything. Validates the caller's own Supabase session JWT (not anything they claim in the
 * request body), then looks up their real client_id/role from their own `agents` row via the
 * service-role client — which bypasses RLS, so this always resolves regardless of what the
 * caller's own row visibility would normally allow. Returns null if the token is invalid/
 * expired or no matching agents row exists (fail closed rather than guessing).
 */
export async function verifyCaller(accessToken: string): Promise<VerifiedCaller | null> {
  const admin = getSupabaseAdmin();
  const {
    data: { user },
    error: userErr,
  } = await admin.auth.getUser(accessToken);
  if (userErr || !user) return null;

  const { data, error } = await admin
    .from("agents")
    .select("client_id, role")
    .eq("auth_user_id", user.id)
    .single();
  if (error || !data?.client_id) return null;

  return { authUserId: user.id, clientId: data.client_id as string, role: data.role as Role };
}
