// Lookups from earlier uploads of the same loan (user report, 2026-11-25: Rohit Tambe's
// "11 Nov 26" continued "9 NOV 26", and the 142 lookups on the old rows didn't show).
//
// Lookups are stored per debtor ROW, and every upload creates new rows, so a borrower's earlier
// lookups sit on the old upload's rows. The Insights tab shows them alongside, read-only. Nothing
// is copied or charged. Re-running a service still reuses the earlier result at ₹0
// (findReusableTrace).
//
// Same rule as the Feedback File: same loan ID AND the same borrower (same phone, or same name).
// A loan ID alone isn't enough, since two lenders can use the same loan-ID scheme.
import { normalisePhone } from "./billing";

export interface LoanRowKey {
  loanReference: string | null | undefined;
  name: string | null | undefined;
  phone: string | null | undefined;
}

export function loanKey(ref: string | null | undefined): string {
  return String(ref ?? "")
    .trim()
    .toLowerCase();
}

function nameKey(name: string | null | undefined): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** True when `other` is an earlier (or later) upload of the same loan for the same borrower. */
export function sameLoanAndBorrower(current: LoanRowKey, other: LoanRowKey): boolean {
  const loan = loanKey(current.loanReference);
  if (!loan || loan !== loanKey(other.loanReference)) return false;
  const phone = normalisePhone(current.phone);
  if (phone.length >= 10 && phone === normalisePhone(other.phone)) return true;
  const name = nameKey(current.name);
  return name.length > 0 && name === nameKey(other.name);
}
