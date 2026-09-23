// Server-side calls into the archive functions, sized to fit PostgREST's 8s statement timeout.
//
// The first scheduled run (2026-09-23) timed out: archive_month() versioned every account in one
// statement (12.8s for a 14,061-account company) and rolled back. Account versioning now lives in
// archive_debtor_versions(), called here in batches — measured at ~1.2s per 1,000 accounts on a
// first save and ~0.15s when nothing changed. See
// migrations/20260923_archive_debtor_versions_batched.sql.
import { getSupabaseAdmin } from "./supabase-admin.server";
import { fetchAllRows } from "./fetch-all-rows";

/** Accounts per archive_debtor_versions() call — ~1.2s each worst case, well inside 8s even as
 * rows get wider. */
export const DEBTOR_VERSION_BATCH = 1000;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- no generated Database types */
type QueryBuilder = any;
interface LooseDb {
  from: (table: string) => QueryBuilder;
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
}
const db = (): LooseDb => getSupabaseAdmin() as unknown as LooseDb;

/** 'YYYY-MM' in IST. */
export function istMonthOf(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  })
    .format(d)
    .slice(0, 7);
}

/** Calls, lookups, payments, messages, disputes, settlements, portfolio and target versions for
 * one company and month. Throws on failure. */
export async function archiveMonth(clientId: string, month: string): Promise<void> {
  const { error } = await db().rpc("archive_month", { p_month: month, p_client: clientId });
  if (error) throw new Error(`archive_month(${month}): ${error.message}`);
}

/**
 * Saves a version of each account (full row, `extra` included) under `month`, but only where it
 * changed since its last saved version. `debtorIds` omitted = every account of the company.
 * Returns how many versions were written. Throws on the first failed batch — callers that strip
 * accounts rely on that to never strip without a copy.
 */
export async function snapshotDebtorVersions(
  clientId: string,
  month: string,
  debtorIds?: string[],
): Promise<number> {
  const admin = db();
  let ids = debtorIds;
  if (!ids) {
    const { data, error } = await fetchAllRows<{ id: string }>((from, to) =>
      admin.from("debtors").select("id").eq("client_id", clientId).order("id").range(from, to),
    );
    if (error) throw new Error(`debtor ids: ${error.message}`);
    ids = data.map((r) => r.id);
  }
  let saved = 0;
  for (let i = 0; i < ids.length; i += DEBTOR_VERSION_BATCH) {
    const { data, error } = await admin.rpc("archive_debtor_versions", {
      p_month: month,
      p_client: clientId,
      p_debtor_ids: ids.slice(i, i + DEBTOR_VERSION_BATCH),
    });
    if (error) throw new Error(`archive_debtor_versions(${month}): ${error.message}`);
    saved += Number(data ?? 0);
  }
  return saved;
}
