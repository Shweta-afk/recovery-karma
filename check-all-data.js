import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

console.log("=== All debtors (no filters) ===");
const {
  data: allDebtors,
  error: err1,
  count: count1,
} = await supabase.from("debtors").select("*", { count: "exact" });

console.log("Error:", err1);
console.log("Count:", count1);
console.log("Data length:", allDebtors?.length);
if (allDebtors && allDebtors.length > 0) {
  console.log("First debtor:", JSON.stringify(allDebtors[0], null, 2));
}

console.log("\n=== All portfolios ===");
const { data: portfolios, count: portCount } = await supabase
  .from("portfolios")
  .select("*", { count: "exact" });

console.log("Count:", portCount);
console.log(
  "Data:",
  portfolios?.map((p) => `${p.name} (ID: ${p.id})`),
);

console.log("\n=== All agents ===");
const { data: agents, count: agentCount } = await supabase
  .from("agents")
  .select("*", { count: "exact" });

console.log("Count:", agentCount);
console.log(
  "Data:",
  agents?.map((a) => `${a.name} (${a.email})`),
);
