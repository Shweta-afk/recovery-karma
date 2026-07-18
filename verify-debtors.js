import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const { data, error, count } = await supabase
  .from('debtors')
  .select('id, name, dpd, ai_score, status', { count: 'exact' })
  .eq('status', 'active')
  .order('ai_score', { ascending: false })
  .limit(15);

console.log('✓ Debtors loaded:', count || 0);
if (error) {
  console.error('Error:', error);
} else {
  data?.forEach(d => {
    console.log(`  ${d.name.padEnd(25)} | DPD: ${String(d.dpd).padEnd(3)} | AI Score: ${d.ai_score}/10 | Status: ${d.status}`);
  });
}
