import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const { data, error } = await supabase
  .from("debtors")
  .select(
    `
    id,
    name,
    phone_primary,
    loan_amount,
    dpd,
    ai_score,
    ai_score_reason,
    last_contacted_at,
    portfolios(name)
  `,
  )
  .eq("status", "active")
  .order("ai_score", { ascending: false })
  .limit(5);

if (error) {
  console.error("Error:", error);
} else {
  console.log("Success! Fetched", data?.length || 0, "debtors");
  console.log(JSON.stringify(data?.[0], null, 2));
}
