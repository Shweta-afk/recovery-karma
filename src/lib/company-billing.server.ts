// A company admin's own invoices (Admin → Billing). invoices is server-only, so this reads
// through the service role after verifyCaller confirms an ADMIN of that company, and only ever
// returns that company's invoices.
//
// Opening an invoice here is what marks it "Viewed" for the superadmin (invoices.viewed_at, set
// once — the first time — see migrations/20261012_billing_delivery.sql).
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import {
  toInvoiceRecord,
  invoiceBalance,
  type InvoiceRecord,
  type InvoiceBalance,
} from "./invoice-math";

const db = () => getSupabaseAdmin();

async function requireCompanyAdmin(accessToken: string) {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  if (caller.role !== "admin") throw new Error("Only admins can see invoices");
  return caller;
}

export interface MyInvoice extends InvoiceRecord {
  balance: InvoiceBalance;
}

async function withBalance(records: InvoiceRecord[]): Promise<MyInvoice[]> {
  if (!records.length) return [];
  const ids = records.map((r) => r.id);
  const [pay, cn] = await Promise.all([
    db().from("invoice_payments").select("invoice_id, amount").in("invoice_id", ids),
    db().from("credit_notes").select("invoice_id, total").in("invoice_id", ids),
  ]);
  const pays = (pay.data ?? []) as { invoice_id: string; amount: number }[];
  const cns = (cn.data ?? []) as { invoice_id: string; total: number }[];
  return records.map((r) => ({
    ...r,
    balance: invoiceBalance(
      r,
      pays.filter((p) => p.invoice_id === r.id).map((p) => ({ amount: Number(p.amount) })),
      cns.filter((c) => c.invoice_id === r.id).map((c) => ({ total: Number(c.total) })),
    ),
  }));
}

/** Every invoice SamvadX has issued to the caller's company, newest first. Cancelled ones are
 *  kept (marked) so the company's records match ours. */
export const listMyInvoices = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<MyInvoice[]> => {
    const caller = await requireCompanyAdmin(data.accessToken);
    const { data: rows, error } = await db()
      .from("invoices")
      .select("*")
      .eq("client_id", caller.clientId)
      .order("issue_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load invoices (${error.message})`);
    return withBalance(
      (rows ?? []).map((r) => toInvoiceRecord(r as Parameters<typeof toInvoiceRecord>[0])),
    );
  });

/** One invoice, for viewing/printing — and the first open marks it Viewed. */
export const openMyInvoice = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, invoiceId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<MyInvoice> => {
    const caller = await requireCompanyAdmin(data.accessToken);
    const { data: row, error } = await db()
      .from("invoices")
      .select("*")
      .eq("id", data.invoiceId)
      .eq("client_id", caller.clientId)
      .maybeSingle();
    if (error || !row) throw new Error("Invoice not found");
    const inv = toInvoiceRecord(row as Parameters<typeof toInvoiceRecord>[0]);
    if (!inv.viewedAt) {
      const viewedAt = new Date().toISOString();
      // `is viewed_at null` in the filter: two admins opening at once still record the first.
      await db()
        .from("invoices")
        .update({ viewed_at: viewedAt, viewed_by_agent: caller.agentId ?? null })
        .eq("id", inv.id)
        .is("viewed_at", null);
      inv.viewedAt = viewedAt;
    }
    return (await withBalance([inv]))[0];
  });
