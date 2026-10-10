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
  supplierLegalName: string;
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
  { key: "company_address", meaning: "Billing address" },
  { key: "supplier_legal_name", meaning: "SamvadX's legal name (from Invoices → billing details)" },
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

const rupees = (n: number) =>
  `₹${round2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function linesTable(lines: InvoiceLine[], emptyText: string): string {
  const charged = lines.filter((l) => l.amount > 0);
  if (!charged.length) return emptyText;
  return [
    "| Item | Amount (before GST) |",
    ...charged.map((l) => `| ${l.description} | ${rupees(l.amount)} |`),
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
    supplier_legal_name: v.supplierLegalName || "SamvadX",
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
- Address: {{company_address}}

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
