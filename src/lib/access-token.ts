// The caller's Supabase session JWT, for server functions that verify it via verifyCaller().
// Server functions are public HTTP endpoints, so identity must travel in the request body —
// the same pattern the ProfileX and admin actions already use.

import { supabase } from "@/lib/supabase";

export async function getAccessToken(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Your session has expired — please sign in again.");
  return session.access_token;
}
