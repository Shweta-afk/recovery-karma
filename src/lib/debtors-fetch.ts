import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";

/** Every debtor column any of the three stores needs, unioned into one selection.
 * portfolio-store's set is already a superset of disposition-store's and payments-store's, so
 * this is exactly what portfolio-store asked for on its own. `alt_phones` and
 * `retained_from_portfolio_id` are deliberately absent: they live behind migrations that may
 * not be applied, so portfolio-store keeps fetching those separately and best-effort. */
const COLUMNS =
  "id, portfolio_id, name, phone_primary, email, loan_amount, dpd, loan_reference, extra, assigned_agent_id, status";

/** The shape COLUMNS actually returns. Declared here rather than leaning on the generated
 * Supabase types, which do not cover these columns and widen every row to `never` (as the
 * casts scattered through the three stores already work around). */
export interface SharedDebtorRow {
  id: string;
  portfolio_id: string | null;
  name: string;
  phone_primary: string;
  email: string | null;
  loan_amount: number | string | null;
  dpd: number | null;
  loan_reference: string | null;
  extra: Record<string, string> | null;
  assigned_agent_id: string | null;
  status: string | null;
}

type DebtorRow = SharedDebtorRow;

/** Set only while a fetch is in flight. */
let inFlight: Promise<{ data: DebtorRow[]; error: { message: string } | null }> | null = null;

/**
 * One paginated read of `debtors`, shared by every caller that asks while it is in flight.
 *
 * portfolio-store, disposition-store and payments-store each used to page the whole table
 * independently, and all three fire from the same useEffect on mount — so a single page load
 * pulled the full debtor set three times over (~45,000 rows across ~18 requests on the live
 * data). They now await the same promise and get the same rows.
 *
 * Dedupe is strictly in-flight, with NO time-based cache: a call that starts after the
 * previous one settled issues a fresh read. That matters because every write path here calls
 * refreshX() immediately afterwards and must see its own write — a TTL would hand back the
 * pre-write snapshot instead. The win is concurrency, not caching.
 */
export function fetchDebtorsShared(): Promise<{
  data: DebtorRow[];
  error: { message: string } | null;
}> {
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      return await fetchAllRows<DebtorRow>(
        (from, to) =>
          supabase.from("debtors").select(COLUMNS).range(from, to) as unknown as PromiseLike<{
            data: DebtorRow[] | null;
            error: { message: string } | null;
          }>,
      );
    } finally {
      // Cleared before any awaiting caller resumes, so the next call after this settles starts
      // a genuinely fresh read rather than latching onto a finished promise.
      inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}
