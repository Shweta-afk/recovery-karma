import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
import { supabase } from "./supabase";
import { enforceSingleSession, verifySubdomainAccess } from "./session-actions.server";

export type Role = "agent" | "manager" | "admin" | "superadmin";

/**
 * Where a role's "home" is - the single source of truth for it.
 *
 * This existed inline in login.tsx while the sidebar's SamvadX logo linked to "/dashboard" for
 * everyone, so a manager clicking the logo landed on the AGENT dashboard: their own per-agent
 * page, which shows empty or irrelevant data because managers are not individually assigned
 * debtors. The sidebar hides the whole Agent Workspace group from managers for exactly that
 * reason - the logo was the one link that bypassed it, which is why the app appeared to have
 * two different manager dashboards.
 *
 * Every "go home" affordance must route through this. Adding a role, or moving a landing page,
 * should mean editing one function.
 */
export function homeRouteForRole(
  role: Role | undefined,
): "/dashboard" | "/manager" | "/admin" | "/superadmin" {
  if (role === "superadmin") return "/superadmin";
  if (role === "admin") return "/admin";
  if (role === "manager") return "/manager";
  return "/dashboard";
}

export interface AuthUser {
  /** Supabase auth.users UUID — use this as the canonical agentId */
  id: string;
  name: string;
  email: string;
  role: Role;
  agentPhone: string | null; // Phone/extension registered with the telephony provider
  /** The company's verification status (20260909_company_verification_and_subdomain.sql).
   *  Undefined for a superadmin, who has no client_id. AppShell shows a "pending" gate screen
   *  instead of the app for anything other than "approved". */
  companyStatus?: "pending" | "approved" | "rejected";
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  login: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null; user: AuthUser | null }>;
  logout: () => Promise<void>;
  /** Set when this tab was force-signed-out because the account logged in on another device.
   *  login.tsx reads it to show a one-time banner; login() clears it on the next attempt. */
  signedOutReason: string | null;
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
      setTimeout(
        () => reject(new Error(`${label} timed out after ${AUTH_CALL_TIMEOUT_MS}ms`)),
        AUTH_CALL_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** superadmins has no RLS policy at all (see 20260909_superadmin_and_wallets.sql) — the anon/
 *  authenticated client can never read it, by construction. The only way to resolve one is a
 *  server action using the service-role client, so this is a genuinely separate path from the
 *  agents lookup above, not just a different table name in the same query shape. */
async function fetchSuperadminProfile(authUserId: string): Promise<AuthUser | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  try {
    // Dynamically imported so server-only code never ships in the eager client bundle — same
    // convention as setup.tsx's createCompany call.
    const { resolveSuperadmin } = await import("./superadmin-actions.server");
    const result = await withTimeout(
      resolveSuperadmin({ data: { accessToken: session.access_token } }),
      "superadmin lookup",
    );
    if (!result.superadmin) return null;
    return {
      id: authUserId,
      name: result.superadmin.name,
      email: result.superadmin.email,
      role: "superadmin",
      agentPhone: null,
    };
  } catch (err) {
    console.error("[auth] fetchSuperadminProfile failed:", err);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);

  // The session_nonce this tab believes is current. Compared against Realtime updates on the
  // agents row to detect "a newer login happened elsewhere" — see
  // 20260908_single_active_session.sql. Cache is skipped for this field on purpose (unlike the
  // rest of the profile): it must reflect the DB's current value, not a stale one, or a tab
  // could either miss a real eviction or false-positive on one.
  const sessionNonceRef = useRef<string | null>(null);

  // True for the duration of an explicit login() call. signInWithPassword() fires its own
  // SIGNED_IN event through onAuthStateChange below, which would otherwise race login()'s own
  // fetchAgentProfile call — and since that event-driven path is NOT forced, it can win the
  // race with a stale/cached session_nonce and clobber sessionNonceRef with the wrong value
  // right as the Realtime event for login()'s own nonce rotation arrives, causing this tab to
  // wrongly conclude it was signed out elsewhere. login() already handles the full sign-in
  // end-to-end, so the event handler has nothing useful to add while this is true.
  const loggingInRef = useRef(false);

  async function fetchAgentProfile(
    authUserId: string,
    forceRefresh = false,
  ): Promise<AuthUser | null> {
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

    // Run both lookups in parallel rather than falling back sequentially — most logins are NOT
    // a superadmin, and sequencing "try agents, then try superadmins" would add a full round
    // trip's worth of latency to that common case. Wrapped in Promise.resolve(): the query
    // builder is thenable but not a real Promise, and withTimeout's generic needs one to infer
    // the result type.
    const [{ data, error }, superadmin] = await Promise.all([
      withTimeout(
        Promise.resolve(
          supabase
            .from("agents")
            // Embeds the agent's own client row via the client_id FK — one query gets both the
            // profile and the company's verification status (20260909_company_verification_and_
            // subdomain.sql), which the "pending" gate screen below needs on every login.
            .select("name, email, role, agent_phone, session_nonce, clients(status)")
            .eq("auth_user_id", authUserId)
            .maybeSingle(),
        ),
        "agents lookup",
      ),
      fetchSuperadminProfile(authUserId),
    ]);

    // Superadmin takes precedence when an account is BOTH a superadmin and a company-level
    // agent/manager/admin (e.g. a platform owner who also has a seat in one company) — they
    // should always land in the superadmin console on login, never in whichever company they
    // happen to also hold an agents row in.
    if (superadmin) {
      localStorage.setItem(cacheKey, JSON.stringify({ profile: superadmin, at: Date.now() }));
      return superadmin;
    }

    if (error || !data) return null;

    sessionNonceRef.current = (data.session_nonce as string | null) ?? null;

    // Embedded FK selects come back as an object for a to-one relationship, but supabase-js
    // types it defensively as possibly-array — narrow either shape down to one row.
    const embeddedClient = data.clients as { status?: string } | { status?: string }[] | null;
    const clientStatus = Array.isArray(embeddedClient) ? embeddedClient[0] : embeddedClient;

    const profile: AuthUser = {
      id: authUserId,
      name: data.name,
      email: data.email,
      role: data.role as Role,
      agentPhone: data.agent_phone as string | null,
      companyStatus: clientStatus?.status as AuthUser["companyStatus"],
    };

    localStorage.setItem(cacheKey, JSON.stringify({ profile, at: Date.now() }));
    return profile;
  }

  /** Best-effort local sign-out triggered by a Realtime event, not a user click — the
   *  underlying refresh token was already revoked server-side by whichever device logged in
   *  next, so this is just clearing this tab's own state; AppShell's existing
   *  `user === null -> navigate("/login")` effect does the actual redirect. */
  async function forceSignOutLocally(reason: string) {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch (err) {
      console.error("[auth] signOut during forced eviction failed (continuing anyway):", err);
    }
    setSignedOutReason(reason);
    setUser(null);
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
      if (loggingInRef.current) return;
      void resolveSession(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // One account, one device: listen for this agent's session_nonce changing to a value this
  // tab didn't itself just set — that means a newer login happened elsewhere, so this tab signs
  // itself out immediately rather than waiting for its access token to expire naturally. See
  // 20260908_single_active_session.sql. Channel name is unique per subscription (not a fixed
  // string) for the same reason live-calls-store.ts's is — a shared channel name across
  // multiple mounted subscribers throws once the first one calls .subscribe().
  useEffect(() => {
    if (!user) return;
    const authUserId = user.id;
    const channel = supabase
      .channel(`agent-session-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "agents",
          filter: `auth_user_id=eq.${authUserId}`,
        },
        (payload) => {
          const newNonce = (payload.new as { session_nonce: string | null }).session_nonce ?? null;
          if (newNonce !== sessionNonceRef.current) {
            void forceSignOutLocally(
              "You were signed out because this account was signed in on another device.",
            );
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // Deliberately keyed on the id alone — a profile refresh (e.g. the 2-minute cache expiry)
    // produces a new `user` object with the same id, and resubscribing the channel on every
    // one of those would be pure churn for no behavior change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const login = async (
    email: string,
    password: string,
  ): Promise<{ error: string | null; user: AuthUser | null }> => {
    setLoading(true);
    setSignedOutReason(null);
    loggingInRef.current = true;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      loggingInRef.current = false;
      return { error: error.message, user: null };
    }
    // Company-subdomain scoping (20260909_subdomain_login_scoping — see
    // session-actions.server.ts's verifySubdomainAccess): if this hostname is a company's
    // assigned subdomain, only that company's own users may sign in here at all. Checked
    // BEFORE enforceSingleSession/profile fetch and, unlike those, is NOT best-effort — a
    // rejection here signs the browser back out immediately rather than letting the wrong
    // company's user proceed.
    if (data.session?.access_token) {
      try {
        const subdomainCheck = await verifySubdomainAccess({
          data: { accessToken: data.session.access_token, hostname: window.location.hostname },
        });
        if (!subdomainCheck.ok) {
          await supabase.auth.signOut();
          setLoading(false);
          loggingInRef.current = false;
          return { error: subdomainCheck.error, user: null };
        }
      } catch (err) {
        // Fail OPEN here too (matches verifySubdomainAccess's own DB-lookup failure mode) —
        // a network blip talking to this check must not turn into every login failing.
        console.error("[auth] verifySubdomainAccess failed (continuing sign-in anyway):", err);
      }
    }
    // Revoke every other session for this account and rotate session_nonce BEFORE reading the
    // profile back below, so that read picks up the fresh nonce rather than the stale one —
    // see enforceSingleSession. Best-effort: a failure here shouldn't block this device's own
    // sign-in, only degrade the single-device guarantee for this one login.
    if (data.session?.access_token) {
      try {
        await enforceSingleSession({ data: { accessToken: data.session.access_token } });
      } catch (err) {
        console.error("[auth] enforceSingleSession failed (continuing sign-in anyway):", err);
      }
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
      loggingInRef.current = false;
    }
  };

  const logout = async () => {
    sessionNonceRef.current = null;
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, loading, login, logout, signedOutReason }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
