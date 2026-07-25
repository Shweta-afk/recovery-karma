import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

console.log("=== Fetching debtors (RLS disabled) ===");
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
  console.log("✓ Fetched", data?.length || 0, "debtors");
  data?.forEach((d) => {
    console.log(
      `  • ${d.name} (DPD: ${d.dpd}, AI Score: ${d.ai_score}, Portfolio: ${d.portfolios?.name})`,
    );
  });
}
