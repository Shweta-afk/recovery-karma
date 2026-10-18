import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";
import { selectWithSlimExtra, slimExtraFromRow } from "./debtor-extra";

/** Every debtor column any of the three stores needs, unioned into one selection.
 * portfolio-store's set is already a superset of disposition-store's and payments-store's, so
 * this is exactly what portfolio-store asked for on its own. The newer columns (`alt_phones`,
 * `retained_from_portfolio_id`, …) are not in it: fetchDebtorsShared() adds them as
 * OPTIONAL_COLUMNS, with a fallback for a database that lacks them.
 *
 * (2026-09-23) disposition-store and payments-store no longer read this via
 * fetchDebtorsShared() below — see fetchDebtorsByIds(). Kept as one shared column list so the
 * two functions can't drift apart on what a "debtor" looks like to either caller. */
//
// (2026-09-23) `extra` is not in this list. fetchDebtorsShared() appends only its named
// sub-fields (debtor-extra.ts) and fetchDebtorsByIds() none at all — its two callers never
// read it, yet it was ~87% of every row they downloaded.
const COLUMNS =
  "id, portfolio_id, name, phone_primary, email, loan_amount, dpd, loan_reference, assigned_agent_id, status";

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
  /** A SUBSET of the real bag (named sub-fields only), or null from fetchDebtorsByIds() —
   * never write this back to the database. See debtor-extra.ts. */
  extra: Record<string, string> | null;
  assigned_agent_id: string | null;
  status: string | null;
  /** Only from fetchDebtorsShared(), and only when `withOptional` is true. */
  alt_phones?: string[] | null;
  principal_amount?: number | string | null;
  emi_amount?: number | string | null;
  product_code?: string | null;
  retained_from_portfolio_id?: string | null;
}

type DebtorRow = SharedDebtorRow;

/** Newer columns portfolio-store used to read in three more whole-table passes of their own
 * (alt phones, principal/EMI/product code, retained-from), each best-effort in case its
 * migration was missing. All exist live (2026-10-18), so they ride on the one shared read; for
 * a 29,813-debtor company that is 30 requests instead of 120. If a database lacks any of them,
 * the read is repeated without them and `withOptional` is false, so portfolio-store falls back
 * to its separate passes. */
const OPTIONAL_COLUMNS =
  "alt_phones, principal_amount, emi_amount, product_code, retained_from_portfolio_id";
let optionalAvailable = true;

type SharedResult = {
  data: DebtorRow[];
  error: { message: string } | null;
  withOptional: boolean;
};

/** Set only while a fetch is in flight. */
let inFlight: Promise<SharedResult> | null = null;

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
export function fetchDebtorsShared(): Promise<SharedResult> {
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      const read = (optional: boolean) =>
        selectWithSlimExtra(false, (extraColumns) =>
          fetchAllRows<DebtorRow>(
            (from, to) =>
              supabase
                .from("debtors")
                .select(`${COLUMNS}, ${optional ? `${OPTIONAL_COLUMNS}, ` : ""}${extraColumns}`)
                .range(from, to) as unknown as PromiseLike<{
                data: DebtorRow[] | null;
                error: { message: string } | null;
              }>,
          ),
        );
      let withOptional = optionalAvailable;
      let result = await read(withOptional);
      // Only a missing column turns the optional set off; any other error is returned as-is.
      if (withOptional && result.error && /column .* does not exist/i.test(result.error.message)) {
        optionalAvailable = withOptional = false;
        console.warn("[debtors-fetch] newer debtor columns missing — reading them separately");
        result = await read(false);
      }
      return {
        ...result,
        withOptional,
        data: result.data.map((r) => ({ ...r, extra: slimExtraFromRow(r) })),
      };
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
    if (r.data) for (const row of r.data) data.push({ ...row, extra: null });
  }
  return { data, error: null };
}
