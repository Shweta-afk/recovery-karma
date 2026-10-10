// CIBIL credit reports through PayPrime — the only place that spends money with PayPrime.
//
// An Insights service (catalogue id "cibil-report", provider "payprime"), so it shares the
// company's plan, rate card, spend reports and superadmin billing with the ProfileX lookups. What
// is different, and enforced here rather than in the browser:
//
//   - Company ADMINS only — not managers, not agents. Both to run and to read. Run from
//     Admin → Insights (admins have no debtor-profile screen), against a debtor found by search.
//   - The billing ledger row goes in insights_manual_lookups (RLS: admins only), never
//     debtor_traces (readable by the assigned agent and their manager), so nobody but an admin can
//     see that a credit report was pulled. query_key = the debtor id.
//   - A superadmin must have recorded the company's consent agreement
//     (profilex_settings.cibil_consent_at), because every request asserts the borrower's consent.
//   - The report is stored in cibil_reports (server-only). See migrations/20261010_cibil_*.sql.
//   - The phone is the debtor's own; name/PAN/DOB/address are typed by the admin (prefilled from
//     the bank file and earlier lookups), since nothing on a debtor row reliably holds a PAN.
//
// PayPrime only answers calls from the IPs registered on its portal (Developer Setting → Api
// Token), so this works only where the server's outbound IP is on that list — Railway's static
// outbound IPs in production. Env: PAYPRIME_API_TOKEN — one token, or all of them comma-separated
// (one per allow-listed IP; tried in order, moving on only on "Invalid Api token", which is never
// charged) — and optionally PAYPRIME_BASE_URL.
import { z, tokenSchema, idSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import type { Json } from "./database.types";
import { enforceRateLimit } from "./rate-limit.server";
import { loadSettings } from "./profilex-actions.server";
import { normalisePhone } from "./profilex/billing";
import { CIBIL_SERVICE, getService, priceFor } from "./profilex/catalogue";
import { buildLoanLookupData } from "./profilex/loan-lookup-data";
import {
  buildPrefill,
  cibilRequestBody,
  isInvalidToken,
  parseTokens,
  readCibilOutcome,
  validateCibilForm,
  type CibilForm,
} from "./cibil/payprime";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- the new tables/columns are read
   through an untyped client until database.types.ts is regenerated after the migration. */
type QueryBuilder = any;
interface LooseDb {
  from: (table: string) => QueryBuilder;
}
const db = (): LooseDb => getSupabaseAdmin() as unknown as LooseDb;
type Row = Record<string, unknown>;

const env = (name: string) => process.env[name]?.trim() || undefined;

async function requireAdmin(accessToken: string) {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  if (caller.role !== "admin") throw new Error("Only admins can use CIBIL reports");
  return caller;
}

/** When the superadmin recorded this company's consent agreement, or null. A database still
 *  missing the column reads as "not recorded", which keeps CIBIL off — the safe direction. */
async function consentAt(clientId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("profilex_settings")
    .select("cibil_consent_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) return null;
  return (data?.cibil_consent_at as string | null) ?? null;
}

async function loadDebtor(debtorId: string, clientId: string) {
  const { data: debtor, error } = await db()
    .from("debtors")
    .select("id, client_id, name, email, phone_primary, loan_reference, extra")
    .eq("id", debtorId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the debtor (${error.message})`);
  if (!debtor) throw new Error("That debtor no longer exists");
  if (debtor.client_id !== clientId) throw new Error("That debtor belongs to another organisation");
  return debtor as Row;
}

export interface CibilReportSummary {
  id: string;
  createdAt: string;
  score: number | null;
  htmlUrl: string | null;
  txnId: string | null;
  requestedByName: string | null;
  /** The name/PAN/DOB… it was pulled with, so a re-pull can start from it. */
  request: Json;
}

function toSummary(r: Row): CibilReportSummary {
  const agent = r.agents as { name?: string } | null;
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    score: (r.score as number | null) ?? null,
    htmlUrl: (r.html_url as string | null) ?? null,
    txnId: (r.txn_id as string | null) ?? null,
    requestedByName: agent?.name ?? null,
    request: (r.request as Json) ?? {},
  };
}

export interface CibilPanelState {
  /** Why the Pull button is not offered, or null when it is. */
  blockedReason: string | null;
  price: number;
  prefill: CibilForm;
  reports: CibilReportSummary[];
}

/** Everything the debtor's CIBIL panel needs: whether it can run, the price, the form prefilled
 *  from the bank file and earlier lookups, and reports already pulled. */
export const getCibilPanel = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, debtorId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<CibilPanelState> => {
    const caller = await requireAdmin(data.accessToken);
    const debtor = await loadDebtor(data.debtorId, caller.clientId);
    const service = getService(CIBIL_SERVICE)!;
    const admin = db();

    const [settings, consent, traces, reports] = await Promise.all([
      loadSettings(caller.clientId),
      consentAt(caller.clientId),
      admin
        .from("debtor_traces")
        .select("id, service_id, state, provider_status, billable, cost, created_at, response")
        .eq("debtor_id", data.debtorId)
        .eq("state", "done")
        .neq("service_id", CIBIL_SERVICE),
      admin
        .from("cibil_reports")
        .select("id, created_at, score, html_url, txn_id, request, agents(name)")
        .eq("debtor_id", data.debtorId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    let blockedReason: string | null = null;
    if (!settings.enabled) blockedReason = "Insights is turned off for your company.";
    else if (!settings.enabled_services.includes(CIBIL_SERVICE))
      blockedReason = "CIBIL reports are not on your company's Insights plan.";
    else if (!consent)
      blockedReason =
        "CIBIL reports are on your plan but your company's consent agreement has not been " +
        "recorded yet. Contact SamvadX support.";
    else if (reports.error)
      blockedReason = "CIBIL reports are not set up on the server yet. Contact SamvadX support.";

    // PAN / DOB / gender / emails earlier lookups found on this debtor.
    const lookup =
      buildLoanLookupData(
        ((traces.data ?? []) as Row[]).map((t) => ({
          traceId: String(t.id),
          debtorId: data.debtorId,
          serviceId: String(t.service_id),
          state: String(t.state),
          providerStatus: (t.provider_status as string | null) ?? null,
          billable: !!t.billable,
          cost: Number(t.cost ?? 0),
          createdAt: String(t.created_at),
          response: t.response,
          loanReference: "",
          name: String(debtor.name ?? ""),
          phonePrimary: String(debtor.phone_primary ?? ""),
          email: (debtor.email as string | null) ?? null,
          bankExtra: {},
        })),
      ).rows[0] ?? null;

    return {
      blockedReason,
      price: priceFor(service, "1", settings.rate_card),
      prefill: buildPrefill({
        name: String(debtor.name ?? ""),
        email: (debtor.email as string | null) ?? null,
        extra: (debtor.extra as Row | null) ?? {},
        lookup,
      }),
      reports: reports.error ? [] : ((reports.data ?? []) as Row[]).map(toSummary),
    };
  });

const formSchema = z.object({
  firstName: z.string().trim().max(80),
  lastName: z.string().trim().max(80),
  pan: z.string().trim().max(10),
  dob: z.string().trim().max(10),
  gender: z.enum(["Male", "Female", ""]),
  email: z.string().trim().max(254),
  streetAddress: z.string().trim().max(300),
  city: z.string().trim().max(80),
  postalCode: z.string().trim().max(6),
  region: z.string().trim().max(2),
  addressType: z.string().trim().max(1),
});

export const runCibilReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        debtorId: idSchema,
        form: formSchema,
        /** Pull a fresh report even though one is still within the re-use window. */
        force: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin(data.accessToken);
    // Each pull is ₹76.70 of real money.
    enforceRateLimit(`cibil:${caller.authUserId}`, 10, 60_000);

    const service = getService(CIBIL_SERVICE)!;
    const debtor = await loadDebtor(data.debtorId, caller.clientId);

    const settings = await loadSettings(caller.clientId);
    if (!settings.enabled) throw new Error("Insights is turned off for your company.");
    if (!settings.enabled_services.includes(CIBIL_SERVICE)) {
      throw new Error("CIBIL reports are not on your company's Insights plan.");
    }
    if (!(await consentAt(caller.clientId))) {
      throw new Error(
        "Your company's CIBIL consent agreement has not been recorded. Contact SamvadX support.",
      );
    }

    const form = data.form as CibilForm;
    const problems = validateCibilForm(form);
    const firstProblem = Object.entries(problems)[0];
    if (firstProblem) throw new Error(`Check the form: ${firstProblem[0]} — ${firstProblem[1]}`);

    // The phone is the debtor's own, never the browser's.
    const phone = normalisePhone(debtor.phone_primary as string);
    if (!/^[6-9]\d{9}$/.test(phone)) {
      throw new Error(`${debtor.name} has no valid mobile number on file.`);
    }

    const tokens = parseTokens(env("PAYPRIME_API_TOKEN"));
    if (!tokens.length) {
      throw new Error(
        "CIBIL reports are not configured. Set PAYPRIME_API_TOKEN in the server environment " +
          "(and in Railway for production).",
      );
    }

    const admin = db();

    // Re-use: a report pulled within the company's "found" window is served free.
    if (!data.force) {
      const since = new Date(Date.now() - settings.hit_ttl_hours * 3_600_000).toISOString();
      const { data: recent } = await admin
        .from("cibil_reports")
        .select("id, created_at, score, html_url, txn_id, request, agents(name)")
        .eq("debtor_id", data.debtorId)
        .not("html_url", "is", null)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent) return { cached: true, cost: 0, report: toSummary(recent as Row) };
    }

    // Release an abandoned claim, then claim the in-flight slot — the partial unique index on
    // insights_manual_lookups (client_id, service_id, query_key) WHERE state = 'pending' stops a
    // double click paying twice. Same pattern as runManualInsight.
    await admin
      .from("insights_manual_lookups")
      .update({
        state: "failed",
        error: "Abandoned — no response was recorded, so it is not counted as spend.",
        completed_at: new Date().toISOString(),
      })
      .eq("client_id", caller.clientId)
      .eq("service_id", CIBIL_SERVICE)
      .eq("query_key", data.debtorId)
      .eq("state", "pending")
      .lt("created_at", new Date(Date.now() - 5 * 60_000).toISOString());

    const { data: pending, error: claimErr } = await admin
      .from("insights_manual_lookups")
      .insert({
        client_id: caller.clientId,
        service_id: CIBIL_SERVICE,
        requested_by: caller.agentId ?? null,
        query_key: data.debtorId,
        // Who it was about — the name/PAN/DOB sent are kept with the report in cibil_reports.
        input: {
          debtor_id: data.debtorId,
          name: String(debtor.name ?? ""),
          loan_reference: String(debtor.loan_reference ?? ""),
        },
        state: "pending",
      })
      .select("id")
      .single();
    if (claimErr || !pending) {
      throw new Error(
        `A CIBIL report is already being pulled for ${debtor.name}. Give it a moment.`,
      );
    }

    const body = cibilRequestBody(form, phone);
    const base = (env("PAYPRIME_BASE_URL") ?? "https://b2b.payprime.in").replace(/\/+$/, "");
    let httpStatus = 0;
    let text = "";
    let json: Row | null = null;
    try {
      // Each token belongs to one allow-listed IP and this call may leave from any of them, so
      // try them in order. Only "Invalid Api token" moves on — it comes back before any
      // transaction is created, so a wrong token is never charged. Any other answer is final.
      for (const token of tokens) {
        const res = await fetch(`${base}${service.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token, ...body }),
          signal: AbortSignal.timeout(90_000),
        });
        httpStatus = res.status;
        text = await res.text();
        json = null;
        try {
          json = JSON.parse(text) as Row;
        } catch {
          // Non-JSON (an HTML error page — e.g. the IP is not on PayPrime's list). Kept as text.
        }
        if (!isInvalidToken(json)) break;
      }
    } catch (err) {
      await admin
        .from("insights_manual_lookups")
        .update({
          state: "failed",
          error: `Could not reach PayPrime: ${err instanceof Error ? err.message : String(err)}`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", pending.id);
      throw new Error("Could not reach PayPrime — nothing was charged. Try again in a minute.");
    }

    const outcome = readCibilOutcome(httpStatus, json);
    const cost = outcome.billable ? priceFor(service, outcome.status, settings.rate_card) : 0;

    // Ledger row: billing fields only; the report itself goes in cibil_reports.
    await admin
      .from("insights_manual_lookups")
      .update({
        state: outcome.billable ? "done" : "failed",
        http_status: httpStatus,
        provider_status: outcome.status,
        billable: outcome.billable,
        cost,
        transaction_id: outcome.txnId,
        response: {
          provider: "payprime",
          status: outcome.status,
          txn_id: outcome.txnId,
          message: outcome.message.slice(0, 200),
        },
        error: outcome.status === "1" ? null : `HTTP ${httpStatus}: ${text.slice(0, 400)}`,
        completed_at: new Date().toISOString(),
      })
      .eq("id", pending.id);

    if (outcome.status !== "1") {
      const hint =
        httpStatus === 401 || httpStatus === 403 || /ip|whitelist|not allowed/i.test(text)
          ? " If PayPrime says the IP or domain is not allowed, this server's outbound IP is " +
            "not on the list under Developer Setting → Api Token on the PayPrime portal."
          : "";
      throw new Error(
        `PayPrime did not return a report (${outcome.message}).` +
          (outcome.billable
            ? ` It issued transaction ${outcome.txnId}, so it may have been charged.`
            : " Nothing was charged.") +
          hint,
      );
    }

    const { data: saved, error: saveErr } = await admin
      .from("cibil_reports")
      .insert({
        client_id: caller.clientId,
        debtor_id: data.debtorId,
        lookup_id: pending.id,
        requested_by: caller.agentId ?? null,
        request: body,
        txn_id: outcome.txnId,
        html_url: outcome.htmlUrl,
        score: outcome.score,
        response: json,
      })
      .select("id, created_at, score, html_url, txn_id, request, agents(name)")
      .single();
    if (saveErr || !saved) {
      // Paid for, but not stored: say so with the transaction id rather than lose it silently.
      console.error("[cibil] report save failed:", saveErr?.message);
      throw new Error(
        `The report was generated (transaction ${outcome.txnId}) but could not be saved ` +
          `(${saveErr?.message ?? "unknown error"}). Contact SamvadX support with that id.`,
      );
    }

    return { cached: false, cost, report: toSummary(saved as Row) };
  });

