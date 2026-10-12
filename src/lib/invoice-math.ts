// Pure rules for SamvadX's GST tax invoices (superadmin → company). No imports, no I/O, so the
// browser, the server action that creates an invoice, and scripts/invoice-math.test.ts all use
// the same arithmetic. See migrations/20261006_invoices.sql for the tables.
//
// Every amount is in rupees with paise, rounded half-up to 2 decimals at each step the way the
// invoice prints it, so the stored total always equals the sum of the printed lines.

export type InvoiceKind = "insights_topup" | "setup" | "monthly";

/** One charged row on an invoice. Amounts are before GST. `quantity` × `rate` = `amount` when
 *  a line is priced per unit (e.g. 18 agent seats × ₹500); otherwise quantity prints as 1. */
export interface InvoiceLine {
  description: string;
  amount: number;
  quantity?: number;
  rate?: number;
  /** What the charge covers, printed as a list under it with no amounts of their own — the
   *  setup fee is ONE charge that includes several things (user, 2026-10-12). */
  includes?: string[];
}

export const SETUP_FEE_LABEL = "SamvadX platform setup";

/** What the setup fee covers, by default — listed under the one setup charge, not priced
 *  separately (user, 2026-10-12; until then each was its own charged line). */
export const SETUP_LINE_ITEMS = [
  "Domain Setup",
  "API Configuration",
  "Administrator Configuration",
  "Cloud Storage",
] as const;

/** The setup fee as one total plus what it includes. Price lists saved before 2026-10-12 hold one
 *  priced line per item; those read as their sum, with the items as the "includes". */
export function setupPackage(lines: InvoiceLine[]): { amount: number; includes: string[] } {
  if (lines.length === 1 && lines[0].includes) {
    return { amount: round2(lines[0].amount), includes: lines[0].includes };
  }
  return {
    amount: sumLines(lines.filter((l) => l.amount > 0)),
    includes: lines.map((l) => l.description).filter(Boolean),
  };
}

/** The one setup line stored on a price list and printed on a setup invoice. */
export function setupLine(amount: number, includes: string[]): InvoiceLine {
  const items = includes.map((i) => i.trim()).filter(Boolean);
  return {
    description: SETUP_FEE_LABEL,
    amount: round2(amount),
    ...(items.length ? { includes: items } : {}),
  };
}

/** Sum of the lines, rounded the way taxable_amount is stored. */
export function sumLines(lines: InvoiceLine[]): number {
  return round2(lines.reduce((s, l) => s + round2(l.amount), 0));
}

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  insights_topup: "Insights wallet top-up",
  setup: "Setup fee",
  monthly: "Monthly fee",
};

export const GST_RATE = 18;

/** GST state codes (the first two digits of a GSTIN). Place of supply is printed as
 * "Name (code)". 97 is "Other Territory"; 38 Ladakh. */
