// Superadmin billing actions beyond issuing invoices (invoice-actions.server.ts): each company's
// price list, payments as they arrive, and GST credit notes. Tables from
// migrations/20261009_billing_price_lists.sql — server-only, service role after
// verifySuperadminCaller. Arithmetic is in the pure invoice-math.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, amountSchema } from "./schemas";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { createPriceChangeDraft } from "./contracts.server";
import { todayIstKey } from "./date-filter";
import { isDayKey } from "./superadmin-range";
import { loadPriceList, toPriceLines } from "./price-list.server";
import {
  creditableTaxable,
  financialYear,
  gstBreakdown,
  invoiceBalance,
  priceListChanges,
  round2,
  toInvoiceRecord,
  type CreditNoteRecord,
  type InvoiceParty,
  type InvoicePayment,
  type PaymentMethod,
  type PriceList,
} from "./invoice-math";
import { appError } from "./app-error";

const db = () => getSupabaseAdmin();
/** The new tables aren't in the generated Database types until they are regenerated after the
 *  migration — read and write them through an untyped client meanwhile. */
const raw = () => getSupabaseAdmin() as unknown as SupabaseClient;

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Not authenticated as superadmin");
  return caller;
}

const daySchema = z.string().refine(isDayKey, "Expected a date (YYYY-MM-DD)");
const priceLineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  amount: z.number().finite().min(0).max(100_000_000),
  includes: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
});

const toLines = toPriceLines;

// ── Price lists ──────────────────────────────────────────────────────────────

export const savePriceList = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        setupLines: z.array(priceLineSchema).max(20),
        monthlyLines: z.array(priceLineSchema).max(20),
        perSeatFee: z.number().finite().min(0).max(10_000_000),
        paymentTermsDays: z.number().int().min(0).max(365).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const before = await loadPriceList(data.clientId);
    const after: PriceList = {
      setupLines: data.setupLines.map((l) => ({ ...l, amount: round2(l.amount) })),
      monthlyLines: data.monthlyLines.map((l) => ({ ...l, amount: round2(l.amount) })),
      perSeatFee: round2(data.perSeatFee),
      paymentTermsDays: data.paymentTermsDays,
    };
    const { error } = await raw().from("client_price_lists").upsert({
      client_id: data.clientId,
      setup_lines: after.setupLines,
      monthly_lines: after.monthlyLines,
      per_seat_fee: after.perSeatFee,
      payment_terms_days: after.paymentTermsDays,
      updated_at: new Date().toISOString(),
      updated_by: caller.superadminId,
    });
    if (error) throw appError("SX-4201", "Could not save the price list.", error);

    const changes = priceListChanges(before, after);
    // Only a price list that existed before is a "change" worth a contract update — filling one
    // in for the first time is setting it up, which the contract schedule covers.
    const hadPrices =
      before.setupLines.length > 0 ||
      before.monthlyLines.length > 0 ||
      before.perSeatFee > 0 ||
      before.paymentTermsDays !== null;
    let draftId: string | null = null;
    if (changes.length && hadPrices) {
      draftId = await createPriceChangeDraft(caller.superadminId, data.clientId, changes);
    }
    if (changes.length) {
      void logSuperadminActivity({
        superadminId: caller.superadminId,
        action: "price_list_set",
        clientId: data.clientId,
        summary: `Updated the price list (${changes.length} change${changes.length === 1 ? "" : "s"})`,
        detail: { changes },
      });
    }
    return { changes, draftId };
  });

// ── Payments and credit notes for one invoice ───────────────────────────────

interface PaymentRow {
  id: string;
  invoice_id: string;
  amount: number | string;
  received_on: string;
  method: string;
  reference: string | null;
  notes: string | null;
  created_at: string;
}
interface CreditNoteRow {
  id: string;
  client_id: string;
  invoice_id: string;
  credit_note_number: string;
  issue_date: string;
  reason: string;
  lines: unknown;
  taxable_amount: number | string;
  cgst: number | string;
  sgst: number | string;
  igst: number | string;
  total: number | string;
  supplier: unknown;
  recipient: unknown;
  created_at: string;
}

