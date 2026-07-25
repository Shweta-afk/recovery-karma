import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Check auth state
const {
  data: { user },
  error: authError,
} = await supabase.auth.getUser();
console.log("=== Auth State ===");
console.log("Authenticated:", !!user);
console.log("User ID:", user?.id);
console.log("Auth Error:", authError);

if (user) {
  console.log("\n=== Checking agent record ===");
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, name, client_id")
    .eq("auth_user_id", user.id)
    .single();

  if (agentError) {
    console.log("Agent Error:", agentError);
  } else {
    console.log("Agent found:", agent);

    if (agent) {
      console.log("\n=== Debtors for this client ===");
      const { data: debtors, error: debtorError } = await supabase
        .from("debtors")
        .select("id, name, status, client_id")
        .eq("client_id", agent.client_id)
        .limit(3);

      if (debtorError) {
        console.log("Debtor Error:", debtorError);
      } else {
        console.log("Debtors found:", debtors?.length || 0);
        console.log(debtors);
      }
    }
  }
}