export const GST_STATES: { code: string; name: string }[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

export function stateName(code: string | null | undefined): string | null {
  return GST_STATES.find((s) => s.code === code)?.name ?? null;
}

/** 15 chars: 2-digit state, 10-char PAN, entity digit, 'Z', check char. Format only — the
 * checksum is not verified, so this catches typos in shape, not every typo. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normaliseGstin(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase();
}

/** The state a GSTIN is registered in, or null if it isn't a well-formed GSTIN. */
export function stateFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const g = normaliseGstin(gstin);
  if (!GSTIN_RE.test(g)) return null;
  return stateName(g.slice(0, 2)) ? g.slice(0, 2) : null;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface GstBreakdown {
  taxable: number;
  /** True when supplier and place of supply are in the same state → CGST + SGST. */
  intraState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

/** Splits 18% GST on a taxable value: same state → 9% CGST + 9% SGST, otherwise 18% IGST.
 * Amounts in our contracts are EXCLUSIVE of GST, so `taxable` is what the client agreed to pay
 * before tax. */
export function gstBreakdown(
  taxable: number,
  supplierStateCode: string,
  placeOfSupplyCode: string,
): GstBreakdown {
  const t = round2(taxable);
  const intraState = supplierStateCode === placeOfSupplyCode;
  const half = round2((t * GST_RATE) / 2 / 100);
  const cgst = intraState ? half : 0;
  const sgst = intraState ? half : 0;
  const igst = intraState ? 0 : round2((t * GST_RATE) / 100);
  return { taxable: t, intraState, cgst, sgst, igst, total: round2(t + cgst + sgst + igst) };
}

/** Indian financial year (April–March) of an IST calendar date "YYYY-MM-DD", as "2026-27". */
export function financialYear(istDate: string): string {
  const [y, m] = istDate.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** e.g. ("SX", "2026-27", 7) → "SX/2627/0007". GST caps invoice numbers at 16 characters and
 * requires them unique within a financial year; the FY is part of the number, and the sequence
 * restarts each April. */
export function formatInvoiceNumber(prefix: string, fy: string, seq: number): string {
  const fyShort = fy.replace(/^\d\d(\d\d)-(\d\d)$/, "$1$2");
  const no = `${prefix}/${fyShort}/${String(seq).padStart(4, "0")}`;
  if (no.length > 16) throw new Error(`Invoice number "${no}" is over GST's 16-character limit`);
  return no;
}

export const INVOICE_PREFIX_RE = /^[A-Z0-9]{1,5}$/;

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(" ");
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}

/** Indian numbering (lakh, crore): 11800.5 → "Rupees Eleven Thousand Eight Hundred and Fifty
 * Paise Only". */
export function amountInWords(amount: number): string {
  const paiseTotal = Math.round(round2(amount) * 100);
  let rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  rupees %= 10_000_000;
  const lakh = Math.floor(rupees / 100_000);
  rupees %= 100_000;
  const thousand = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rupees) parts.push(belowThousand(rupees));
  const r = parts.length ? parts.join(" ") : "Zero";
  return paise ? `Rupees ${r} and ${belowHundred(paise)} Paise Only` : `Rupees ${r} Only`;
}

/** Who an invoice is from / to, frozen onto the invoice when it is issued. */
export interface InvoiceParty {
  legalName: string;
  gstin: string | null;
  pan?: string | null;
  address: string;
  stateCode: string | null;
  email: string | null;
  phone?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  terms?: string | null;
}

export type InvoiceStatus = "unpaid" | "paid" | "cancelled";

export interface InvoiceRecord {
  id: string;
  clientId: string;
  invoiceNumber: string;
  kind: InvoiceKind;
  issueDate: string;
  dueDate: string;
  description: string;
  lines: InvoiceLine[];
  sac: string | null;
  placeOfSupply: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  supplier: InvoiceParty;
  recipient: InvoiceParty;
  walletLedgerId: string | null;
  status: InvoiceStatus;
  paidAt: string | null;
  /** "YYYY-MM" — the month a monthly invoice is for; null for other kinds. */
  periodMonth: string | null;
  notes: string | null;
  /** Printed under "Terms & disclaimer"; one paragraph per entry. */
  disclaimer: string[];
  createdAt: string;
  /** Delivery (migrations/20261012_billing_delivery.sql): when it was emailed, to whom and how,
   *  and when the company first opened it on Admin → Billing. Null until it happens. */
  emailedAt: string | null;
  emailedTo: string | null;
  emailedVia: "resend" | "mail_app" | null;
  viewedAt: string | null;
}

/** Maps an `invoices` row (snake_case, NUMERIC as string) to InvoiceRecord. */
export function toInvoiceRecord(r: {
  id: string;
  client_id: string;
  invoice_number: string;
  kind: string;
  issue_date: string;
  due_date: string;
  description: string;
  lines?: unknown;
  sac: string | null;
  place_of_supply: string;
  taxable_amount: number | string;
  cgst: number | string;
  sgst: number | string;
  igst: number | string;
  total: number | string;
  supplier: unknown;
  recipient: unknown;
  wallet_ledger_id: string | null;
  status: string;
  paid_at: string | null;
  period_month?: string | null;
  notes: string | null;
  disclaimer?: string | null;
  created_at: string;
  emailed_at?: string | null;
  emailed_to?: string | null;
  emailed_via?: string | null;
  viewed_at?: string | null;
}): InvoiceRecord {
  return {
    id: r.id,
    clientId: r.client_id,
    invoiceNumber: r.invoice_number,
    kind: r.kind as InvoiceKind,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    description: r.description,
    // Rows written before line items existed don't exist (the column shipped with the table),
    // but fall back to one line rather than printing an empty table if one ever lacks them.
    lines:
      Array.isArray(r.lines) && r.lines.length
        ? (
            r.lines as {
              description: string;
              amount: number | string;
              quantity?: number | string;
              rate?: number | string;
              includes?: unknown;
            }[]
          ).map((l) => ({
            description: String(l.description),
            amount: Number(l.amount),
            ...(l.quantity != null ? { quantity: Number(l.quantity) } : {}),
            ...(l.rate != null ? { rate: Number(l.rate) } : {}),
            ...(Array.isArray(l.includes) ? { includes: l.includes.map(String) } : {}),
          }))
        : [{ description: r.description, amount: Number(r.taxable_amount) }],
    sac: r.sac,
    placeOfSupply: r.place_of_supply,
    taxable: Number(r.taxable_amount),
    cgst: Number(r.cgst),
    sgst: Number(r.sgst),
    igst: Number(r.igst),
    total: Number(r.total),
    supplier: r.supplier as InvoiceParty,
    recipient: r.recipient as InvoiceParty,
    walletLedgerId: r.wallet_ledger_id,
    status: r.status as InvoiceStatus,
    paidAt: r.paid_at,
    periodMonth: r.period_month ?? null,
    notes: r.notes,
    disclaimer: r.disclaimer
      ? r.disclaimer.split("\n").filter(Boolean)
      : invoiceDisclaimer(r.kind as InvoiceKind, (r.supplier as InvoiceParty).legalName),
    createdAt: r.created_at,
    emailedAt: r.emailed_at ?? null,
    emailedTo: r.emailed_to ?? null,
    emailedVia: (r.emailed_via as InvoiceRecord["emailedVia"]) ?? null,
    viewedAt: r.viewed_at ?? null,
  };
}

/** Adds whole days to an ISO date "YYYY-MM-DD" (calendar arithmetic, no time zone involved). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** The "Terms & disclaimer" block printed on an invoice. Every point restates a clause of the
 * signed MSA (docs/agreements/SAMVADX_AXIOTTA_FINAL.docx — clause numbers below) rather than
 * adding new terms, so the invoice can never promise something the contract doesn't. The text
 * is saved onto each invoice when issued (invoices.disclaimer), so editing this later changes
 * new invoices only. */
export function invoiceDisclaimer(kind: InvoiceKind, supplierName: string): string[] {
  const common = [
    // MSA Annexure A, 3.2
    `Under the Digital Personal Data Protection Act, 2023, ${supplierName} acts as Data Processor and the client as Data Fiduciary (Data Controller). The client owns the portfolio data it uploads and is solely responsible for its accuracy, its lawful use and for obtaining borrower consent.`,
    // MSA 4.3
    "Data on SamvadX is visible only to the client's own authorised users. SamvadX does not sell or share the client's data with other clients.",
  ];
  const specific =
    kind === "insights_topup"
      ? [
          // MSA 5.2
          "Insights results are best-effort data enrichment from third-party sources and are suggestions only. Their accuracy or completeness is not guaranteed; verify independently before acting on them or taking legal action.",
          // Insights agreement 2.2; MSA 10.2
          "Each lookup is charged to the prepaid balance, including lookups that return no result. Prepaid balance is non-refundable; unused balance carries forward until the service ends.",
        ]
      : kind === "monthly"
        ? [
            // Restates nothing beyond what the invoice itself says — no MSA clause is cited
            // for monthly fees until the signed MSA's fee schedule is confirmed.
            "Monthly charges are for the month stated on this invoice, at the prices agreed in the client's commercial schedule.",
          ]
        : [
            // MSA 10.1
            "Setup fees are non-refundable once the service has commenced.",
          ];
  return [
    ...specific,
    ...common,
    "This invoice is issued under, and subject to, the SamvadX Master Service Agreement between the parties.",
  ];
}

// ── Price lists (client_price_lists) ────────────────────────────────────────

/** A company's prices, set once and reused by invoices and the contract schedule. Before GST. */
export interface PriceList {
  setupLines: InvoiceLine[];
  monthlyLines: InvoiceLine[];
  /** Per agent seat per month; 0 = no per-seat charge. */
  perSeatFee: number;
  /** null = the supplier default from billing_profile. */
  paymentTermsDays: number | null;
}

export const EMPTY_PRICE_LIST: PriceList = {
  setupLines: [],
  monthlyLines: [],
  perSeatFee: 0,
  paymentTermsDays: null,
};

/** "2026-10" → "October 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The lines of a monthly invoice: the fixed monthly lines, then seats × per-seat price. */
export function monthlyInvoiceLines(
  prices: PriceList,
  month: string,
  seats: number,
): InvoiceLine[] {
  const label = monthLabel(month);
  const lines: InvoiceLine[] = prices.monthlyLines
    .filter((l) => l.amount > 0)
    .map((l) => ({ description: `${l.description} — ${label}`, amount: round2(l.amount) }));
  if (prices.perSeatFee > 0 && seats > 0) {
    lines.push({
      description: `Agent seats — ${label}`,
      quantity: seats,
      rate: round2(prices.perSeatFee),
      amount: round2(seats * prices.perSeatFee),
    });
  }
  return lines;
}

const rupees = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Plain-language list of what changed between two price lists — the body of the draft
 *  contract change created when a superadmin saves new prices. Empty when nothing changed. */
export function priceListChanges(before: PriceList, after: PriceList): string[] {
  const out: string[] = [];
  const diffLines = (label: string, a: InvoiceLine[], b: InvoiceLine[]) => {
    const byName = (ls: InvoiceLine[]) => new Map(ls.map((l) => [l.description.trim(), l.amount]));
    const was = byName(a);
    const now = byName(b);
    for (const [name, amount] of now) {
      const old = was.get(name);
      if (old === undefined) out.push(`${label}: added "${name}" at ${rupees(amount)}`);
      else if (round2(old) !== round2(amount)) {
        out.push(`${label}: "${name}" ${rupees(old)} → ${rupees(amount)}`);
      }
    }
    for (const [name, amount] of was) {
      if (!now.has(name)) out.push(`${label}: removed "${name}" (was ${rupees(amount)})`);
    }
  };
  diffLines("Setup fee", before.setupLines, after.setupLines);
  diffLines("Monthly fee", before.monthlyLines, after.monthlyLines);
  if (round2(before.perSeatFee) !== round2(after.perSeatFee)) {
    out.push(
      `Price per agent seat per month: ${rupees(before.perSeatFee)} → ${rupees(after.perSeatFee)}`,
    );
  }
  if (before.paymentTermsDays !== after.paymentTermsDays) {
    const t = (d: number | null) => (d === null ? "standard terms" : `${d} days`);
    out.push(`Payment terms: ${t(before.paymentTermsDays)} → ${t(after.paymentTermsDays)}`);
  }
  return out;
}

// ── Payments and credit notes ───────────────────────────────────────────────

export type PaymentMethod = "bank_transfer" | "upi" | "cheque" | "cash" | "other";
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer (NEFT/RTGS/IMPS)",
  upi: "UPI",
  cheque: "Cheque",
  cash: "Cash",
  other: "Other",
};