const toPayment = (r: PaymentRow): InvoicePayment => ({
  id: r.id,
  invoiceId: r.invoice_id,
  amount: Number(r.amount),
  receivedOn: r.received_on,
  method: r.method as PaymentMethod,
  reference: r.reference,
  notes: r.notes,
  createdAt: r.created_at,
});
export const toCreditNote = (r: CreditNoteRow): CreditNoteRecord => ({
  id: r.id,
  clientId: r.client_id,
  invoiceId: r.invoice_id,
  creditNoteNumber: r.credit_note_number,
  issueDate: r.issue_date,
  reason: r.reason,
  lines: toLines(r.lines),
  taxable: Number(r.taxable_amount),
  cgst: Number(r.cgst),
  sgst: Number(r.sgst),
  igst: Number(r.igst),
  total: Number(r.total),
  supplier: r.supplier as InvoiceParty,
  recipient: r.recipient as InvoiceParty,
  createdAt: r.created_at,
});

async function loadInvoiceLedger(invoiceId: string) {
  const [inv, pay, cn] = await Promise.all([
    db().from("invoices").select("*").eq("id", invoiceId).maybeSingle(),
    raw()
      .from("invoice_payments")
      .select("id, invoice_id, amount, received_on, method, reference, notes, created_at")
      .eq("invoice_id", invoiceId)
      .order("received_on", { ascending: true }),
    raw()
      .from("credit_notes")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("issue_date", { ascending: true }),
  ]);
  if (inv.error || !inv.data) throw new Error("Invoice not found");
  if (pay.error) throw appError("SX-4202", "Could not load payments.", pay.error);
  if (cn.error) throw appError("SX-4203", "Could not load credit notes.", cn.error);
  const invoice = toInvoiceRecord(inv.data);
  const payments = ((pay.data ?? []) as PaymentRow[]).map(toPayment);
  const creditNotes = ((cn.data ?? []) as CreditNoteRow[]).map(toCreditNote);
  return {
    invoice,
    payments,
    creditNotes,
    balance: invoiceBalance(invoice, payments, creditNotes),
    creditable: creditableTaxable(invoice, creditNotes),
  };
}

/** Sets invoices.status from what has been paid: 'paid' (dated the last payment) once payments
 *  cover the amount due, else 'unpaid'. Cancelled invoices are left alone. */
async function syncInvoiceStatus(invoiceId: string) {
  const { invoice, payments, balance } = await loadInvoiceLedger(invoiceId);
  if (invoice.status === "cancelled") return;
  const settledByPayments = payments.length > 0 && balance.settled;
  // Fully credited with nothing paid also needs no more money — mark it settled.
  const settled = settledByPayments || (balance.net === 0 && balance.credited > 0);
  const lastPaid = payments.length ? payments[payments.length - 1].receivedOn : null;
  const { error } = await db()
    .from("invoices")
    .update({
      status: settled ? "paid" : "unpaid",
      paid_at: settled && lastPaid ? new Date(`${lastPaid}T12:00:00+05:30`).toISOString() : null,
    })
    .eq("id", invoiceId);
  if (error) throw appError("SX-4204", "Could not update the invoice status.", error);
}

export const getInvoiceLedger = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, invoiceId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    return loadInvoiceLedger(data.invoiceId);
  });

