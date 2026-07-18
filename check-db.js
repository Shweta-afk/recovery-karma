import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

console.log("=== All debtors (no filters) ===");
const { data: allDebtors, error: err1 } = await supabase
  .from('debtors')
  .select('id, name, status')
  .limit(5);

if (err1) console.error('Error:', err1);
else console.log('Count:', allDebtors?.length, allDebtors?.map(d => `${d.name} (${d.status})`));

console.log("\n=== Portfolios ===");
const { data: portfolios, error: err2 } = await supabase
  .from('portfolios')
  .select('id, name');

if (err2) console.error('Error:', err2);
else console.log('Count:', portfolios?.length, portfolios?.map(p => p.name));
