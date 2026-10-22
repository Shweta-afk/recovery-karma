// Data purging certificates — pure rules shared by the server (data-purge.server.ts), the
// printed document (components/data-purge/) and scripts/data-purge.test.ts. No I/O.
//
// The letter is from SamvadX to the company, one per portfolio, modelled on the lender's own
// "Data Purging" letter (user's sample, 2026-10-20): subject "Data Purging <Month-YYYY>", the
// allocation by DPD bucket with accounts and outstanding, and an assurance that the data was
// purged. Issuing it deletes nothing (user's decision) — see migrations/20261020_data_purge_certificates.sql.

/** DPD buckets, in print order. Empty buckets are left off the certificate. */
export const PURGE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0-30", min: 0, max: 30 },
  { label: "31-60", min: 31, max: 60 },
  { label: "61-90", min: 61, max: 90 },
  { label: "91-120", min: 91, max: 120 },
  { label: "121-150", min: 121, max: 150 },
  { label: "151-180", min: 151, max: 180 },
  { label: "181-240", min: 181, max: 240 },
  { label: "241-300", min: 241, max: 300 },
  { label: "301-360", min: 301, max: 360 },
  { label: "361-500", min: 361, max: 500 },
  { label: "501+", min: 501, max: Number.POSITIVE_INFINITY },
];
export const NO_DPD_LABEL = "DPD not given";

export interface AllocationRow {
  bucket: string;
  accounts: number;
  outstanding: number;
}

export interface Allocation {
  rows: AllocationRow[];
  totalAccounts: number;
  totalOutstanding: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function bucketFor(dpd: number | null | undefined): string {
  if (dpd == null || !Number.isFinite(dpd) || dpd < 0) return NO_DPD_LABEL;
  const d = Math.floor(dpd);
  return PURGE_BUCKETS.find((b) => d >= b.min && d <= b.max)?.label ?? NO_DPD_LABEL;
}

/** Accounts and outstanding per DPD bucket, in bucket order, empty buckets dropped. */
export function buildAllocation(
  debtors: { dpd: number | null; outstanding: number | null }[],
): Allocation {
  const by = new Map<string, AllocationRow>();
  for (const d of debtors) {
    const bucket = bucketFor(d.dpd);
    const row = by.get(bucket) ?? { bucket, accounts: 0, outstanding: 0 };
    row.accounts += 1;
    row.outstanding = round2(row.outstanding + (Number(d.outstanding) || 0));
    by.set(bucket, row);
  }
  const order = [...PURGE_BUCKETS.map((b) => b.label), NO_DPD_LABEL];
  const rows = order.flatMap((label) => (by.has(label) ? [by.get(label)!] : []));
  return {
    rows,
    totalAccounts: rows.reduce((s, r) => s + r.accounts, 0),
    totalOutstanding: round2(rows.reduce((s, r) => s + r.outstanding, 0)),
  };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "April-2026" for an IST day key "2026-04-17" — the sample letter's style. */
export function purgePeriodLabel(dayKey: string): string {
  const [y, m] = dayKey.split("-").map(Number);
  return `${MONTHS[(m || 1) - 1]}-${y}`;
}

/** "05/05/2026" for "2026-05-05" — the sample letter's date style. */
export function formatLetterDate(dayKey: string): string {
  const [y, m, d] = dayKey.split("-");
  return `${d}/${m}/${y}`;
}

/** The parts of the letter a superadmin may change before issuing. */
export interface PurgeLetterFields {
  /** "YYYY-MM-DD" (IST). */
  letterDate: string;
  /** "April-2026" — the allocation month; prints in the subject and first paragraph. */
  period: string;
  /** Addressee lines under "To," — e.g. "The Authorised Signatory", company name, address. */
  toLines: string[];
  lenderName: string;
}

export interface PurgeParty {
  legalName: string;
  address: string;
}

/** Everything the printed certificate needs, frozen into data_purge_requests.certificate. */
export interface PurgeCertificate {
  letter: PurgeLetterFields;
  portfolioName: string;
  company: PurgeParty;
  supplier: PurgeParty & {
    signatoryName: string | null;
    signatoryDesignation: string | null;
  };
  allocation: Allocation;
}

export function defaultToLines(company: {
  legalName: string;
  address: string;
  signatoryDesignation?: string | null;
}): string[] {
  return [
    company.signatoryDesignation
      ? `The ${company.signatoryDesignation}`
      : "The Authorised Signatory",
    company.legalName,
    company.address,
  ].filter((l) => l.trim());
}

/** The letter's paragraphs, in order, with the table going after `beforeTable`. Kept here so a
 *  test can pin the wording and the printed copy and any future email say the same thing. */
export function purgeLetterText(c: PurgeCertificate): {
  subject: string;
  beforeTable: string[];
  tableCaption: string;
  afterTable: string[];
} {
  const lender = c.letter.lenderName.trim();
  return {
    subject: `Data Purging ${c.letter.period}`,
    beforeTable: [
      `This is to confirm that for the month of ${c.letter.period} we received from ${c.company.legalName} the allocation "${c.portfolioName}"${lender ? ` of ${lender}` : ""} for collection follow-ups and recovery for the following DPD's of cases.`,
      `We confirm that, post month end, we have deleted / purged all primary, secondary records / electronic records from our systems or data in custody of our people, including the confidential customer data Name, Address, Phone Number, E-Mail IDs, Outstanding etc.`,
      "Details of the allocation:",
    ],
    tableCaption: `Allocation Details${lender ? ` ${lender}` : ""} ${c.letter.period}`,
    afterTable: [
      "We assure you that customer data is not being used for any other purposes than those defined in the contract.",
      "Kindly acknowledge the same for your records and oblige. Thanking you,",
    ],
  };
}
