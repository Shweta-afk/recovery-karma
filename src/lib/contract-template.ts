// Contract templates: one text with {{placeholders}}, filled per company from its billing
// details, price list, seats and Insights prices — so the commercial schedule that changes per
// company is generated, not re-uploaded. The common legal terms stay an uploaded document
// (the platform terms). Pure: contracts.server.ts gathers the values, this fills them.
//
// Body format (kept deliberately small so anyone can edit it in a textarea):
//   "# Heading", "## Subheading", "- bullet", "| a | b |" table rows, blank line = new paragraph.
// Table placeholders expand to "| … |" rows, so they render as tables.

import { round2, sumLines, type InvoiceLine, type PriceList } from "./invoice-math";

export interface TemplateValues {
  companyName: string;
  companyLegalName: string;
  companyGstin: string | null;
  companyAddress: string;
  /** Filled in by the company's admin on Admin → Settings (company-details.ts). Optional so
   *  older callers and tests keep working; blank prints "—". */
  companyPan?: string;
  companyCin?: string;
  companyEmail?: string;
  companyPhone?: string;
  companySignatoryName?: string;
  companySignatoryDesignation?: string;
  supplierLegalName: string;
  /** SamvadX's own company, from Superadmin → Invoices → SamvadX details (billing_profile). */
  supplierShortName?: string;
  supplierCin?: string;
  supplierPan?: string;
  supplierGstin?: string | null;
  supplierAddress?: string;
  supplierSignatoryName?: string;
  supplierSignatoryDesignation?: string;
  /** Filled when the company signs (frozen into the signed copy); blanks until then. */
  signedBy?: string;
  signedDate?: string;
  effectiveDate: string; // already formatted for print
  today: string;
  prices: PriceList;
  paymentTermsDays: number;
  agentSeatLimit: number | null;
  managerSeatLimit: number | null;
  /** [service label, what this company pays] for each Insights service on its plan. */
  insightsPrices: [string, string][];
}

export const PLACEHOLDERS: { key: string; meaning: string }[] = [
  { key: "company_name", meaning: "Company name as shown in SamvadX" },
  { key: "company_legal_name", meaning: "Legal name from the company's billing details" },
  { key: "company_gstin", meaning: "Company GSTIN (or 'Unregistered')" },
  { key: "company_address", meaning: "Registered address, with city, state and PIN" },
  { key: "company_pan", meaning: "Company PAN" },
  { key: "company_cin", meaning: "CIN / LLPIN (or 'Not applicable')" },
  { key: "company_email", meaning: "Billing email" },
  { key: "company_phone", meaning: "Billing phone" },
  { key: "company_signatory_name", meaning: "Who signs for the company" },
  { key: "company_signatory_designation", meaning: "The signatory's designation" },
  { key: "supplier_legal_name", meaning: "Your company's legal name (Invoices → SamvadX details)" },
  {
    key: "supplier_short_name",
    meaning: "Your company's short name used through the agreement, e.g. Axiotta",
  },
  { key: "supplier_short_name_caps", meaning: "The same short name in CAPITALS" },
  { key: "supplier_cin", meaning: "Your company's CIN" },
  {
    key: "supplier_entity",
    meaning: "What your business is, from its CIN/PAN — e.g. 'a sole proprietorship (PAN: …)'",
  },
  {
    key: "company_entity",
    meaning:
      "What the company is, from its CIN/PAN — e.g. 'a company incorporated in India (CIN: …)'",
  },
  { key: "supplier_address", meaning: "Your company's registered address" },
  { key: "supplier_signatory_name", meaning: "Who signs for your company" },
  { key: "supplier_signatory_designation", meaning: "Their designation" },
  {
    key: "signed_by",
    meaning: "The name the client's admin typed when signing (blank until signed)",
  },
  { key: "signed_date", meaning: "The date the client signed (blank until signed)" },
  { key: "effective_date", meaning: "The date this schedule takes effect" },
  { key: "today", meaning: "Today's date" },
  { key: "setup_fee_table", meaning: "Table of setup fee lines with a total" },
  { key: "setup_fee_total", meaning: "Total setup fee" },
  { key: "monthly_fee_table", meaning: "Table of monthly fee lines" },
  { key: "monthly_fee_total", meaning: "Total fixed monthly fee" },
  { key: "per_seat_fee", meaning: "Price per agent seat per month" },
  { key: "agent_seats", meaning: "Agent seat limit (or 'Unlimited')" },
  { key: "manager_seats", meaning: "Manager seat limit (or 'Unlimited')" },
  { key: "insights_price_table", meaning: "Table of Insights services and their prices" },
  { key: "payment_terms_days", meaning: "Days to pay an invoice" },
];

