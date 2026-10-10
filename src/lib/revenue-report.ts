// Revenue reporting for the superadmin portal — what SamvadX has billed companies (GST tax
// invoices, see 20261006_invoices.sql), what has been received, what is still owed and how
// overdue, and the monthly GST figures for filing.
//
// Since 2026-10-09 (migrations/20261009_billing_price_lists.sql):
//  * "Received" counts each recorded payment on the date the money ARRIVED (invoice_payments),
//    not when someone clicked "Mark paid". An invoice marked paid before payments were recorded
//    (no payment rows) still counts once, on its paid_at date.
//  * Credit notes reduce what was billed in the month THEY were issued (that is how GST treats
//    them), and reduce what is owed on the invoice they correct.
//
// This is SamvadX's OWN revenue from companies. It never touches anything a company collected
// from its borrowers (product decision, 2026-10-09).
//
// Pure: platform rows in, report out — the server file only fetches. Day boundaries are IST.

import type { DateRange } from "./date-filter";
import { istDayKey } from "./monthly-trend";
import { invoiceBalance } from "./invoice-math";

export type RevenueInvoiceStatus = "unpaid" | "paid" | "cancelled";

export interface RevenuePayment {
  amount: number;
  receivedOn: string; // YYYY-MM-DD
  method: string;
  reference: string | null;
}

export interface RevenueCreditNote {
  number: string;
  issueDate: string; // YYYY-MM-DD
  reason: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

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
  payments: RevenuePayment[];
  creditNotes: RevenueCreditNote[];
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
  credited: MoneyCount;
  received: MoneyCount;
  outstanding: MoneyCount;
  /** Days past due of this company's oldest unpaid invoice; 0 when nothing is overdue. */
  oldestOverdueDays: number;
}

export interface GstMonth {
  /** "YYYY-MM" — invoices by invoice date, credit notes by credit-note date. */
  month: string;
  invoices: number;
  cancelled: number;
  creditNotes: number;
  /** Invoices' taxable value, before credit notes. */
  invoiceTaxable: number;
  /** Credit notes' taxable value in the month (a reduction). */
  creditTaxable: number;
  /** Net of credit notes from here on. */
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface ReceivedPayment extends RevenuePayment {
  invoiceNumber: string;
  companyName: string;
}

export interface RevenueReport {
  range: DateRange;
  today: string;
  /** Issued in the range, not cancelled — before credit notes. */
  billed: MoneyCount & { taxable: number; gst: number };
  /** Credit notes issued in the range. */
  credited: MoneyCount & { taxable: number };
  /** billed − credited. */
  netBilled: number;
  /** Money that arrived in the range (by payment date). */
  received: MoneyCount;
  /** Every invoice with money still owed as of today, whatever its date — amounts are what is
   *  left after payments and credit notes. */
  outstanding: MoneyCount;
  overdue: MoneyCount;
  ageing: Record<AgeingKey, MoneyCount>;
  byKind: { kind: string; billed: MoneyCount }[];
  byCompany: CompanyRevenue[];
  gstMonthly: GstMonth[];
  /** Every invoice issued in the range, cancelled ones included — the register for filing. */
  register: RevenueInvoice[];
  /** Credit notes issued in the range, with the invoice each one corrects. */
  creditRegister: (RevenueCreditNote & {
    invoiceNumber: string;
    companyName: string;
    recipientName: string;
    recipientGstin: string | null;
  })[];
  /** Payments that arrived in the range. */
  receipts: ReceivedPayment[];
  /** Invoices still owed as of today, most overdue first; `due` is what is left to pay. */
  unpaid: (RevenueInvoice & { daysOverdue: number; due: number })[];
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
  const credited = { ...empty(), taxable: 0 };
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
  const creditRegister: RevenueReport["creditRegister"] = [];
  const receipts: ReceivedPayment[] = [];
  const unpaid: RevenueReport["unpaid"] = [];

