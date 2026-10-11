// Superadmin-only actions for GST tax invoices (migrations/20261006_invoices.sql). Everything
// here runs on the service-role client behind verifySuperadminCaller, like the rest of
// superadmin-actions.server.ts. Invoices are superadmin-only for now (2026-10-09): company
// users have no read access to `invoices` at all — see the migration header to open it up.
//
// Arithmetic (GST split, numbering, financial year) is in the pure invoice-math.ts.

import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, amountSchema, noteSchema } from "./schemas";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { todayIstKey } from "./date-filter";
import {
  GSTIN_RE,
  INVOICE_KIND_LABEL,
  INVOICE_PREFIX_RE,
  addDaysIso,
  financialYear,
  gstBreakdown,
  invoiceDisclaimer,
  normaliseGstin,
  stateFromGstin,
  stateName,
  toInvoiceRecord,
  round2,
  sumLines,
  monthLabel,
  invoiceBalance,
  type InvoiceBalance,
  type InvoiceLine,
  type InvoiceParty,
  type InvoiceRecord,
} from "./invoice-math";
import { loadPriceList } from "./price-list.server";
import { companyDetailsFromRow, fullAddress } from "./company-details";

function db() {
  return getSupabaseAdmin();
}

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Not authenticated as superadmin");
  return caller;
}

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const stateCodeSchema = z
  .string()
  .regex(/^\d{2}$/)
  .refine((c) => !!stateName(c), "unknown GST state code");

const gstinSchema = z
  .string()
  .transform(normaliseGstin)
  .refine(
    (g) => g === "" || GSTIN_RE.test(g),
    "GSTIN should be 15 characters, e.g. 27AAPFU0939F1ZV",
  )
  .transform((g) => (g === "" ? null : g))
  .nullable()
  .optional();

/** Throws if a GSTIN's own state code disagrees with the state picked beside it — the most
 *  likely data-entry slip, and one that silently flips CGST/SGST vs IGST. */
function checkGstinState(gstin: string | null | undefined, stateCode: string | null | undefined) {
  if (!gstin || !stateCode) return;
  const fromGstin = stateFromGstin(gstin);
  if (fromGstin && fromGstin !== stateCode) {
    throw new Error(
      `GSTIN ${gstin} is registered in ${stateName(fromGstin)}, but the state is set to ${stateName(stateCode)}`,
    );
  }
}

// ── Supplier (Axiotta) details ──────────────────────────────────────────────

export interface BillingProfile extends InvoiceParty {
  invoicePrefix: string;
  sacInsights: string | null;
  sacSetup: string | null;
  sacMonthly: string | null;
  paymentTermsDays: number;
}

async function loadBillingProfile(): Promise<BillingProfile> {
  const { data, error } = await db()
    .from("billing_profile")
    .select("*")
    .eq("id", "main")
    .maybeSingle();
  if (error) throw new Error(`Could not load billing details (${error.message})`);
  return {
    legalName: data?.legal_name ?? "",
    gstin: data?.gstin ?? null,
    pan: data?.pan ?? null,
    address: data?.address ?? "",
    stateCode: data?.state_code ?? null,
    email: data?.email ?? null,
    phone: data?.phone ?? null,
    bankName: data?.bank_name ?? null,
    bankAccount: data?.bank_account ?? null,
    bankIfsc: data?.bank_ifsc ?? null,
    terms: data?.terms ?? null,
    invoicePrefix: data?.invoice_prefix ?? "SX",
    sacInsights: data?.sac_insights ?? null,
    sacSetup: data?.sac_setup ?? null,
    sacMonthly: (data as { sac_monthly?: string | null } | null)?.sac_monthly ?? null,
    paymentTermsDays: data?.payment_terms_days ?? 15,
  };
}

export const getBillingProfile = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    return loadBillingProfile();
  });

