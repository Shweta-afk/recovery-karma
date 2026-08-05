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

/** How long a cached agent profile stays trusted before it is re-fetched.
 *
 * Was 1 hour — too long for agent_phone specifically: click_to_call rings whatever this
 * field holds, so an admin fixing a misconfigured/colliding number left every already-signed-
 * in agent silently dialing with the STALE value for up to an hour, with nothing telling
 * them why calls still weren't going through. Short enough that a page reload after an admin
 * edit picks it up almost immediately, long enough not to re-query on every mount/tab-focus. */
const PROFILE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Safety net: reproduced in production a case where two concurrent calls into this same
 * Supabase client hung indefinitely with no error, warning, or rejection — see the
 * `useEffect` below for the fix to the call pattern that caused it. Bounding every auth
 * network call means a recurrence degrades to "briefly stuck, then signed out" rather than
 * an unrecoverable blank "Loading…" screen. */
const AUTH_CALL_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${AUTH_CALL_TIMEOUT_MS}ms`)), AUTH_CALL_TIMEOUT_MS),
    ),
  ]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchAgentProfile(authUserId: string, forceRefresh = false): Promise<AuthUser | null> {
    // Check cache first (avoid redundant queries on auth state changes)
    const cacheKey = `agent-profile-${authUserId}`;
    const cached = forceRefresh ? null : localStorage.getItem(cacheKey);
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

    // Fetch from Supabase. Wrapped in Promise.resolve(): the query builder is thenable but
    // not a real Promise, and withTimeout's generic needs one to infer the result type.
    const { data, error } = await withTimeout(
      Promise.resolve(
        supabase.from("agents").select("name, email, role, agent_phone").eq("auth_user_id", authUserId).single(),
      ),
      "agents lookup",
    );

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
    // Diagnosed in production: onAuthStateChange fires its own INITIAL_SESSION event
    // immediately on subscribe, so the old code below made TWO overlapping calls into
    // fetchAgentProfile() on every page load — one from getSession().then(), one from that
    // INITIAL_SESSION event. Verified independently that the database, RLS, the anon key
    // and a freshly-constructed supabase-js client all resolve this exact query in under a
    // second; only the app's already-mounted client, hit with two concurrent requests, would
    // hang indefinitely with loading stuck true and no error, warning, or rejection of any
    // kind. `handledInitial` makes onAuthStateChange skip that first synthetic event and
    // handle only real, later transitions (sign-in, sign-out, token refresh) — getSession()
    // remains the single source of truth for the session already present at load.
    let cancelled = false;
    let handledInitial = false;

    // withTimeout only bounds the network call inside fetchAgentProfile; this wrapper makes
    // that guarantee unconditional regardless of which caller invokes it, so a rejection can
    // never leave `loading` stuck true — the failure mode becomes "signed out", not "hung".
    async function resolveSession(session: { user: { id: string } } | null) {
      try {
        const profile = session?.user ? await fetchAgentProfile(session.user.id) : null;
        if (cancelled) return;
        setUser(profile);
      } catch (err) {
        console.error("[auth] failed to resolve session:", err);
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        handledInitial = true;
        return resolveSession(session);
      })
      .catch((err) => {
        console.error("[auth] getSession failed:", err);
        handledInitial = true;
        if (!cancelled) setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!handledInitial) {
        // getSession() above already covers this first check; still let it flip the guard
        // in case this event beats getSession()'s .then() to the punch.
        handledInitial = true;
        return;
      }
      void resolveSession(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
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
    // Fetch profile immediately so caller gets the role for redirect. Force a fresh fetch —
    // trusting the cache here is how a role promotion made after the last login silently
    // reverted on the user's next sign-in.
    try {
      const profile = data.user ? await fetchAgentProfile(data.user.id, true) : null;
      if (profile) setUser(profile);
      return { error: null, user: profile };
    } catch (err) {
      console.error("[auth] fetchAgentProfile failed during login:", err);
      return { error: "Signed in, but could not load your profile — please retry.", user: null };
    } finally {
      setLoading(false);
    }
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