  const company = (inv: RevenueInvoice) => {
    let c = companies.get(inv.clientId);
    if (!c) {
      c = {
        clientId: inv.clientId,
        companyName: inv.companyName,
        billed: empty(),
        credited: empty(),
        received: empty(),
        outstanding: empty(),
        oldestOverdueDays: 0,
      };
      companies.set(inv.clientId, c);
    }
    return c;
  };
  const month = (m: string) => {
    let g = months.get(m);
    if (!g) {
      g = {
        month: m,
        invoices: 0,
        cancelled: 0,
        creditNotes: 0,
        invoiceTaxable: 0,
        creditTaxable: 0,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total: 0,
      };
      months.set(m, g);
    }
    return g;
  };

  for (const inv of invoices) {
    if (inRange(inv.issueDate, range)) {
      register.push(inv);
      const m = month(inv.issueDate.slice(0, 7));
      if (inv.status === "cancelled") {
        m.cancelled += 1;
      } else {
        m.invoices += 1;
        m.invoiceTaxable = round2(m.invoiceTaxable + inv.taxable);
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

    // Credit notes count in the month they were issued, whatever the invoice's date.
    for (const cn of inv.creditNotes) {
      if (!inRange(cn.issueDate, range)) continue;
      const m = month(cn.issueDate.slice(0, 7));
      m.creditNotes += 1;
      m.creditTaxable = round2(m.creditTaxable + cn.taxable);
      m.taxable = round2(m.taxable - cn.taxable);
      m.cgst = round2(m.cgst - cn.cgst);
      m.sgst = round2(m.sgst - cn.sgst);
      m.igst = round2(m.igst - cn.igst);
      m.total = round2(m.total - cn.total);
      add(credited, cn.total);
      credited.taxable = round2(credited.taxable + cn.taxable);
      add(company(inv).credited, cn.total);
      creditRegister.push({
        ...cn,
        invoiceNumber: inv.invoiceNumber,
        companyName: inv.companyName,
        recipientName: inv.recipientName,
        recipientGstin: inv.recipientGstin,
      });
    }

    // Money received, by the day it arrived.
    if (inv.payments.length) {
      for (const p of inv.payments) {
        if (!inRange(p.receivedOn, range)) continue;
        add(received, p.amount);
        add(company(inv).received, p.amount);
        receipts.push({ ...p, invoiceNumber: inv.invoiceNumber, companyName: inv.companyName });
      }
    } else if (inv.status === "paid" && inv.paidAt && inRange(istDayKey(inv.paidAt), range)) {
      // Marked paid before payments were recorded individually.
      const amount = invoiceBalance(inv, [], inv.creditNotes).net;
      add(received, amount);
      add(company(inv).received, amount);
      receipts.push({
        amount,
        receivedOn: istDayKey(inv.paidAt),
        method: "other",
        reference: null,
        invoiceNumber: inv.invoiceNumber,
        companyName: inv.companyName,
      });
    }

    // What is still owed today, after payments and credit notes.
    if (inv.status !== "cancelled") {
      const due = invoiceBalance(inv, inv.payments, inv.creditNotes).balance;
      if (due > 0) {
        const daysOverdue = daysBetween(inv.dueDate, today);
        add(outstanding, due);
        add(ageing[ageingKey(daysOverdue)], due);
        const c = company(inv);
        add(c.outstanding, due);
        if (daysOverdue > 0) {
          add(overdue, due);
          c.oldestOverdueDays = Math.max(c.oldestOverdueDays, daysOverdue);
        }
        unpaid.push({ ...inv, daysOverdue, due });
      }
    }
  }

  return {
    range,
    today,
    billed,
    credited,
    netBilled: round2(billed.total - credited.total),
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
    creditRegister: creditRegister.sort((a, b) => a.issueDate.localeCompare(b.issueDate)),
    receipts: receipts.sort((a, b) => a.receivedOn.localeCompare(b.receivedOn)),
    unpaid: unpaid.sort((a, b) => b.daysOverdue - a.daysOverdue),
  };
}