export const recordPayment = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        invoiceId: idSchema,
        amount: amountSchema,
        receivedOn: daySchema,
        method: z.enum(["bank_transfer", "upi", "cheque", "cash", "other"]),
        reference: z.string().trim().max(100).optional(),
        notes: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    if (data.receivedOn > todayIstKey()) throw new Error("The payment date can't be in the future");
    const { invoice, balance } = await loadInvoiceLedger(data.invoiceId);
    if (invoice.status === "cancelled") throw new Error("This invoice is cancelled");
    const amount = round2(data.amount);
    if (amount > balance.balance + 0.005) {
      throw new Error(
        `That's more than is still owed on this invoice (₹${balance.balance.toLocaleString("en-IN")})`,
      );
    }
    const { error } = await raw()
      .from("invoice_payments")
      .insert({
        invoice_id: invoice.id,
        client_id: invoice.clientId,
        amount,
        received_on: data.receivedOn,
        method: data.method,
        reference: data.reference || null,
        notes: data.notes || null,
        created_by: caller.superadminId,
      });
    if (error) throw appError("SX-4205", "Could not record the payment.", error);
    await syncInvoiceStatus(invoice.id);
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "invoice_payment_recorded",
      clientId: invoice.clientId,
      summary: `Recorded ₹${amount.toLocaleString("en-IN")} received on ${data.receivedOn} against invoice ${invoice.invoiceNumber}`,
      detail: {
        invoiceId: invoice.id,
        amount,
        method: data.method,
        reference: data.reference ?? null,
      },
    });
    return loadInvoiceLedger(invoice.id);
  });

export const deletePayment = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, paymentId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { data: row, error } = await raw()
      .from("invoice_payments")
      .delete()
      .eq("id", data.paymentId)
      .select("invoice_id, client_id, amount, received_on")
      .maybeSingle();
    if (error) throw appError("SX-4206", "Could not remove the payment.", error);
    if (!row) throw new Error("That payment wasn't found");
    const p = row as { invoice_id: string; client_id: string; amount: number; received_on: string };
    await syncInvoiceStatus(p.invoice_id);
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "invoice_payment_removed",
      clientId: p.client_id,
      summary: `Removed a ₹${Number(p.amount).toLocaleString("en-IN")} payment dated ${p.received_on}`,
      detail: { invoiceId: p.invoice_id },
    });
    return loadInvoiceLedger(p.invoice_id);
  });

export const issueCreditNote = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        invoiceId: idSchema,
        /** Taxable value to credit (before GST). */
        taxable: amountSchema,
        reason: z.string().trim().min(3).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { invoice, creditable } = await loadInvoiceLedger(data.invoiceId);
    if (invoice.status === "cancelled") throw new Error("This invoice is cancelled");
    const taxable = round2(data.taxable);
    if (taxable > creditable + 0.005) {
      throw new Error(
        `At most ₹${creditable.toLocaleString("en-IN")} (before GST) can still be credited`,
      );
    }
    // Same GST split as the invoice it corrects: same supplier state and place of supply, and no
    // GST at all against a Bill of Supply.
    const gst = gstBreakdown(
      taxable,
      invoice.supplier.stateCode ?? "",
      invoice.placeOfSupply,
      !!invoice.supplier.gstin,
    );
    const issueDate = todayIstKey();
    const prefix = invoice.invoiceNumber.split("/")[0];
    const { data: row, error } = await raw().rpc("issue_credit_note", {
      p_client_id: invoice.clientId,
      p_invoice_id: invoice.id,
      p_prefix: prefix,
      p_fy: financialYear(issueDate),
      p_issue_date: issueDate,
      p_reason: data.reason,
      p_lines: [
        {
          description: `Credit against invoice ${invoice.invoiceNumber}: ${data.reason}`,
          amount: gst.taxable,
        },
      ],
      p_taxable: gst.taxable,
      p_cgst: gst.cgst,
      p_sgst: gst.sgst,
      p_igst: gst.igst,
      p_total: gst.total,
      p_supplier: invoice.supplier,
      p_recipient: invoice.recipient,
      p_superadmin_id: caller.superadminId,
    });
    if (error) throw appError("SX-4207", "Could not issue the credit note.", error);
    const cn = toCreditNote(row as CreditNoteRow);
    await syncInvoiceStatus(invoice.id);
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "credit_note_issued",
      clientId: invoice.clientId,
      summary: `Issued credit note ${cn.creditNoteNumber} for ₹${cn.total.toLocaleString("en-IN")} against invoice ${invoice.invoiceNumber}`,
      detail: { invoiceId: invoice.id, creditNoteId: cn.id, total: cn.total, reason: data.reason },
    });
    return loadInvoiceLedger(invoice.id);
  });
