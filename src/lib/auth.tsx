import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { supabase } from "./supabase";

export type Role = "agent" | "manager" | "admin";

export interface AuthUser {
  /** Supabase auth.users UUID — use this as the canonical agentId */
  id: string;
  name: string;
  email: string;
  role: Role;
  agentPhone: string | null; // Tata SmartFlo phone/extension
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  login: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null; user: AuthUser | null }>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

/** How long a cached agent profile stays trusted before it is re-fetched. */
const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchAgentProfile(authUserId: string): Promise<AuthUser | null> {
    // Check cache first (avoid redundant queries on auth state changes)
    const cacheKey = `agent-profile-${authUserId}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const { profile, at } = JSON.parse(cached) as { profile: AuthUser; at: number };
        // Without this check the cache never expires, so an admin edit to the agent's row
        // (e.g. their phone number) would never reach a browser that had logged in once.
        if (profile && Date.now() - at < PROFILE_CACHE_TTL_MS) return profile;
      } catch {
        // Cache corrupted, fall through to fetch
      }
    }

    // Fetch from Supabase
    const { data, error } = await supabase
      .from("agents")
      .select("name, email, role, agent_phone")
      .eq("auth_user_id", authUserId)
      .single();

    if (error || !data) return null;

    const profile: AuthUser = {
      id: authUserId,
      name: data.name,
      email: data.email,
      role: data.role as Role,
      agentPhone: data.agent_phone as string | null,
    };

    localStorage.setItem(cacheKey, JSON.stringify({ profile, at: Date.now() }));
    return profile;
  }

  useEffect(() => {
    // TEMPORARY diagnostic instrumentation: the auth effect has been observed hanging in
    // production with `loading` never reaching false — no thrown error, no unhandled
    // rejection, no navigator.locks held, and a freshly-constructed supabase-js client
    // against the same stored session resolves instantly. This narrows down exactly which
    // await point stalls. Remove once the cause is confirmed.
    const t0 = Date.now();
    const mark = (label: string, extra?: unknown) =>
      console.log(`[auth] +${Date.now() - t0}ms ${label}`, extra ?? "");

    mark("effect start");

    // Check existing session on mount
    mark("calling getSession()");
    supabase.auth
      .getSession()
      .then(async ({ data: { session }, error }) => {
        mark("getSession() resolved", { hasSession: !!session, error });
        if (session?.user) {
          mark("calling fetchAgentProfile()", session.user.id);
          const profile = await fetchAgentProfile(session.user.id);
          mark("fetchAgentProfile() resolved", profile);
          setUser(profile);
        }
        mark("calling setLoading(false) [getSession path]");
        setLoading(false);
      })
      .catch((err) => mark("getSession() THREW", String(err)));

    // Keep state in sync with Supabase auth events
    mark("registering onAuthStateChange");
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      mark("onAuthStateChange fired", { event, hasSession: !!session });
      if (session?.user) {
        const profile = await fetchAgentProfile(session.user.id);
        mark("fetchAgentProfile() resolved [onAuthStateChange path]", profile);
        setUser(profile);
      } else {
        setUser(null);
      }
      mark("calling setLoading(false) [onAuthStateChange path]");
      setLoading(false);
    });
    mark("onAuthStateChange registered");

    return () => subscription.unsubscribe();
  }, []);

  const login = async (
    email: string,
    password: string,
  ): Promise<{ error: string | null; user: AuthUser | null }> => {
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      return { error: error.message, user: null };
    }
    // Fetch profile immediately so caller gets the role for redirect
    const profile = data.user ? await fetchAgentProfile(data.user.id) : null;
    if (profile) setUser(profile);
    setLoading(false);
    return { error: null, user: profile };
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