export const saveBillingProfile = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        legalName: z.string().trim().min(1).max(200),
        gstin: gstinSchema,
        pan: optText(10),
        address: z.string().trim().min(1).max(500),
        stateCode: stateCodeSchema,
        email: optText(200),
        phone: optText(40),
        bankName: optText(120),
        bankAccount: optText(40),
        bankIfsc: optText(20),
        terms: optText(1000),
        invoicePrefix: z.string().trim().toUpperCase().regex(INVOICE_PREFIX_RE),
        sacInsights: optText(10),
        sacSetup: optText(10),
        sacMonthly: optText(10),
        paymentTermsDays: z.number().int().min(0).max(365),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    checkGstinState(data.gstin, data.stateCode);
    const { error } = await db()
      .from("billing_profile")
      .upsert({
        id: "main",
        legal_name: data.legalName,
        gstin: data.gstin ?? null,
        pan: data.pan ?? null,
        address: data.address,
        state_code: data.stateCode,
        email: data.email ?? null,
        phone: data.phone ?? null,
        bank_name: data.bankName ?? null,
        bank_account: data.bankAccount ?? null,
        bank_ifsc: data.bankIfsc ?? null,
        terms: data.terms ?? null,
        invoice_prefix: data.invoicePrefix,
        sac_insights: data.sacInsights ?? null,
        sac_setup: data.sacSetup ?? null,
        // Not in the generated types until they're regenerated after the billing migration.
        ...({ sac_monthly: data.sacMonthly ?? null } as unknown as Record<string, never>),
        payment_terms_days: data.paymentTermsDays,
        updated_at: new Date().toISOString(),
        updated_by: caller.superadminId,
      });
    if (error) throw new Error(`Could not save billing details (${error.message})`);
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "billing_profile_set",
      summary: "Updated SamvadX's invoice (supplier) details",
    });
    return { ok: true as const };
  });

// ── Per-company billing details, invoices, and top-ups not yet invoiced ─────

export interface CompanyBillingDetails {
  legalName: string;
  gstin: string | null;
  address: string;
  stateCode: string | null;
  email: string | null;
}

export interface UninvoicedTopup {
  ledgerId: string;
  amount: number;
  note: string | null;
  createdAt: string;
}

/** An invoice plus what is still owed on it once payments and credit notes are taken off. */
export interface InvoiceWithBalance extends InvoiceRecord {
  balance: InvoiceBalance;
}

/** Payments and credit notes summed per invoice (two small reads, whatever the invoice count). */
async function withBalances<T extends InvoiceRecord>(
  records: T[],
): Promise<(T & { balance: InvoiceBalance })[]> {
  if (!records.length) return [];
  const ids = records.map((r) => r.id);
  // invoice_payments / credit_notes aren't in the generated types until they are regenerated
  // after migrations/20261009_billing_price_lists.sql.
  const raw = db() as unknown as import("@supabase/supabase-js").SupabaseClient;
  const [pay, cn] = await Promise.all([
    raw.from("invoice_payments").select("invoice_id, amount").in("invoice_id", ids),
    raw.from("credit_notes").select("invoice_id, total").in("invoice_id", ids),
  ]);
  // Code deployed ahead of the migration: no payments/credit notes yet, not an error.
  const pays = pay.error ? [] : ((pay.data ?? []) as { invoice_id: string; amount: number }[]);
  const cns = cn.error ? [] : ((cn.data ?? []) as { invoice_id: string; total: number }[]);
  return records.map((r) => ({
    ...r,
    balance: invoiceBalance(
      r,
      pays.filter((p) => p.invoice_id === r.id).map((p) => ({ amount: Number(p.amount) })),
      cns.filter((c) => c.invoice_id === r.id).map((c) => ({ total: Number(c.total) })),
    ),
  }));
}