export interface InvoicePayment {
  id: string;
  invoiceId: string;
  amount: number;
  receivedOn: string; // YYYY-MM-DD
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CreditNoteRecord {
  id: string;
  clientId: string;
  invoiceId: string;
  creditNoteNumber: string;
  issueDate: string;
  reason: string;
  lines: InvoiceLine[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  supplier: InvoiceParty;
  recipient: InvoiceParty;
  createdAt: string;
}

/** What is still owed on an invoice once credit notes and payments are taken off. */
export interface InvoiceBalance {
  /** Total less credit notes — what the company actually owes for this invoice. */
  net: number;
  credited: number;
  paid: number;
  /** net − paid; ≤ 0 means settled. */
  balance: number;
  settled: boolean;
}

export function invoiceBalance(
  invoice: Pick<InvoiceRecord, "total" | "status">,
  payments: Pick<InvoicePayment, "amount">[],
  credits: Pick<CreditNoteRecord, "total">[],
): InvoiceBalance {
  const credited = round2(credits.reduce((s, c) => s + c.total, 0));
  const net = invoice.status === "cancelled" ? 0 : round2(Math.max(0, invoice.total - credited));
  // Marked paid before payments were recorded individually: no payment rows, so take it as
  // paid in full rather than suddenly showing it as owed.
  const paid =
    invoice.status === "paid" && payments.length === 0
      ? net
      : round2(payments.reduce((s, p) => s + p.amount, 0));
  const balance = round2(net - paid);
  return { net, credited, paid, balance, settled: balance <= 0 };
}

/** Taxable value still available to credit on an invoice. */
export function creditableTaxable(
  invoice: Pick<InvoiceRecord, "taxable">,
  credits: Pick<CreditNoteRecord, "taxable">[],
): number {
  return round2(Math.max(0, invoice.taxable - credits.reduce((s, c) => s + c.taxable, 0)));
}
