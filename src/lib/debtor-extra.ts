// How list queries read debtors.extra without downloading all of it.
//
// `extra` is the bank file's unmapped columns — 88 keys / ~2,400 JSON chars per row on
// production (2026-09-23), 87% of a debtor row. List pages select two computed columns instead
// (migrations/20260923_debtors_extra_preview.sql):
//
//   extra_named — address/city/state/dob/employer/income/language + pos/Principal, all that
//                 debtorFromRow() and the list views read. Every list asks for this.
//   extra_head  — the first 25 keys, which is exactly what Call Queue renders as columns.
//                 Only Call Queue asks for it (DebtorScope.extraColumns).
//
// So an UploadedDebtor's `extra` from a list fetch is a SUBSET of the real bag. Nothing may
// write it back — every write of `extra` in portfolio-store.ts takes rows parsed from a fresh
// bank file, never cached rows — and anything that shows the whole bag (debtor profile, the
// in-call panel, Remap Fields) reads it here with fetchFullExtra()/useFullExtra().
import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";

type Extra = Record<string, string>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flips to false the first time PostgREST says the computed columns don't exist — i.e. this
 * code reached production ahead of the migration. Lists then select `extra` as before: slower,
 * never broken. */
let previewAvailable = true;

function isMissingPreviewError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  return /extra_(named|head)/.test(error.message ?? "") || error.code === "42703";
}

/** Runs `run` with the slim extra columns, retrying once with plain `extra` if the database
 * doesn't have them yet. `run` gets the select fragment to append to its column list. */
export async function selectWithSlimExtra<R extends { error: { message: string } | null }>(
  withHead: boolean,
  run: (extraColumns: string) => PromiseLike<R>,
): Promise<R> {
  if (previewAvailable) {
    const result = await run(withHead ? "extra_named, extra_head" : "extra_named");
    if (!isMissingPreviewError(result.error)) return result;
    previewAvailable = false;
    console.warn("[debtor-extra] extra_named/extra_head missing — falling back to full extra");
  }
  return run("extra");
}

/** The `extra` bag for one row from selectWithSlimExtra(). Head keys go in first so Call
 * Queue's first-25-keys column pick sees the same order it always did. */
export function slimExtraFromRow(row: {
  extra?: unknown;
  extra_named?: unknown;
  extra_head?: unknown;
}): Extra {
  if (row.extra && typeof row.extra === "object") return row.extra as Extra;
  return {
    ...((row.extra_head as Extra | null) ?? {}),
    ...((row.extra_named as Extra | null) ?? {}),
  };
}

/** The complete `extra` bag for each id — for screens that show every bank-file column. */
export async function fetchFullExtra(ids: string[]): Promise<Map<string, Extra>> {
  const out = new Map<string, Extra>();
  if (!ids.length) return out;
  const { data, error } = await supabase.from("debtors").select("id, extra").in("id", ids);
  if (error) throw error;
  for (const r of (data ?? []) as { id: string; extra: Extra | null }[])
    out.set(r.id, r.extra ?? {});
  return out;
}

/** Every row's complete `extra` in one portfolio — Remap Fields needs the union of every
 * leftover file column, and to preview the rewrite against real values. */
export async function fetchPortfolioFullExtra(portfolioId: string): Promise<Map<string, Extra>> {
  const { data, error } = await fetchAllRows<{ id: string; extra: Extra | null }>(
    (from, to) =>
      supabase
        .from("debtors")
        .select("id, extra")
        .eq("portfolio_id", portfolioId)
        .neq("status", "removed")
        .range(from, to) as unknown as PromiseLike<{
        data: { id: string; extra: Extra | null }[] | null;
        error: { message: string } | null;
      }>,
  );
  if (error) throw new Error(error.message);
  return new Map(data.map((r) => [r.id, r.extra ?? {}]));
}

/**
 * The complete `extra` for one debtor, starting from the (possibly partial) bag a list fetch
 * already has so the first render is never empty. Pass `undefined` for a debtor that has no
 * database row (mock/demo, an unmapped manual call) — nothing is fetched then.
 *
 * Deliberately not cached across mounts: it is one ~2KB row, and a re-upload can change it at
 * any time — a stale bag in the profile is worse than a round trip.
 */
export function useFullExtra(debtorId: string | undefined, partial: Extra | undefined): Extra {
  const [full, setFull] = useState<{ id: string; extra: Extra } | null>(null);
  useEffect(() => {
    // Also skips a manual call's synthetic `manual-<timestamp>` id. Same test as
    // disposition-store's isUuid, not imported: that store imports this module's importer.
    if (!debtorId || !UUID_RE.test(debtorId)) return;
    let cancelled = false;
    fetchFullExtra([debtorId])
      .then((m) => {
        if (!cancelled && m.has(debtorId)) setFull({ id: debtorId, extra: m.get(debtorId)! });
      })
      .catch((e) => console.warn("[debtor-extra] full extra fetch failed:", e));
    return () => {
      cancelled = true;
    };
  }, [debtorId]);
  return full && full.id === debtorId ? full.extra : (partial ?? {});
}
