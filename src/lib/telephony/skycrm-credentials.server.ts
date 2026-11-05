// Which SkyCRM user an extension belongs to (2026-11-05). SkyCRM asked that every API call and
// login carry the agent's OWN SkyCRM user (Login API, section 22 of API_SKY (3).docx: a JWT with
// username + password + extension), so they can see which users are working. The users are
// created by SamvadX (skycrm_users, Superadmin → company → Calling → "Create SkyCRM users").
// Server-only.
import { getSupabaseAdmin } from "@/lib/supabase-admin.server";

export interface SkycrmCredentials {
  username: string;
  password: string;
}

const HIT_MS = 5 * 60_000;
const MISS_MS = 60_000;
const cache = new Map<string, { value: SkycrmCredentials | null; until: number }>();

/** The created SkyCRM user of whoever holds `extension`, or null (none yet / table missing). */
export async function skycrmCredentials(extension: string): Promise<SkycrmCredentials | null> {
  const ext = extension.trim();
  const hit = cache.get(ext);
  if (hit && hit.until > Date.now()) return hit.value;
  let value: SkycrmCredentials | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
    const { data } = await (getSupabaseAdmin() as any)
      .from("skycrm_users")
      .select("username, password, agents!inner(agent_extension)")
      .eq("status", "created")
      .eq("agents.agent_extension", ext)
      .limit(1)
      .maybeSingle();
    if (data?.username && data?.password) value = { username: data.username, password: data.password };
  } catch {
    value = null;
  }
  cache.set(ext, { value, until: Date.now() + (value ? HIT_MS : MISS_MS) });
  return value;
}

/** Forget a cached answer (after SkyCRM refused the credentials, or users were (re)created). */
export function forgetSkycrmCredentials(extension?: string): void {
  if (extension) cache.delete(extension.trim());
  else cache.clear();
}
