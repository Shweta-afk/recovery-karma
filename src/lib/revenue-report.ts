// Revenue reporting for the superadmin portal — what SamvadX has billed companies (GST tax
// invoices, see 20261006_invoices.sql), what has been received, what is still owed and how
// overdue, and the monthly GST figures for filing.
//
// This is SamvadX's OWN revenue from companies. It never touches anything a company collected
// from its borrowers (product decision, 2026-10-09).
//
// Pure: platform rows in, report out — the server file only fetches. Day boundaries are IST.

import type { DateRange } from "./date-filter";
import { istDayKey } from "./monthly-trend";

export type RevenueInvoiceStatus = "unpaid" | "paid" | "cancelled";

export interface RevenueInvoice {
  id: string;
  clientId: string;
  companyName: string;
  invoiceNumber: string;
  kind: string;
  /** "YYYY-MM-DD" (a DATE column — already a calendar day). */
  issueDate: string;
  dueDate: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  status: RevenueInvoiceStatus;
  paidAt: string | null;
  recipientName: string;
  recipientGstin: string | null;
  placeOfSupply: string;
}

export interface MoneyCount {
  count: number;
  total: number;
}

export const AGEING_BUCKETS = [
  { key: "notDue", label: "Not yet due" },
  { key: "d1_30", label: "1–30 days overdue" },
  { key: "d31_60", label: "31–60 days overdue" },
  { key: "d61_90", label: "61–90 days overdue" },
  { key: "d90plus", label: "Over 90 days overdue" },
] as const;
export type AgeingKey = (typeof AGEING_BUCKETS)[number]["key"];

export interface CompanyRevenue {
  clientId: string;
  companyName: string;
  billed: MoneyCount;
  received: MoneyCount;
  outstanding: MoneyCount;
  /** Days past due of this company's oldest unpaid invoice; 0 when nothing is overdue. */
  oldestOverdueDays: number;
}

export interface GstMonth {
  /** "YYYY-MM" of the invoice date. */
  month: string;
  invoices: number;
  cancelled: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface RevenueReport {
  range: DateRange;
  today: string;
  /** Issued in the range, not cancelled. */
  billed: MoneyCount & { taxable: number; gst: number };
  /** Marked paid with a paid date in the range. */
  received: MoneyCount;
  /** Every unpaid invoice as of today, whatever its date — what is owed right now. */
  outstanding: MoneyCount;
  overdue: MoneyCount;
  ageing: Record<AgeingKey, MoneyCount>;
  byKind: { kind: string; billed: MoneyCount }[];
  byCompany: CompanyRevenue[];
  gstMonthly: GstMonth[];
  /** Every invoice issued in the range, cancelled ones included — the register for filing. */
  register: RevenueInvoice[];
  /** Unpaid invoices as of today, most overdue first. */
  unpaid: (RevenueInvoice & { daysOverdue: number })[];
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const empty = (): MoneyCount => ({ count: 0, total: 0 });
const add = (m: MoneyCount, amount: number) => {
  m.count += 1;
  m.total = round2(m.total + amount);
};

/** Whole days from `a` to `b` ("YYYY-MM-DD"); positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY_MS,
  );
}

export function ageingKey(daysOverdue: number): AgeingKey {
  if (daysOverdue <= 0) return "notDue";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90plus";
}

const inRange = (day: string, r: DateRange) => day >= r.from && day <= r.to;

export function buildRevenueReport(
  invoices: RevenueInvoice[],
  range: DateRange,
  today: string,
): RevenueReport {
  const billed = { ...empty(), taxable: 0, gst: 0 };
  const received = empty();
  const outstanding = empty();
  const overdue = empty();
  const ageing = Object.fromEntries(AGEING_BUCKETS.map((b) => [b.key, empty()])) as Record<
    AgeingKey,
    MoneyCount
  >;
  const kinds = new Map<string, MoneyCount>();
  const companies = new Map<string, CompanyRevenue>();
  const months = new Map<string, GstMonth>();
  const register: RevenueInvoice[] = [];
  const unpaid: (RevenueInvoice & { daysOverdue: number })[] = [];

  const company = (inv: RevenueInvoice) => {
    let c = companies.get(inv.clientId);
    if (!c) {
      c = {
        clientId: inv.clientId,
        companyName: inv.companyName,
        billed: empty(),
        received: empty(),
        outstanding: empty(),
        oldestOverdueDays: 0,
      };
      companies.set(inv.clientId, c);
    }
    return c;
  };

  for (const inv of invoices) {
    const issuedInRange = inRange(inv.issueDate, range);

    if (issuedInRange) {
      register.push(inv);
      const month = inv.issueDate.slice(0, 7);
      let m = months.get(month);
      if (!m) {
        m = { month, invoices: 0, cancelled: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
        months.set(month, m);
      }
      if (inv.status === "cancelled") {
        m.cancelled += 1;
      } else {
        m.invoices += 1;
        m.taxable = round2(m.taxable + inv.taxable);
        m.cgst = round2(m.cgst + inv.cgst);
        m.sgst = round2(m.sgst + inv.sgst);
        m.igst = round2(m.igst + inv.igst);
        m.total = round2(m.total + inv.total);

        add(billed, inv.total);
        billed.taxable = round2(billed.taxable + inv.taxable);
        billed.gst = round2(billed.gst + inv.cgst + inv.sgst + inv.igst);
        add(kinds.get(inv.kind) ?? kinds.set(inv.kind, empty()).get(inv.kind)!, inv.total);
        add(company(inv).billed, inv.total);
      }
    }

    if (inv.status === "paid" && inv.paidAt && inRange(istDayKey(inv.paidAt), range)) {
      add(received, inv.total);
      add(company(inv).received, inv.total);
    }

    if (inv.status === "unpaid") {
      const daysOverdue = daysBetween(inv.dueDate, today);
      add(outstanding, inv.total);
      add(ageing[ageingKey(daysOverdue)], inv.total);
      const c = company(inv);
      add(c.outstanding, inv.total);
      if (daysOverdue > 0) {
        add(overdue, inv.total);
        c.oldestOverdueDays = Math.max(c.oldestOverdueDays, daysOverdue);
      }
      unpaid.push({ ...inv, daysOverdue });
    }
  }

  return {
    range,
    today,
    billed,
    received,
    outstanding,
    overdue,
    ageing,
    byKind: [...kinds.entries()].map(([kind, b]) => ({ kind, billed: b })),
    byCompany: [...companies.values()].sort(
      (a, b) =>
        b.outstanding.total - a.outstanding.total ||
        b.billed.total - a.billed.total ||
        a.companyName.localeCompare(b.companyName),
    ),
    gstMonthly: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    register: register.sort(
      (a, b) =>
        a.issueDate.localeCompare(b.issueDate) || a.invoiceNumber.localeCompare(b.invoiceNumber),
    ),
    unpaid: unpaid.sort((a, b) => b.daysOverdue - a.daysOverdue),
  };
}
