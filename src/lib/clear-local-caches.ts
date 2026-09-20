// The stores cache portfolios, debtors (names, phone numbers, balances), call logs and payments
// in localStorage — measured at several MB. On a shared or lost machine that is a full copy of
// the book of business sitting there after the agent "logged out". Called on logout, on a forced
// sign-out, and before a fresh login so one user's data is never left for the next.
//
// Everything is removed except the theme preference. The in-memory copies inside the stores die
// with a full page load, so callers that navigate away should do it with location.replace().

const KEEP = new Set(["theme"]);

export function clearLocalCaches(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!KEEP.has(key)) localStorage.removeItem(key);
    }
    sessionStorage.clear();
  } catch {
    // Storage blocked / unavailable (private mode, SSR) — nothing was cached there to clear.
  }
}
