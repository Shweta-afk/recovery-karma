// debtorId -> loan amount ("POS") for exactly the accounts a report's calls and payments name —
// the POS Worked / POS Promised trend metrics (growth plan #3).
//
// The Reports pages used to build this with portfolio-store.ts's posByDebtorMap(), which needs
// the full-sync portfolio cache: every debtor the viewer can see, to look up the few hundred
// that actually have activity. This fetches those ids only.
//
// Same answer as posByDebtorMap(), rule for rule — so no report figure moves:
//   * only accounts the viewer can see (RLS, as before),
//   * status not 'removed' (the cache dropped removed rows),
//   * portfolio not closed (the cache carried a closed portfolio's rows as []),
//   * an account missing from the map contributes 0 (the metrics already treat it that way).
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

/** Ids per request — keeps the `id=in.(...)` URL a sane size; same figure debtors-fetch uses. */
const ID_CHUNK = 300;

export async function fetchPosByDebtor(ids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, number>();
  if (!unique.length) return out;

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) chunks.push(unique.slice(i, i + ID_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) =>
      supabase.from("debtors").select("id, loan_amount, status, portfolio_id").in("id", chunk),
    ),
  );
  const rows: {
    id: string;
    loan_amount: number | null;
    status: string | null;
    portfolio_id: string | null;
  }[] = [];
  for (const r of results) {
    if (r.error) throw r.error;
    rows.push(...((r.data ?? []) as typeof rows));
  }

  const portfolioIds = [
    ...new Set(rows.map((r) => r.portfolio_id).filter((x): x is string => !!x)),
  ];
  const closed = new Set<string>();
  if (portfolioIds.length) {
    const { data, error } = await supabase
      .from("portfolios")
      .select("id, closed_at")
      .in("id", portfolioIds);
    if (error) throw error;
    for (const p of (data ?? []) as { id: string; closed_at: string | null }[])
      if (p.closed_at) closed.add(p.id);
    // A portfolio the viewer can't see was never in the cache either — its accounts drop out.
    const visible = new Set(((data ?? []) as { id: string }[]).map((p) => p.id));
    for (const id of portfolioIds) if (!visible.has(id)) closed.add(id);
  }

  for (const r of rows) {
    if (r.status === "removed") continue;
    if (!r.portfolio_id || closed.has(r.portfolio_id)) continue;
    out.set(r.id, Number(r.loan_amount ?? 0));
  }
  return out;
}

/**
 * fetchPosByDebtor() for the debtor ids a report is showing, re-fetched when that set changes.
 * Empty until the first answer lands — the POS metrics read an absent account as 0, which is
 * what they showed before the full sync used to land, too.
 */
export function usePosByDebtor(debtorIds: (string | undefined)[]): Map<string, number> {
  const key = [...new Set(debtorIds.filter((x): x is string => !!x))].sort().join(",");
  const [map, setMap] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetchPosByDebtor(key ? key.split(",") : [])
      .then((m) => {
        if (!cancelled) setMap(m);
      })
      .catch((e) => console.warn("[pos-lookup] fetch failed:", e));
    return () => {
      cancelled = true;
    };
  }, [key]);
  return map;
}
