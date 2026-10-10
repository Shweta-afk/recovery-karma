// Reading a company's price list (client_price_lists, migrations/20261009_billing_price_lists.sql)
// — its own module because invoices, billing actions and contract generation all need it, and
// billing-actions ↔ contracts.server would otherwise import each other.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "./supabase-admin.server";
import { EMPTY_PRICE_LIST, type InvoiceLine, type PriceList } from "./invoice-math";

export const toPriceLines = (v: unknown): InvoiceLine[] =>
  Array.isArray(v)
    ? (v as { description: string; amount: number | string }[]).map((l) => ({
        description: String(l.description),
        amount: Number(l.amount),
      }))
    : [];

/** A company's price list, or an empty one. Never throws for a missing table/row, so invoices
 *  keep working on code deployed ahead of the migration. Service role — call only after the
 *  caller has been verified as a superadmin. */
export async function loadPriceList(clientId: string): Promise<PriceList> {
  // Not in the generated Database types until they are regenerated after the migration.
  const raw = getSupabaseAdmin() as unknown as SupabaseClient;
  const { data, error } = await raw
    .from("client_price_lists")
    .select("setup_lines, monthly_lines, per_seat_fee, payment_terms_days")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return EMPTY_PRICE_LIST;
  const r = data as {
    setup_lines: unknown;
    monthly_lines: unknown;
    per_seat_fee: number | string;
    payment_terms_days: number | null;
  };
  return {
    setupLines: toPriceLines(r.setup_lines),
    monthlyLines: toPriceLines(r.monthly_lines),
    perSeatFee: Number(r.per_seat_fee),
    paymentTermsDays: r.payment_terms_days,
  };
}
