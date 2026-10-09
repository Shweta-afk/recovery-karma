// Superadmin revenue report — reads the invoices table (20261006_invoices.sql) through the
// service role after verifySuperadminCaller and hands the rows to revenue-report.ts.
//
// Tolerates the table not existing yet: code can deploy ahead of the migration, and the page
// then says so instead of failing (the Insights margin and seat sections still load).

import { z, tokenSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { fetchAllRows } from "./fetch-all-rows";
import { todayIstKey } from "./date-filter";
import {
  buildRevenueReport,
  type RevenueInvoice,
  type RevenueInvoiceStatus,
  type RevenueReport,
} from "./revenue-report";
import { boundedRange, isDayKey } from "./superadmin-range";

const daySchema = z.string().refine(isDayKey, "Expected YYYY-MM-DD");

export type RevenueReportResponse =
  { available: true; report: RevenueReport } | { available: false; reason: string };

interface InvoiceDbRow {
  id: string;
  client_id: string;
  invoice_number: string;
  kind: string;
  issue_date: string;
  due_date: string;
  taxable_amount: number | string;
  cgst: number | string;
  sgst: number | string;
  igst: number | string;
  total: number | string;
  status: string;
  paid_at: string | null;
  place_of_supply: string;
  recipient: { legalName?: string; gstin?: string | null } | null;
}

function isMissingTable(e: { message?: string; code?: string } | null): boolean {
  if (!e) return false;
  // PGRST205 = not in the schema cache; 42P01 = undefined_table.
  return (
    e.code === "PGRST205" ||
    e.code === "42P01" ||
    /does not exist|schema cache/i.test(e.message ?? "")
  );
}

export const getRevenueReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        from: daySchema.optional(),
        to: daySchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<RevenueReportResponse> => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = getSupabaseAdmin();
    const today = todayIstKey();
    const range = boundedRange({ from: data.from ?? "", to: data.to ?? "" }, today);

    // All invoices, not just the range: "outstanding" is every unpaid invoice whatever its
    // date, and a payment in the range can settle an invoice issued before it. Invoices are
    // few (one per top-up or setup), so this stays small.
    const [invoices, clientsRes] = await Promise.all([
      fetchAllRows<InvoiceDbRow>(async (from, to) => {
        const { data: rows, error } = await admin
          .from("invoices")
          .select(
            "id, client_id, invoice_number, kind, issue_date, due_date, taxable_amount, cgst, sgst, igst, total, status, paid_at, place_of_supply, recipient",
          )
          .order("issue_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to);
        return { data: rows as unknown as InvoiceDbRow[] | null, error };
      }),
      admin.from("clients").select("id, company_name"),
    ]);
    if (invoices.error) {
      if (isMissingTable(invoices.error as { message?: string; code?: string })) {
        return {
          available: false,
          reason:
            "Invoicing isn't set up in the database yet (migration 20261006_invoices.sql has not been applied).",
        };
      }
      throw new Error(`Could not load invoices (${invoices.error.message})`);
    }
    const nameById = new Map(
      ((clientsRes.data ?? []) as { id: string; company_name: string }[]).map((c) => [
        c.id,
        c.company_name,
      ]),
    );

    const rows: RevenueInvoice[] = invoices.data.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      companyName: nameById.get(r.client_id) ?? r.recipient?.legalName ?? "Unknown company",
      invoiceNumber: r.invoice_number,
      kind: r.kind,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      taxable: Number(r.taxable_amount),
      cgst: Number(r.cgst),
      sgst: Number(r.sgst),
      igst: Number(r.igst),
      total: Number(r.total),
      status: r.status as RevenueInvoiceStatus,
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
      recipientName: r.recipient?.legalName ?? "",
      recipientGstin: r.recipient?.gstin ?? null,
      placeOfSupply: r.place_of_supply,
    }));

    return { available: true, report: buildRevenueReport(rows, range, today) };
  });
