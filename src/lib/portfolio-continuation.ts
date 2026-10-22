// Guards for "Continues portfolio" on the upload page. Picking an old portfolio there closes it
// the moment the new file is saved (createPortfolio in portfolio-store.ts), and a closed
// portfolio drops out of the call queue and every working list. On 2026-10-22 a one-account
// RBL test file was saved as continuing "AU BANK" (594 accounts, 470 lookups), which then looked
// deleted. Pure — tested in scripts/portfolio-continuation.test.ts.

/** Words that don't tell two lenders apart: "AU Bank" and "AU BANK LTD" are the same lender. */
const FILLER = new Set(["bank", "ltd", "limited", "pvt", "private", "the", "finance", "fin"]);

/** "AU Small Finance Bank Ltd." → "ausmall"; used only to compare two lender names. */
export function normaliseLender(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !FILLER.has(w))
    .join("");
}

/** True when both lender names are filled in and plainly name different lenders. A blank on
 *  either side says nothing, so it is not called a mismatch. */
export function lendersDiffer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normaliseLender(a);
  const y = normaliseLender(b);
  if (!x || !y) return false;
  return !(x === y || x.startsWith(y) || y.startsWith(x));
}

/** What closing a portfolio puts out of sight, for the confirmation. */
export interface PortfolioFootprint {
  accounts: number;
  lookups: number;
  calls: number;
}

/** "594 accounts, 470 Insights lookups and 12 calls" — only the parts that are non-zero. */
export function describeFootprint(f: PortfolioFootprint): string {
  const parts = [
    `${f.accounts.toLocaleString("en-IN")} account${f.accounts === 1 ? "" : "s"}`,
    f.lookups > 0 &&
      `${f.lookups.toLocaleString("en-IN")} Insights lookup${f.lookups === 1 ? "" : "s"}`,
    f.calls > 0 && `${f.calls.toLocaleString("en-IN")} call${f.calls === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : parts[0];
}
