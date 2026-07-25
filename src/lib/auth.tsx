import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { supabase } from "./supabase";

export type Role = "agent" | "manager" | "admin";

export interface AuthUser {
  /** Supabase auth.users UUID — use this as the canonical agentId */
  id: string;
  name: string;
  email: string;
  role: Role;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchAgentProfile(authUserId: string): Promise<AuthUser | null> {
    const { data, error } = await supabase
      .from("agents")
      .select("name, email, role")
      .eq("auth_user_id", authUserId)
      .single();

    if (error || !data) return null;
    return { id: authUserId, name: data.name, email: data.email, role: data.role as Role };
  }

  useEffect(() => {
    // Check existing session on mount
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const profile = await fetchAgentProfile(session.user.id);
        setUser(profile);
      }
      setLoading(false);
    });

    // Keep state in sync with Supabase auth events
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        const profile = await fetchAgentProfile(session.user.id);
        setUser(profile);
      } else {
        setUser(null);
      }
      setLoading(false);
    });

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