/** The 4th character of an Indian PAN says who holds it: P = an individual (so a proprietorship
 *  when it's a business's PAN), F = a firm or LLP, C = a company. */
const PAN_HOLDER: Record<string, string> = {
  P: "a sole proprietorship",
  F: "a partnership firm / LLP",
  C: "a company incorporated in India",
};

/** How a party is described in the agreement's opening, from what it actually is: a CIN means a
 *  company or LLP; otherwise the PAN says (a proprietor has no CIN, so "a company incorporated
 *  under the Companies Act" would be untrue for one). */
export function entityPhrase(p: {
  cin?: string | null;
  pan?: string | null;
  gstin?: string | null;
  /** Printed in place of a missing GSTIN (default "Unregistered"). */
  gstinUnregistered?: string;
}): string {
  const cin = p.cin?.trim();
  const pan = p.pan?.trim().toUpperCase();
  const gstin = p.gstin?.trim() || p.gstinUnregistered || "Unregistered";
  if (cin) {
    const kind = /^[A-Z]{3}-\d{4}$/.test(cin)
      ? "a limited liability partnership"
      : "a company incorporated in India";
    return `${kind} (CIN / LLPIN: ${cin}; PAN: ${pan || "—"}; GSTIN: ${gstin})`;
  }
  const kind = (pan && PAN_HOLDER[pan[3]]) || "a business registered in India";
  const panLabel = pan?.[3] === "P" ? "Proprietor PAN" : "PAN";
  return `${kind} (${panLabel}: ${pan || "—"}; GSTIN: ${gstin})`;
}

