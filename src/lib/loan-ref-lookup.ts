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

/**
 * findDebtorByLoanReference(ref), falling back to a debounced database lookup. `looking` is true
 * while that lookup is pending, so the UI can say so instead of "No account matches" — which an
 * agent might otherwise dial on, logging the call unmapped.
 */
export function useLoanReferenceMatch(ref: string): { match: Match; looking: boolean } {
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const cached = findDebtorByLoanReference(ref);
  useEffect(() => {
    if (cached || !ref.trim()) return;
    let cancelled = false;
    const t = setTimeout(() => {
      resolveLoanReference(ref)
        .catch((e) => console.warn("[loan-ref-lookup] lookup failed:", e))
        .finally(() => {
          // Re-renders either way: a match is then found synchronously via the remembered map.
          if (!cancelled) setSettledFor(ref);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `cached` is derived from `ref`; re-running on its identity would re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, !!cached]);
  return { match: cached, looking: !cached && !!ref.trim() && settledFor !== ref };
}

// ─── Matching a dialled number to its borrower ──────────────────────────────────
// Manual Dial used to treat any number without a Loan ID as a stranger: the call screen showed
// no borrower, and the disposition was saved against no account, so it appeared on no history
// (2026-11-05: ~60% of manual calls were to numbers already in a portfolio). Now the typed
// number is looked up against every borrower the agent can see — primary and alternate
// numbers — and a match dials that account, exactly as if its Loan ID had been typed.

export type PhoneMatch = NonNullable<Match>;

/** The last 10 digits of an Indian number, or null if it has fewer. */
export function phoneKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function rowHasPhone(row: { phone?: string; altPhones?: string[] }, key: string): boolean {
  return [row.phone ?? "", ...(row.altPhones ?? [])].some((p) => phoneKey(p) === key);
}

/** Every open account (RLS decides which) whose primary or alternate number is `raw`. */
export async function resolvePhone(raw: string): Promise<PhoneMatch[]> {
  const key = phoneKey(raw);
  if (!key) return [];
  const scope: DebtorScope = { kind: "phone", phone: key };
  await refreshScopedPortfolios(scope);
  const out: PhoneMatch[] = [];
  for (const portfolio of getScopedPortfolios(scope)) {
    if (portfolio.closedAt) continue;
    for (const row of portfolio.rows) {
      if (!rowHasPhone(row, key)) continue;
      rememberLoanReferenceMatch(row, portfolio);
      const m = row.loanReference ? findDebtorByLoanReference(row.loanReference) : null;
      if (m && m.row.id === row.id) out.push(m);
    }
  }
  return out;
}

/** resolvePhone(phone), debounced while the agent types. `looking` while it is pending. */
export function usePhoneMatches(phone: string): { matches: PhoneMatch[]; looking: boolean } {
  const key = phoneKey(phone);
  const [result, setResult] = useState<{ key: string; matches: PhoneMatch[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const t = setTimeout(() => {
      resolvePhone(key)
        .then((matches) => {
          if (!cancelled) setResult({ key, matches });
        })
        .catch((e) => {
          console.warn("[loan-ref-lookup] phone lookup failed:", e);
          if (!cancelled) setResult({ key, matches: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);
  if (!key) return { matches: [], looking: false };
  if (result?.key !== key) return { matches: [], looking: true };
  return { matches: result.matches, looking: false };
}
