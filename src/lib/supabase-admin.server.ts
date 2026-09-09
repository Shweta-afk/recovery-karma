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
// Same permissive stand-in the browser client uses — see the note on GenericSchema.
import type { Database } from "./database.types";
import type { Role } from "./auth";

let adminInstance: ReturnType<typeof createClient<Database>> | null = null;

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

  adminInstance = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminInstance;
}

export interface VerifiedCaller {
  authUserId: string;
  /** The caller's `agents.id` — what FK columns like `requested_by` need, as opposed to the
   *  auth uid. Null only if the row somehow has no id, which `.single()` already rules out. */
  agentId: string | null;
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

  // Cast because the client is untyped (no generated Database types), so `.from()` widens to
  // `never` and every column read below would otherwise be a type error.
  const { data, error } = (await admin
    .from("agents")
    .select("id, client_id, role")
    .eq("auth_user_id", user.id)
    .single()) as {
    data: { id: string; client_id: string; role: Role } | null;
    error: unknown;
  };
  if (error || !data?.client_id) return null;

  return {
    authUserId: user.id,
    agentId: data.id ?? null,
    clientId: data.client_id,
    role: data.role,
  };
}

export interface VerifiedSuperadmin {
  authUserId: string;
  superadminId: string;
  name: string;
  email: string;
}

/**
 * The chokepoint every superadmin-only server action must call before doing anything —
 * mirrors verifyCaller() above, but against `superadmins` instead of `agents`. superadmins has
 * no RLS policy at all (20260909_superadmin_and_wallets.sql), so the service-role client is the
 * only thing that can ever read it. Returns null if the token is invalid/expired or the caller
 * has no superadmins row (fail closed — a valid agents-table login must never fall through to
 * superadmin access).
 */
export async function verifySuperadminCaller(
  accessToken: string,
): Promise<VerifiedSuperadmin | null> {
  const admin = getSupabaseAdmin();
  const {
    data: { user },
    error: userErr,
  } = await admin.auth.getUser(accessToken);
  if (userErr || !user) return null;

  const { data, error } = (await admin
    .from("superadmins")
    .select("id, name, email")
    .eq("auth_user_id", user.id)
    .single()) as {
    data: { id: string; name: string; email: string } | null;
    error: unknown;
  };
  if (error || !data) return null;

  return {
    authUserId: user.id,
    superadminId: data.id,
    name: data.name,
    email: data.email,
  };
}
