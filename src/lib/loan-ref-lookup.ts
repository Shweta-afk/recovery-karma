// Resolving a typed Loan/Account ID to its account without a full debtor sync (growth plan #3).
//
// findDebtorByLoanReference() (portfolio-store.ts) searches the full-sync portfolio cache. That
// cache used to be filled as a side effect of the agent dashboard's refreshPortfolios(); with
// that gone, Manual Dial and the call panel's "attach to Loan ID" field would only find accounts
// if some other page had synced first. This hook keeps the instant cache answer and, when the
// cache has nothing, asks the database for that one ID — then records the match so the
// synchronous lookup at disposition-save time (dashboard.call-queue.tsx) resolves it too.
import { useEffect, useState } from "react";
import { findDebtorByLoanReference, rememberLoanReferenceMatch } from "./portfolio-store";
import { getScopedPortfolios, refreshScopedPortfolios, type DebtorScope } from "./scoped-debtors";

type Match = ReturnType<typeof findDebtorByLoanReference>;

/** Waits for the agent to pause typing, so a 15-character ID is one request, not fifteen. */
const DEBOUNCE_MS = 350;

/**
 * The ID as a case-insensitive exact-match ILIKE pattern, or null when it can't be expressed as
 * one safely. `%`/`_`/`\` are escaped; `*` is refused outright because PostgREST treats it as a
 * wildcard with no escape. Loan IDs are alphanumeric in practice, so a refusal just means "no
 * database lookup" — the cache answer still applies.
 */
function exactIlikePattern(ref: string): string | null {
  if (!ref || ref.includes("*")) return null;
  return ref.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Looks the ID up in the database if the cache doesn't have it. Resolves to the match, or null. */
export async function resolveLoanReference(ref: string): Promise<Match> {
  const cached = findDebtorByLoanReference(ref);
  if (cached) return cached;
  const trimmed = ref.trim();
  const pattern = exactIlikePattern(trimmed);
  if (!pattern) return null;

  const scope: DebtorScope = { kind: "loanRef", loanRef: pattern };
  await refreshScopedPortfolios(scope);
  const needle = trimmed.toLowerCase();
  for (const portfolio of getScopedPortfolios(scope)) {
    // Same exclusions the cache applies: removed accounts are filtered by the query itself, and
    // a closed cycle's rows are never materialised there. (A portfolio merely past its end
    // date IS in the cache, so it is not excluded here either.)
    if (portfolio.closedAt) continue;
    const row = portfolio.rows.find((r) => (r.loanReference ?? "").trim().toLowerCase() === needle);
    if (row) {
      rememberLoanReferenceMatch(row, portfolio);
      return findDebtorByLoanReference(ref);
    }
  }
  return null;
}

/** findDebtorByLoanReference(ref), falling back to a debounced database lookup. */
export function useLoanReferenceMatch(ref: string): Match {
  const [, setResolved] = useState(0);
  const cached = findDebtorByLoanReference(ref);
  useEffect(() => {
    if (cached || !ref.trim()) return;
    let cancelled = false;
    const t = setTimeout(() => {
      resolveLoanReference(ref)
        .then((m) => {
          if (!cancelled && m) setResolved((n) => n + 1);
        })
        .catch((e) => console.warn("[loan-ref-lookup] lookup failed:", e));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `cached` is derived from `ref`; re-running on its identity would re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, !!cached]);
  return cached;
}