export const getCompanyBilling = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, clientId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const admin = db();
    const [details, invoices, topups, priceList, agentsRes, clientRes] = await Promise.all([
      admin.from("client_billing").select("*").eq("client_id", data.clientId).maybeSingle(),
      admin
        .from("invoices")
        .select("*")
        .eq("client_id", data.clientId)
        .order("issue_date", { ascending: false })
        .order("created_at", { ascending: false }),
      admin
        .from("profilex_wallet_ledger")
        .select("id, amount, note, created_at")
        .eq("scope", "master_to_company")
        .eq("client_id", data.clientId)
        .order("created_at", { ascending: false }),
      loadPriceList(data.clientId),
      admin
        .from("agents")
        .select("id", { count: "exact", head: true })
        .eq("client_id", data.clientId)
        .eq("role", "agent")
        .neq("is_active", false),
      admin.from("clients").select("max_agents").eq("id", data.clientId).maybeSingle(),
    ]);
    if (details.error) throw new Error(`Could not load billing details (${details.error.message})`);
    if (invoices.error) throw new Error(`Could not load invoices (${invoices.error.message})`);
    if (topups.error) throw new Error(`Could not load top-ups (${topups.error.message})`);

    const records = (invoices.data ?? []).map(toInvoiceRecord);
    // A cancelled invoice frees its top-up to be invoiced again (e.g. after fixing a GSTIN).
    const invoiced = new Set(
      records
        .filter((r) => r.status !== "cancelled" && r.walletLedgerId)
        .map((r) => r.walletLedgerId),
    );
    const uninvoiced: UninvoicedTopup[] = (topups.data ?? [])
      .filter((t) => !invoiced.has(t.id))
      .map((t) => ({
        ledgerId: t.id,
        amount: Number(t.amount),
        note: t.note,
        createdAt: t.created_at,
      }));

    const d = details.data;
    const billing: CompanyBillingDetails = {
      legalName: d?.legal_name ?? "",
      gstin: d?.gstin ?? null,
      address: d?.address ?? "",
      stateCode: d?.state_code ?? null,
      email: d?.email ?? null,
    };
    return {
      billing,
      invoices: await withBalances(records),
      uninvoicedTopups: uninvoiced,
      priceList,
      /** Active agents now — the default seat count on a monthly invoice. */
      activeAgents: agentsRes.count ?? 0,
      agentSeatLimit: (clientRes.data as { max_agents: number | null } | null)?.max_agents ?? null,
    };
  });

export const saveCompanyBilling = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        legalName: z.string().trim().min(1).max(200),
        gstin: gstinSchema,
        address: z.string().trim().min(1).max(500),
        stateCode: stateCodeSchema,
        email: optText(200),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    checkGstinState(data.gstin, data.stateCode);
    const { error } = await db()
      .from("client_billing")
      .upsert({
        client_id: data.clientId,
        legal_name: data.legalName,
        gstin: data.gstin ?? null,
        address: data.address,
        state_code: data.stateCode,
        email: data.email ?? null,
        updated_at: new Date().toISOString(),
        updated_by: caller.superadminId,
      });
    if (error) throw new Error(`Could not save billing details (${error.message})`);
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "company_billing_set",
      clientId: data.clientId,
      summary: `Updated ${data.legalName}'s invoice (recipient) details`,
    });
    return { ok: true as const };
  });

// ── Issue an invoice ────────────────────────────────────────────────────────

/** A charged row as sent by the browser. A per-unit line's amount is recomputed from
 *  quantity × rate on the server, so the printed maths can't disagree with the total. */
const lineSchema = z
  .object({
    description: z.string().trim().min(1).max(200),
    amount: amountSchema,
    quantity: z.number().int().min(1).max(100_000).optional(),
    rate: amountSchema.optional(),
  })
  .transform((l): InvoiceLine =>
    l.quantity && l.rate
      ? {
          description: l.description,
          quantity: l.quantity,
          rate: round2(l.rate),
          amount: round2(l.quantity * l.rate),
        }
      : { description: l.description, amount: round2(l.amount) },
  );

