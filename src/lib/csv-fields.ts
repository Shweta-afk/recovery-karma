// Canonical debtor CSV fields — shared by the upload wizard (manager.upload.tsx) and the
// Edit Portfolio re-upload flow (manager.portfolio.tsx) so both map onto the exact same set.
// Keep in sync with column-mapper.ts's alias/detector specs, which key off these same names.
import type { MappingResult } from "./column-mapper";

// "required" here means the debtors table actually rejects the row without it (name and
// phone_primary are the only NOT NULL columns among these — see schema.sql). loan_id/amount/
// dpd are nullable/defaulted, so a blank cell there is a data-quality warning, not a reason
// to refuse the whole upload — a manager should be able to fix those later (Remap Fields, or
// a corrected re-upload) rather than being blocked from getting anything in at all.
export const STD_FIELDS = [
  { key: "loan_id", label: "Loan / Account ID", required: false },
  { key: "name", label: "Borrower Name", required: true },
  { key: "phone", label: "Phone Number", required: true },
  { key: "loan_amount", label: "Outstanding Amount", required: false },
  { key: "principal_amount", label: "Principal Amount", required: false },
  { key: "emi_amount", label: "EMI Amount", required: false },
  { key: "product_code", label: "Product Code", required: false },
  { key: "dpd", label: "Days Past Due", required: false },
  { key: "email", label: "Email Address", required: false },
  { key: "address", label: "Address", required: false },
  { key: "city", label: "City", required: false },
  { key: "state", label: "State", required: false },
  { key: "dob", label: "Date of Birth", required: false },
  { key: "employer", label: "Employer", required: false },
  { key: "income", label: "Monthly Income", required: false },
  { key: "language", label: "Preferred Language", required: false },
] as const;

export type StdFieldKey = (typeof STD_FIELDS)[number]["key"];

export const REQUIRED_STD_FIELDS = STD_FIELDS.filter((f) => f.required);

// Extract the chosen source header per field from a resolver result
export function mappingFromResult(result: MappingResult): Record<StdFieldKey, string> {
  const m = {} as Record<StdFieldKey, string>;
  for (const { key } of STD_FIELDS) m[key] = result[key]?.column ?? "";
  return m;
}

export type StdFieldSlots = Record<StdFieldKey, string>;

interface DebtorLike {
  loanReference: string;
  name: string;
  phone: string;
  loanAmount: number;
  principalAmount: number;
  emiAmount: number;
  productCode: string;
  dpd: number;
  email: string;
  extra: Record<string, string>;
}

/** Reads a debtor row's current values back into the same 15 "slots" the upload wizard's
 * mapping grid offers — used by the portfolio field-remap tool to fix a wrong original
 * mapping on data that's already imported, without needing the source CSV again. */
export function slotsFromDebtor(row: DebtorLike): StdFieldSlots {
  return {
    loan_id: row.loanReference,
    name: row.name,
    phone: row.phone,
    loan_amount: String(row.loanAmount),
    principal_amount: String(row.principalAmount),
    emi_amount: String(row.emiAmount),
    product_code: row.productCode,
    dpd: String(row.dpd),
    email: row.email,
    address: row.extra.address ?? "",
    city: row.extra.city ?? "",
    state: row.extra.state ?? "",
    dob: row.extra.dob ?? "",
    employer: row.extra.employer ?? "",
    income: row.extra.income ?? "",
    language: row.extra.language ?? "",
  };
}

// Extra sub-fields that always get their own STD_FIELD slot at import time (see
// CsvImportStep) — every OTHER key that ends up in `extra` is a column from the original file
// that was never mapped to any of our 13 canonical fields, still sitting there untouched under
// its literal header name.
const KNOWN_EXTRA_SUBFIELDS = new Set([
  "address",
  "city",
  "state",
  "dob",
  "employer",
  "income",
  "language",
]);

/** The original file columns a manager can still recover for remapping — every `extra` key
 * across a portfolio's rows that isn't one of the 7 STD_FIELDS that always reserve a slot
 * there. Used by the "Remap Fields" tool so it can offer the *actual* source columns, not just
 * our own 13 field labels. */
export function leftoverExtraKeys(rows: { extra: Record<string, string> }[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.extra ?? {})) {
      if (!KNOWN_EXTRA_SUBFIELDS.has(k)) keys.add(k);
    }
  }
  return Array.from(keys).sort();
}

// Prefix marking a remap source as a raw leftover file column (see leftoverExtraKeys) rather
// than one of the 12 canonical STD_FIELDS — keeps the two namespaces from colliding even if a
// file happens to have a column literally named e.g. "name".
const EXTRA_SOURCE_PREFIX = "extra:";

export function extraRemapSource(rawHeader: string): string {
  return EXTRA_SOURCE_PREFIX + rawHeader;
}

/** Resolves a Remap Fields source (either a StdFieldKey or an extraRemapSource()) to its
 * current value on one debtor row — shared by the live preview (manager.portfolio.tsx) and the
 * actual rewrite (remapPortfolioFields in portfolio-store.ts) so they never disagree. */
export function resolveRemapSource(
  source: string,
  slots: StdFieldSlots,
  extra: Record<string, string>,
): string {
  if (source.startsWith(EXTRA_SOURCE_PREFIX)) {
    return extra[source.slice(EXTRA_SOURCE_PREFIX.length)] ?? "";
  }
  return slots[source as StdFieldKey] ?? "";
}

/** Inverse of slotsFromDebtor: rebuilds debtor fields from a (possibly remapped) slot map,
 * applying the same numeric parsing the upload wizard uses for loan_amount/dpd. */
export function debtorFieldsFromSlots(slots: StdFieldSlots): DebtorLike {
  return {
    loanReference: slots.loan_id.trim(),
    name: slots.name.trim(),
    phone: slots.phone.trim(),
    loanAmount: parseFloat(slots.loan_amount.replace(/[,₹\s]/g, "")) || 0,
    principalAmount: parseFloat(slots.principal_amount.replace(/[,₹\s]/g, "")) || 0,
    emiAmount: parseFloat(slots.emi_amount.replace(/[,₹\s]/g, "")) || 0,
    productCode: slots.product_code.trim(),
    dpd: parseInt(slots.dpd, 10) || 0,
    email: slots.email.trim(),
    extra: {
      address: slots.address,
      city: slots.city,
      state: slots.state,
      dob: slots.dob,
      employer: slots.employer,
      income: slots.income,
      language: slots.language,
    },
  };
}