const rupees = (n: number) =>
  `₹${round2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function linesTable(lines: InvoiceLine[], emptyText: string): string {
  const charged = lines.filter((l) => l.amount > 0);
  if (!charged.length) return emptyText;
  return [
    "| Item | Amount (before GST) |",
    ...charged.map(
      (l) =>
        `| ${l.description}${l.includes?.length ? ` — includes ${l.includes.join(", ")}` : ""} | ${rupees(l.amount)} |`,
    ),
    `| **Total** | **${rupees(sumLines(charged))}** |`,
  ].join("\n");
}

export function templateValueMap(v: TemplateValues): Record<string, string> {
  const seats = (n: number | null) => (n === null ? "Unlimited" : String(n));
  return {
    company_name: v.companyName,
    company_legal_name: v.companyLegalName || v.companyName,
    company_gstin: v.companyGstin || "Unregistered",
    company_address: v.companyAddress || "—",
    company_pan: v.companyPan || "—",
    company_cin: v.companyCin || "Not applicable",
    company_email: v.companyEmail || "—",
    company_phone: v.companyPhone || "—",
    company_signatory_name: v.companySignatoryName || "—",
    company_signatory_designation: v.companySignatoryDesignation || "—",
    supplier_legal_name: v.supplierLegalName || "SamvadX",
    supplier_short_name: v.supplierShortName || v.supplierLegalName || "SamvadX",
    supplier_short_name_caps: (
      v.supplierShortName ||
      v.supplierLegalName ||
      "SamvadX"
    ).toUpperCase(),
    supplier_cin: v.supplierCin || "—",
    supplier_entity: entityPhrase({
      cin: v.supplierCin,
      pan: v.supplierPan,
      gstin: v.supplierGstin,
      gstinUnregistered: "Not registered",
    }),
    company_entity: entityPhrase({ cin: v.companyCin, pan: v.companyPan, gstin: v.companyGstin }),
    supplier_address: v.supplierAddress || "—",
    supplier_signatory_name: v.supplierSignatoryName || "____________________",
    supplier_signatory_designation: v.supplierSignatoryDesignation || "____________________",
    signed_by: v.signedBy || "____________________",
    signed_date: v.signedDate || "____________________",
    effective_date: v.effectiveDate,
    today: v.today,
    setup_fee_table: linesTable(v.prices.setupLines, "No setup fee."),
    setup_fee_total: rupees(sumLines(v.prices.setupLines.filter((l) => l.amount > 0))),
    monthly_fee_table: linesTable(v.prices.monthlyLines, "No fixed monthly fee."),
    monthly_fee_total: rupees(sumLines(v.prices.monthlyLines.filter((l) => l.amount > 0))),
    per_seat_fee: v.prices.perSeatFee > 0 ? rupees(v.prices.perSeatFee) : "No per-seat charge",
    agent_seats: seats(v.agentSeatLimit),
    manager_seats: seats(v.managerSeatLimit),
    insights_price_table: v.insightsPrices.length
      ? [
          "| Insights service | Price per lookup (before GST) |",
          ...v.insightsPrices.map(([s, p]) => `| ${s} | ${p} |`),
        ].join("\n")
      : "No Insights services on this plan.",
    payment_terms_days: String(v.paymentTermsDays),
  };
}

/** Fills {{placeholders}}. Unknown ones are left in place and reported, so a typo is visible
 *  in the preview instead of silently printing nothing. */
export function fillTemplate(
  body: string,
  values: Record<string, string>,
): { text: string; unknown: string[] } {
  const unknown = new Set<string>();
  const text = body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => {
    if (key in values) return values[key];
    unknown.add(key);
    return whole;
  });
  return { text, unknown: [...unknown] };
}

/** A starting point for the per-company commercial schedule. Edit freely on the Contracts page. */
export const DEFAULT_TEMPLATE_TITLE = "Commercial Schedule";
export const DEFAULT_TEMPLATE_BODY = `# Commercial Schedule

This schedule forms part of the SamvadX Master Service Agreement between {{supplier_legal_name}} ("SamvadX") and {{company_legal_name}} ("the Client"), and takes effect from {{effective_date}}.

## Client

- Legal name: {{company_legal_name}}
- GSTIN: {{company_gstin}}
- PAN: {{company_pan}}
- CIN / LLPIN: {{company_cin}}
- Address: {{company_address}}
- Billing contact: {{company_email}}, {{company_phone}}
- Authorised signatory: {{company_signatory_name}}, {{company_signatory_designation}}

## One-time setup fee

{{setup_fee_table}}

## Monthly fees

{{monthly_fee_table}}

- Price per agent seat per month: {{per_seat_fee}}
- Agent seats: {{agent_seats}}
- Manager seats: {{manager_seats}}

## Insights (pay per lookup, from the prepaid Insights wallet)

{{insights_price_table}}

## Payment

- All amounts are before GST; GST is charged as applicable.
- Invoices are payable within {{payment_terms_days}} days of the invoice date.

Prepared on {{today}}.`;

// ── Rendering ────────────────────────────────────────────────────────────────

export type TemplateBlock =
  | { type: "h1" | "h2" | "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "table"; rows: string[][] };

/** Splits filled text into blocks for display/print. */
export function parseTemplateBlocks(text: string): TemplateBlock[] {
  const blocks: TemplateBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      blocks.push({ type: "h2", text: line.slice(3) });
    } else if (line.startsWith("# ")) {
      flush();
      blocks.push({ type: "h1", text: line.slice(2) });
    } else if (line.startsWith("- ")) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.type === "ul") last.items.push(line.slice(2));
      else blocks.push({ type: "ul", items: [line.slice(2)] });
    } else if (line.startsWith("|") && line.endsWith("|")) {
      flush();
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      const last = blocks[blocks.length - 1];
      if (last?.type === "table") last.rows.push(cells);
      else blocks.push({ type: "table", rows: [cells] });
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}