export const createInvoice = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .discriminatedUnion("kind", [
        z.object({
          accessToken: tokenSchema,
          clientId: idSchema,
          kind: z.literal("insights_topup"),
          walletLedgerId: idSchema,
          notes: noteSchema.optional(),
        }),
        z.object({
          accessToken: tokenSchema,
          clientId: idSchema,
          kind: z.literal("setup"),
          // The charged rows — prefilled from the company's price list (before GST).
          lines: z.array(lineSchema).min(1).max(20),
          notes: noteSchema.optional(),
        }),
        z.object({
          accessToken: tokenSchema,
          clientId: idSchema,
          kind: z.literal("monthly"),
          /** "YYYY-MM" — one live monthly invoice per company per month. */
          periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          lines: z.array(lineSchema).min(1).max(20),
          notes: noteSchema.optional(),
        }),
      ])
      .parse(d),
  )
  .handler(async ({ data }): Promise<InvoiceRecord> => {
    const caller = await requireSuperadmin(data.accessToken);
    const admin = db();

    const supplier = await loadBillingProfile();
    if (!supplier.legalName || !supplier.address || !supplier.stateCode || !supplier.gstin) {
      throw new Error(
        "Fill in SamvadX's own billing details (legal name, GSTIN, address, state) on Superadmin → Invoices first",
      );
    }

    const { data: cb, error: cbErr } = await admin
      .from("client_billing")
      .select("*")
      .eq("client_id", data.clientId)
      .maybeSingle();
    if (cbErr) throw new Error(`Could not load the company's billing details (${cbErr.message})`);
    if (!cb?.legal_name || !cb.address || !cb.state_code) {
      throw new Error("Fill in this company's billing details (legal name, address, state) first");
    }
    // City/PIN/PAN/phone are filled in by the company's admin on Admin → Settings
    // (company-details.ts); fullAddress joins them onto the address line printed on the invoice.
    const details = companyDetailsFromRow(cb as unknown as Record<string, unknown>);
    const recipient: InvoiceParty = {
      legalName: cb.legal_name,
      gstin: cb.gstin,
      pan: details.pan || null,
      address: fullAddress(details),
      stateCode: cb.state_code,
      email: cb.email,
      phone: details.phone || null,
    };

    let taxableAmount: number;
    let description: string;
    let lines: InvoiceLine[];
    let sac: string | null;
    let walletLedgerId: string | null = null;
    if (data.kind === "insights_topup") {
      const { data: led, error: ledErr } = await admin
        .from("profilex_wallet_ledger")
        .select("id, scope, client_id, amount, created_at")
        .eq("id", data.walletLedgerId)
        .maybeSingle();
      if (ledErr) throw new Error(`Could not load that top-up (${ledErr.message})`);
      if (!led || led.scope !== "master_to_company" || led.client_id !== data.clientId) {
        throw new Error("That top-up isn't an Insights allocation to this company");
      }
      taxableAmount = Number(led.amount);
      walletLedgerId = led.id;
      const credited = new Date(led.created_at).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      description = `Insights prepaid wallet top-up (credited ${credited})`;
      lines = [{ description, amount: taxableAmount }];
      sac = supplier.sacInsights;
    } else if (data.kind === "monthly") {
      lines = data.lines;
      taxableAmount = sumLines(lines);
      description = `SamvadX monthly fee — ${monthLabel(data.periodMonth)}`;
      sac = supplier.sacMonthly ?? supplier.sacSetup;
    } else {
      lines = data.lines;
      taxableAmount = sumLines(lines);
      description = "SamvadX platform setup";
      sac = supplier.sacSetup;
    }

    const gst = gstBreakdown(taxableAmount, supplier.stateCode, cb.state_code);
    const issueDate = todayIstKey();
    // The company's own payment terms when its price list sets them, else SamvadX's default.
    const companyTerms = (await loadPriceList(data.clientId)).paymentTermsDays;
    const fy = financialYear(issueDate);
    const {
      invoicePrefix,
      sacInsights: _a,
      sacSetup: _b,
      sacMonthly: _c,
      paymentTermsDays,
      ...supplierParty
    } = supplier;

    const { data: row, error } = await admin.rpc("issue_invoice", {
      p_client_id: data.clientId,
      p_prefix: invoicePrefix,
      p_fy: fy,
      p_kind: data.kind,
      p_issue_date: issueDate,
      p_due_date: addDaysIso(issueDate, companyTerms ?? paymentTermsDays),
      p_description: description,
      p_lines: lines,
      p_sac: sac,
      p_place_of_supply: cb.state_code,
      p_taxable: gst.taxable,
      p_cgst: gst.cgst,
      p_sgst: gst.sgst,
      p_igst: gst.igst,
      p_total: gst.total,
      p_supplier: supplierParty,
      p_recipient: recipient,
      p_wallet_ledger_id: walletLedgerId,
      p_notes: data.notes || null,
      p_disclaimer: invoiceDisclaimer(data.kind, supplier.legalName).join("\n"),
      p_superadmin_id: caller.superadminId,
      p_period_month: data.kind === "monthly" ? data.periodMonth : null,
    } as never);
    if (error) {
      if (/invoices_topup_once/.test(error.message)) {
        throw new Error("That top-up has already been invoiced");
      }
      if (/invoices_monthly_once/.test(error.message)) {
        throw new Error(
          "This company already has an invoice for that month — cancel it first to reissue",
        );
      }
      throw new Error(`Could not create the invoice (${error.message})`);
    }
    const invoice = toInvoiceRecord(row as Parameters<typeof toInvoiceRecord>[0]);

    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "invoice_issued",
      clientId: data.clientId,
      summary: `Issued ${INVOICE_KIND_LABEL[data.kind]} invoice ${invoice.invoiceNumber} to ${recipient.legalName} for ₹${gst.total.toLocaleString("en-IN")}`,
      detail: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, total: gst.total },
    });
    return invoice;
  });

