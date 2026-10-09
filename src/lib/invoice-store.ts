// A company admin's own invoices from SamvadX (migrations/20261006_invoices.sql). Read-only:
// superadmins issue invoices through invoice-actions.server.ts; RLS limits this SELECT to the
// signed-in admin's own company (and only once they've passed the emailed sign-in code).
//
// Same get/refresh/event shape as the other *-store.ts files. In-memory only — invoices are
// few and carry billing addresses, so they don't belong in localStorage.

import { supabase } from "./supabase";
import { toInvoiceRecord, type InvoiceRecord } from "./invoice-math";

let cache: InvoiceRecord[] = [];

export function getInvoices(): InvoiceRecord[] {
  return cache;
}

export async function refreshInvoices(): Promise<void> {
  const { data, error } = await supabase
    .from("invoices")
    .select("*")
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error || !data) return;
  cache = data.map(toInvoiceRecord);
  window.dispatchEvent(new CustomEvent("invoices-updated"));
}