/** One report's full structured data, for "Show all fields". Admins of the same company only. */
export const getCibilReportData = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, reportId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireAdmin(data.accessToken);
    const { data: row, error } = await db()
      .from("cibil_reports")
      .select("client_id, response")
      .eq("id", data.reportId)
      .maybeSingle();
    if (error) throw new Error(`Could not load the report (${error.message})`);
    if (!row || row.client_id !== caller.clientId) throw new Error("Report not found");
    return { response: (row.response as Json | null) ?? null };
  });

export interface CibilDebtorHit {
  id: string;
  name: string;
  loanReference: string;
  /** Last 4 digits only — enough to tell two borrowers apart. */
  phoneTail: string;
  portfolio: string;
}

/** Find a borrower to pull a report on (Admin → Insights). Searches the admin's own company by
 *  loan ID, name or mobile number. */
export const searchCibilDebtors = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, query: z.string().trim().min(2).max(60) }).parse(d),
  )
  .handler(async ({ data }): Promise<CibilDebtorHit[]> => {
    const caller = await requireAdmin(data.accessToken);
    enforceRateLimit(`cibil-search:${caller.authUserId}`, 60, 60_000);
    // Only characters a loan ID, name or number can hold — PostgREST's or() filter treats commas,
    // parentheses and dots as syntax, and % / _ as wildcards.
    const q = data.query.replace(/[^A-Za-z0-9 \-/]/g, " ").trim();
    if (q.length < 2) return [];
    const digits = q.replace(/\D/g, "");
    const filters = [`loan_reference.ilike.*${q}*`, `name.ilike.*${q}*`];
    if (digits.length >= 4) filters.push(`phone_primary.ilike.*${digits}*`);

    const { data: rows, error } = await db()
      .from("debtors")
      .select("id, name, loan_reference, phone_primary, portfolios(lender_name, product_type)")
      .eq("client_id", caller.clientId)
      .is("archived_at", null)
      .or(filters.join(","))
      .order("name")
      .limit(25);
    if (error) throw new Error(`Search failed (${error.message})`);
    return ((rows ?? []) as Row[]).map((r) => {
      const p = r.portfolios as { lender_name?: string; product_type?: string } | null;
      return {
        id: String(r.id),
        name: String(r.name ?? ""),
        loanReference: String(r.loan_reference ?? ""),
        phoneTail: String(r.phone_primary ?? "").slice(-4),
        portfolio: [p?.lender_name, p?.product_type].filter(Boolean).join(" · "),
      };
    });
  });