// ── Status ──────────────────────────────────────────────────────────────────

export const setInvoiceStatus = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        invoiceId: idSchema,
        // Paid/unpaid now follow recorded payments (billing-actions.server.ts recordPayment);
        // the only manual status change left is cancelling.
        status: z.literal("cancelled"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const admin = db();
    const { data: prior, error: pErr } = await admin
      .from("invoices")
      .select("client_id, invoice_number, status")
      .eq("id", data.invoiceId)
      .maybeSingle();
    if (pErr || !prior) throw new Error("Invoice not found");
    // A cancelled invoice stays cancelled: its number is spent, and its top-up may already be
    // on a replacement invoice. Issue a new one instead of reviving it.
    if (prior.status === "cancelled") throw new Error("A cancelled invoice can't be reopened");
    const { data: full, error: fErr } = await admin
      .from("invoices")
      .select("*")
      .eq("id", data.invoiceId)
      .single();
    if (fErr || !full) throw new Error("Invoice not found");
    const [{ balance }] = await withBalances([toInvoiceRecord(full)]);
    if (balance.paid > 0 || balance.credited > 0) {
      throw new Error(
        "This invoice has payments or credit notes against it — issue a credit note instead of cancelling",
      );
    }
    const { error } = await admin
      .from("invoices")
      .update({ status: data.status, paid_at: null })
      .eq("id", data.invoiceId);
    if (error) throw new Error(`Could not update the invoice (${error.message})`);
    void logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "invoice_status_set",
      clientId: prior.client_id,
      summary: `Marked invoice ${prior.invoice_number} ${data.status}`,
      detail: { from: prior.status, to: data.status },
    });
    return { ok: true as const };
  });

// ── All invoices (superadmin overview) ─────────────────────────────────────

export interface InvoiceListRow extends InvoiceWithBalance {
  companyName: string | null;
}

export const listAllInvoices = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<InvoiceListRow[]> => {
    await requireSuperadmin(data.accessToken);
    const admin = db();
    const [{ data: rows, error }, { data: clients }] = await Promise.all([
      admin
        .from("invoices")
        .select("*")
        .order("issue_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1000),
      admin.from("clients").select("id, company_name"),
    ]);
    if (error) throw new Error(`Could not load invoices (${error.message})`);
    const nameById = new Map((clients ?? []).map((c) => [c.id, c.company_name]));
    return withBalances(
      (rows ?? []).map((r) => ({
        ...toInvoiceRecord(r),
        companyName: nameById.get(r.client_id) ?? null,
      })),
    );
  });
