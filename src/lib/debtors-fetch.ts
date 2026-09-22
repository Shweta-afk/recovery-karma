import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";

/** Every debtor column any of the three stores needs, unioned into one selection.
 * portfolio-store's set is already a superset of disposition-store's and payments-store's, so
 * this is exactly what portfolio-store asked for on its own. `alt_phones` and
 * `retained_from_portfolio_id` are deliberately absent: they live behind migrations that may
 * not be applied, so portfolio-store keeps fetching those separately and best-effort.
 *
 * (2026-09-23) disposition-store and payments-store no longer read this via
 * fetchDebtorsShared() below — see fetchDebtorsByIds(). Kept as one shared column list so the
 * two functions can't drift apart on what a "debtor" looks like to either caller. */
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
 * One paginated read of the WHOLE `debtors` table, shared by every caller that asks while it
 * is in flight — originally built because portfolio-store, disposition-store and
 * payments-store each paged the whole table independently, and all three fired from the same
 * useEffect on mount.
 *
 * (2026-09-23) Only portfolio-store.ts calls this now. disposition-store and payments-store
 * used to as well, just to build an id -> debtor lookup for enriching call_logs/payments rows
 * with a name/portfolio — which means they were downloading every debtor the caller could see
 * (16,617 rows and growing) to look up the few hundred that actually have a call or payment on
 * them. See fetchDebtorsByIds() below, which they use instead.
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

/** How many ids go in one `.in(...)` request. Keeps each request's URL/param size sane as the
 * distinct-debtors-with-activity count grows into the thousands; unrelated to MAX_PAGE_ROWS,
 * which caps rows RETURNED per page rather than ids SENT per request. */
const ID_CHUNK = 300;

/**
 * Fetches exactly the debtor rows named by `ids` — for disposition-store/payments-store
 * enriching a page of call_logs/payments with the debtor's name, loan reference and portfolio,
 * where the right scope is "whichever debtors this batch of rows actually references," not
 * "everything the caller can see." Chunked, not paginated: `ids` is already the caller's own
 * result set, so there is no server-side "next page" to ask for — just enough distinct ids to
 * need more than one request comfortably.
 */
export async function fetchDebtorsByIds(
  ids: string[],
): Promise<{ data: DebtorRow[]; error: { message: string } | null }> {
  const unique = [...new Set(ids)];
  if (!unique.length) return { data: [], error: null };
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) chunks.push(unique.slice(i, i + ID_CHUNK));
  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        supabase.from("debtors").select(COLUMNS).in("id", chunk) as unknown as PromiseLike<{
          data: DebtorRow[] | null;
          error: { message: string } | null;
        }>,
    ),
  );
  const data: DebtorRow[] = [];
  for (const r of results) {
    // Return what we have rather than a partial set silently presented as complete — matches
    // fetchAllRows()'s own contract, which every caller here already checks `error` against.
    if (r.error) return { data, error: r.error };
    if (r.data) data.push(...r.data);
  }
  return { data, error: null };
}