export interface CibilReportListRow {
  id: string;
  debtorId: string;
  debtorName: string;
  loanReference: string;
  createdAt: string;
  score: number | null;
  htmlUrl: string | null;
  requestedByName: string | null;
}

/** The company's recent CIBIL reports, newest first (Admin → Insights). */
export const listCibilReports = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireAdmin(data.accessToken);
    const [settings, consent, res] = await Promise.all([
      loadSettings(caller.clientId),
      consentAt(caller.clientId),
      db()
        .from("cibil_reports")
        .select(
          "id, debtor_id, created_at, score, html_url, agents(name), debtors(name, loan_reference)",
        )
        .eq("client_id", caller.clientId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    const onPlan =
      settings.enabled && settings.enabled_services.includes(CIBIL_SERVICE) && !!consent;
    const rows: CibilReportListRow[] = res.error
      ? []
      : ((res.data ?? []) as Row[]).map((r) => {
          const d = r.debtors as { name?: string; loan_reference?: string } | null;
          const a = r.agents as { name?: string } | null;
          return {
            id: String(r.id),
            debtorId: String(r.debtor_id),
            debtorName: d?.name ?? "",
            loanReference: d?.loan_reference ?? "",
            createdAt: String(r.created_at),
            score: (r.score as number | null) ?? null,
            htmlUrl: (r.html_url as string | null) ?? null,
            requestedByName: a?.name ?? null,
          };
        });
    return { onPlan, rows };
  });
