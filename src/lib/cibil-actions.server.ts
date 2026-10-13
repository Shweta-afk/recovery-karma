// CIBIL credit reports through PayPrime — the only place that spends money with PayPrime.
//
// An Insights service (catalogue id "cibil-report", provider "payprime") with ONE switch per
// company, set by a superadmin (company page → Insights card): CIBIL is "on" when the service is
// on the company's plan AND its consent agreement is recorded — the switch sets both together
// (setCompanyCibil in superadmin-actions.server.ts). Off, every function here returns nothing and
// refuses to run, for every role. Independent of the ProfileX "Enable Insights" toggle.
//
// Two ways in, both enforced here rather than in the browser:
//
//   - Borrower pull (runCibilBorrower) — a MANAGER (or admin) on a borrower they can see, from
//     the borrower's Insights tab. The phone is the borrower's own; PAN/DOB/address come from the
//     bank file and earlier lookups (Skip Tracing returns PAN) and can be corrected. Managers pay
//     from their Insights wallet, like every other lookup. Ledger: debtor_traces. The report is
//     visible to everyone who can see that borrower (the assigned agent, their manager, admins).
//   - Manual pull (runCibilManual) — an ADMIN types in any person's details on Admin → Insights.
//     Ledger: insights_manual_lookups (admins only). Visible to the company's admins only.
//
// Reports live in cibil_reports (server-only — no RLS policies), read through getCibilBorrower /
// listCibilManual / getCibilReportData after the visibility checks above. The ledger rows carry
// billing fields only. See migrations/20261010_cibil_*.sql and 20261011_cibil_borrower_and_manual.sql.
//
// PayPrime only answers calls from the IPs registered on its portal (Developer Setting → Api
// Token), so this works only where the server's outbound IP is on that list — Railway's static
// outbound IPs in production. Env: PAYPRIME_API_TOKEN — one token, or all of them comma-separated
// (one per allow-listed IP; tried in order, moving on only on "Invalid Api token", which is never
// charged) — and optionally PAYPRIME_BASE_URL.
import { z, tokenSchema, idSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import type { Json } from "./database.types";
import { enforceRateLimit } from "./rate-limit.server";
import { loadSettings, type ProfilexSettings } from "./profilex-actions.server";
import { normalisePhone } from "./profilex/billing";
import { CIBIL_SERVICE, getService, priceFor } from "./profilex/catalogue";
import { buildLoanLookupData } from "./profilex/loan-lookup-data";
import { flatten } from "./profilex/flatten";
import {
  buildPrefill,
  buildReportHtml,
  cibilRequestBody,
  isUsableReportHtml,
  reportFileName,
  withBaseHref,
  isInvalidToken,
  parseTokens,
  readCibilOutcome,
  validateCibilForm,
  type CibilForm,
  type CibilOutcome,
} from "./cibil/payprime";

/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST's fluent builder;
   the chain is `any` by necessity, as in profilex-actions.server.ts. */
type QueryBuilder = any;
interface LooseDb {
  from: (table: string) => QueryBuilder;
  rpc: (fn: string, args?: Row) => Promise<{ data: unknown; error: { message: string } | null }>;
}
const db = (): LooseDb => getSupabaseAdmin() as unknown as LooseDb;
type Row = Record<string, unknown>;
type Caller = NonNullable<Awaited<ReturnType<typeof verifyCaller>>>;

const env = (name: string) => process.env[name]?.trim() || undefined;

async function requireCaller(accessToken: string): Promise<Caller> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  return caller;
}

/** The company's one CIBIL switch: on the plan AND consent recorded. A database missing the
 *  consent column reads as off — the safe direction. */
async function cibilState(clientId: string): Promise<{ on: boolean; settings: ProfilexSettings }> {
  const [settings, consent] = await Promise.all([
    loadSettings(clientId),
    db()
      .from("profilex_settings")
      .select("cibil_consent_at")
      .eq("client_id", clientId)
      .maybeSingle()
      .then((r: { data: Row | null; error: unknown }) =>
        r.error ? null : ((r.data?.cibil_consent_at as string | null) ?? null),
      ),
  ]);
  return { on: settings.enabled_services.includes(CIBIL_SERVICE) && !!consent, settings };
}

/** Whether the caller can see this borrower — decided by the database's own debtors_select RLS,
 *  run AS the caller, so CIBIL visibility is exactly borrower visibility (assigned agent, their
 *  manager, admins) and can never drift from it. */
async function callerCanSeeDebtor(accessToken: string, debtorId: string): Promise<boolean> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Missing SUPABASE_URL/SUPABASE_ANON_KEY (server env)");
  const asUser = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data } = await asUser.from("debtors").select("id").eq("id", debtorId).maybeSingle();
  return !!data;
}

async function loadDebtor(debtorId: string, clientId: string) {
  const { data: debtor, error } = await db()
    .from("debtors")
    .select("id, client_id, name, email, phone_primary, loan_reference, extra")
    .eq("id", debtorId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the borrower (${error.message})`);
  if (!debtor) throw new Error("That borrower no longer exists");
  if (debtor.client_id !== clientId) throw new Error("That borrower belongs to another company");
  return debtor as Row;
}

export interface CibilReportSummary {
  id: string;
  createdAt: string;
  score: number | null;
  htmlUrl: string | null;
  txnId: string | null;
  requestedByName: string | null;
  /** Who the report is about (name and PAN as sent). */
  subject: string;
}

const REPORT_COLUMNS = "id, created_at, score, html_url, txn_id, request, agents(name)";

function toSummary(r: Row): CibilReportSummary {
  const agent = r.agents as { name?: string } | null;
  const req = (r.request as Row | null) ?? {};
  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    score: (r.score as number | null) ?? null,
    htmlUrl: (r.html_url as string | null) ?? null,
    txnId: (r.txn_id as string | null) ?? null,
    requestedByName: agent?.name ?? null,
    subject: [
      `${String(req.first_name ?? "")} ${String(req.last_name ?? "")}`.trim(),
      req.id_number,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

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

function checkForm(form: CibilForm) {
  const first = Object.entries(validateCibilForm(form))[0];
  if (first) throw new Error(`Check the form: ${first[0]} — ${first[1]}`);
}

/** POST to PayPrime, trying each configured token (see header). Never throws on an HTTP error —
 *  only when PayPrime cannot be reached at all, in which case nothing was charged. */
async function callPayPrime(
  body: Record<string, unknown>,
): Promise<{ httpStatus: number; text: string; json: Row | null }> {
  const tokens = parseTokens(env("PAYPRIME_API_TOKEN"));
  if (!tokens.length) {
    throw new Error(
      "CIBIL reports are not configured. Set PAYPRIME_API_TOKEN in the server environment " +
        "(and in Railway for production).",
    );
  }
  const base = (env("PAYPRIME_BASE_URL") ?? "https://b2b.payprime.in").replace(/\/+$/, "");
  const path = getService(CIBIL_SERVICE)!.path;
  let httpStatus = 0;
  let text = "";
  let json: Row | null = null;
  for (const token of tokens) {
    const res = await fetch(`${base}${path}`, {
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
  return { httpStatus, text, json };
}

function ledgerFields(outcome: CibilOutcome, httpStatus: number, text: string, cost: number) {
  return {
    state: outcome.billable ? "done" : "failed",
    http_status: httpStatus,
    provider_status: outcome.status,
    billable: outcome.billable,
    cost,
    transaction_id: outcome.txnId,
    // Billing fields only — the report itself goes in cibil_reports.
    response: {
      provider: "payprime",
      status: outcome.status,
      txn_id: outcome.txnId,
      message: outcome.message.slice(0, 200),
    },
    error: outcome.status === "1" ? null : `HTTP ${httpStatus}: ${text.slice(0, 400)}`,
    completed_at: new Date().toISOString(),
  };
}

function failureMessage(outcome: CibilOutcome, httpStatus: number, text: string): string {
  const hint =
    httpStatus === 401 || httpStatus === 403 || /\bip\b|whitelist|not allowed/i.test(text)
      ? " If PayPrime says the IP or domain is not allowed, this server's outbound IP is not on " +
        "the list under Developer Setting → Api Token on the PayPrime portal."
      : "";
  const badParams = /bad parameter/i.test(outcome.message)
    ? " PayPrime needs more of the person's details for this one — fill in gender, email and " +
      "the address too, then try again."
    : "";
  // Laravel-style validation ("The region field is required.") — rejected before any transaction.
  const missing = outcome.message.match(/the (\w+) field is required/i)?.[1];
  const missingField = missing
    ? ` PayPrime needs the ${{ region: "state", postal_code: "PIN code", street_address: "address" }[missing.toLowerCase()] ?? missing.replace(/_/g, " ")} filled in — add it and try again.`
    : "";
  const noRecord = /no record/i.test(outcome.message)
    ? " The bureau has no record matching these details — check the PAN, date of birth and " +
      "name spelling against the borrower's PAN card."
    : "";
  return (
    `PayPrime did not return a report (${outcome.message}).` +
    noRecord +
    missingField +
    badParams +
    (outcome.billable
      ? ` It issued transaction ${outcome.txnId}, so it may have been charged.`
      : " Nothing was charged.") +
    hint
  );
}

function unreachable(err: unknown): Error {
  return new Error(
    err instanceof Error && /not configured/.test(err.message)
      ? err.message
      : "Could not reach PayPrime — nothing was charged. Try again in a minute.",
  );
}

/** Save a copy of the report page PayPrime links to (htmlUrl), since such links can expire.
 *  Best-effort: only https pages on CIBIL's or PayPrime's own sites, size-capped, and only when
 *  the page has real content (isUsableReportHtml). Null otherwise — the download then builds a
 *  report from the structured data instead. */
async function captureReportHtml(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !/(^|\.)(cibil\.com|payprime\.in)$/i.test(u.hostname))
      return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
    const html = await res.text();
    if (html.length > 5_000_000 || !isUsableReportHtml(html)) return null;
    return withBaseHref(html, res.url || url);
  } catch {
    return null;
  }
}

async function saveReport(fields: Row): Promise<CibilReportSummary> {
  const { data: saved, error } = await db()
    .from("cibil_reports")
    .insert(fields)
    .select(REPORT_COLUMNS)
    .single();
  if (error || !saved) {
    // Paid for, but not stored: say so with the transaction id rather than lose it silently.
    console.error("[cibil] report save failed:", error?.message);
    throw new Error(
      `The report was generated (transaction ${String(fields.txn_id)}) but could not be saved ` +
        `(${error?.message ?? "unknown error"}). Contact SamvadX support with that id.`,
    );
  }
  return toSummary(saved as Row);
}

// ── Borrower pulls (managers; visible to whoever can see the borrower) ─────────────────────────

export interface CibilBorrowerState {
  /** The company's CIBIL switch. Off → nothing else is returned and the UI shows nothing. */
  on: boolean;
  /** Whether this caller may pull (managers and admins; agents read only). */
  canRun: boolean;
  price: number;
  /** Prefilled form, only for someone who can run it. */
  prefill: CibilForm | null;
  reports: CibilReportSummary[];
}

export const getCibilBorrower = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, debtorId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<CibilBorrowerState> => {
    const off: CibilBorrowerState = {
      on: false,
      canRun: false,
      price: 0,
      prefill: null,
      reports: [],
    };
    const caller = await requireCaller(data.accessToken);
    const { on, settings } = await cibilState(caller.clientId);
    if (!on) return off;
    if (!(await callerCanSeeDebtor(data.accessToken, data.debtorId))) return off;

    const admin = db();
    const canRun = caller.role === "manager" || caller.role === "admin";
    const service = getService(CIBIL_SERVICE)!;

    const reportsRes = await admin
      .from("cibil_reports")
      .select(REPORT_COLUMNS)
      .eq("debtor_id", data.debtorId)
      .order("created_at", { ascending: false })
      .limit(10);
    const reports = reportsRes.error ? [] : ((reportsRes.data ?? []) as Row[]).map(toSummary);

    let prefill: CibilForm | null = null;
    if (canRun) {
      const debtor = await loadDebtor(data.debtorId, caller.clientId);
      // PAN / DOB / gender / emails that earlier lookups (Skip Tracing especially) found.
      const { data: traces } = await admin
        .from("debtor_traces")
        .select("id, service_id, state, provider_status, billable, cost, created_at, response")
        .eq("debtor_id", data.debtorId)
        .eq("state", "done")
        .neq("service_id", CIBIL_SERVICE);
      const lookup =
        buildLoanLookupData(
          ((traces ?? []) as Row[]).map((t) => ({
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
      prefill = buildPrefill({
        name: String(debtor.name ?? ""),
        email: (debtor.email as string | null) ?? null,
        extra: (debtor.extra as Row | null) ?? {},
        lookup,
      });
    }

    return { on, canRun, price: priceFor(service, "1", settings.rate_card), prefill, reports };
  });

export const runCibilBorrower = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, debtorId: idSchema, form: formSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "manager" && caller.role !== "admin") {
      throw new Error("Only managers can pull a CIBIL report");
    }
    enforceRateLimit(`cibil:${caller.authUserId}`, 10, 60_000);

    const { on, settings } = await cibilState(caller.clientId);
    if (!on) throw new Error("CIBIL reports are not available for your company.");
    if (!(await callerCanSeeDebtor(data.accessToken, data.debtorId))) {
      throw new Error("You can only pull a report for a borrower you can see.");
    }
    const debtor = await loadDebtor(data.debtorId, caller.clientId);
    const form = data.form as CibilForm;
    checkForm(form);

    // The phone is the borrower's own, never the browser's.
    const phone = normalisePhone(debtor.phone_primary as string);
    if (!/^[6-9]\d{9}$/.test(phone)) throw new Error(`${debtor.name} has no valid mobile number.`);

    const service = getService(CIBIL_SERVICE)!;
    const worstCase = priceFor(service, null, settings.rate_card);
    const admin = db();

    // Release an abandoned claim, then claim the in-flight slot (partial unique index on
    // debtor_traces (debtor_id, service_id) WHERE state = 'pending' — no double charge).
    await admin
      .from("debtor_traces")
      .update({
        state: "failed",
        error: "Abandoned — no response was recorded, so it is not counted as spend.",
        completed_at: new Date().toISOString(),
      })
      .eq("debtor_id", data.debtorId)
      .eq("service_id", CIBIL_SERVICE)
      .eq("state", "pending")
      .lt("created_at", new Date(Date.now() - 5 * 60_000).toISOString());
    const { data: pending, error: claimErr } = await admin
      .from("debtor_traces")
      .insert({
        client_id: caller.clientId,
        debtor_id: data.debtorId,
        service_id: CIBIL_SERVICE,
        requested_by: caller.agentId ?? null,
        state: "pending",
      })
      .select("id")
      .single();
    if (claimErr || !pending) {
      throw new Error(
        `A CIBIL report is already being pulled for ${debtor.name}. Give it a moment.`,
      );
    }

    // Managers pay from their Insights wallet — hold the price up front, settle after (same RPCs
    // as runProfilexTrace). Admins fund the wallets and aren't wallet-gated.
    let held = 0;
    if (caller.role === "manager" && caller.agentId) {
      const { data: ok, error: holdErr } = await admin.rpc("profilex_wallet_hold", {
        p_manager_id: caller.agentId,
        p_amount: worstCase,
      });
      if (holdErr || !ok) {
        await admin
          .from("debtor_traces")
          .update({
            state: "failed",
            error: holdErr
              ? `Wallet hold failed: ${holdErr.message}`
              : "Insufficient wallet balance",
            completed_at: new Date().toISOString(),
          })
          .eq("id", pending.id);
        throw new Error(
          `Your Insights wallet needs at least ₹${worstCase.toFixed(2)} for a CIBIL report. ` +
            "Ask an admin to top it up.",
        );
      }
      held = worstCase;
    }
    const settle = async (cost: number) => {
      if (!held || !caller.agentId) return;
      const { error } = await admin.rpc("profilex_wallet_settle", {
        p_manager_id: caller.agentId,
        p_hold: held,
        p_cost: Math.min(cost, held),
      });
      if (error) console.error("[cibil] wallet settle failed:", error.message);
    };

    const body = cibilRequestBody(form, phone);
    let call: Awaited<ReturnType<typeof callPayPrime>>;
    try {
      call = await callPayPrime(body);
    } catch (err) {
      await settle(0);
      await admin
        .from("debtor_traces")
        .update({
          state: "failed",
          error: `Could not reach PayPrime: ${err instanceof Error ? err.message : String(err)}`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", pending.id);
      throw unreachable(err);
    }

    const outcome = readCibilOutcome(call.httpStatus, call.json);
    const cost = outcome.billable ? priceFor(service, outcome.status, settings.rate_card) : 0;
    await admin
      .from("debtor_traces")
      .update(ledgerFields(outcome, call.httpStatus, call.text, cost))
      .eq("id", pending.id);
    await settle(cost);

    if (outcome.status !== "1") {
      throw new Error(failureMessage(outcome, call.httpStatus, call.text));
    }

    const report = await saveReport({
      client_id: caller.clientId,
      debtor_id: data.debtorId,
      trace_id: pending.id,
      requested_by: caller.agentId ?? null,
      request: body,
      txn_id: outcome.txnId,
      html_url: outcome.htmlUrl,
      score: outcome.score,
      response: call.json,
      report_html: await captureReportHtml(outcome.htmlUrl),
    });
    return { cost, report };
  });

// ── Manual pulls (admins only, any person) ──────────────────────────────────────────────────────

export const listCibilManual = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const none = { on: false, price: 0, rows: [] as CibilReportSummary[] };
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "admin") return none;
    const { on, settings } = await cibilState(caller.clientId);
    if (!on) return none;
    const res = await db()
      .from("cibil_reports")
      .select(REPORT_COLUMNS)
      .eq("client_id", caller.clientId)
      .is("debtor_id", null)
      .order("created_at", { ascending: false })
      .limit(100);
    return {
      on,
      price: priceFor(getService(CIBIL_SERVICE)!, "1", settings.rate_card),
      rows: res.error ? [] : ((res.data ?? []) as Row[]).map(toSummary),
    };
  });

export const runCibilManual = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        form: formSchema,
        phone: z.string().trim().max(15),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (caller.role !== "admin") throw new Error("Only admins can run a manual CIBIL report");
    enforceRateLimit(`cibil:${caller.authUserId}`, 10, 60_000);

    const { on, settings } = await cibilState(caller.clientId);
    if (!on) throw new Error("CIBIL reports are not available for your company.");
    const form = data.form as CibilForm;
    checkForm(form);
    const phone = normalisePhone(data.phone);
    if (!/^[6-9]\d{9}$/.test(phone)) throw new Error("Enter a valid 10-digit mobile number.");

    const service = getService(CIBIL_SERVICE)!;
    const pan = form.pan.trim().toUpperCase();
    const admin = db();

    await admin
      .from("insights_manual_lookups")
      .update({
        state: "failed",
        error: "Abandoned — no response was recorded, so it is not counted as spend.",
        completed_at: new Date().toISOString(),
      })
      .eq("client_id", caller.clientId)
      .eq("service_id", CIBIL_SERVICE)
      .eq("query_key", pan)
      .eq("state", "pending")
      .lt("created_at", new Date(Date.now() - 5 * 60_000).toISOString());
    const { data: pending, error: claimErr } = await admin
      .from("insights_manual_lookups")
      .insert({
        client_id: caller.clientId,
        service_id: CIBIL_SERVICE,
        requested_by: caller.agentId ?? null,
        query_key: pan,
        input: { name: `${form.firstName} ${form.lastName}`.trim(), pan },
        state: "pending",
      })
      .select("id")
      .single();
    if (claimErr || !pending) throw new Error("A report for this PAN is already being pulled.");

    const body = cibilRequestBody(form, phone);
    let call: Awaited<ReturnType<typeof callPayPrime>>;
    try {
      call = await callPayPrime(body);
    } catch (err) {
      await admin
        .from("insights_manual_lookups")
        .update({
          state: "failed",
          error: `Could not reach PayPrime: ${err instanceof Error ? err.message : String(err)}`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", pending.id);
      throw unreachable(err);
    }

    const outcome = readCibilOutcome(call.httpStatus, call.json);
    const cost = outcome.billable ? priceFor(service, outcome.status, settings.rate_card) : 0;
    await admin
      .from("insights_manual_lookups")
      .update(ledgerFields(outcome, call.httpStatus, call.text, cost))
      .eq("id", pending.id);

    if (outcome.status !== "1") {
      throw new Error(failureMessage(outcome, call.httpStatus, call.text));
    }

    const report = await saveReport({
      client_id: caller.clientId,
      debtor_id: null,
      lookup_id: pending.id,
      requested_by: caller.agentId ?? null,
      request: body,
      txn_id: outcome.txnId,
      html_url: outcome.htmlUrl,
      score: outcome.score,
      response: call.json,
      report_html: await captureReportHtml(outcome.htmlUrl),
    });
    return { cost, report };
  });

// ── One report: full data and download ─────────────────────────────────────────────────────────

/** A report the caller may see. A borrower report: anyone who can see that borrower. A manual
 *  report: the company's admins. Either way only while the company's CIBIL switch is on. */
async function loadVisibleReport(accessToken: string, reportId: string, columns: string) {
  const caller = await requireCaller(accessToken);
  const { data: row, error } = await db()
    .from("cibil_reports")
    .select(`client_id, debtor_id, ${columns}`)
    .eq("id", reportId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the report (${error.message})`);
  if (!row || row.client_id !== caller.clientId) throw new Error("Report not found");
  if (!(await cibilState(caller.clientId)).on) throw new Error("Report not found");
  const visible = row.debtor_id
    ? await callerCanSeeDebtor(accessToken, String(row.debtor_id))
    : caller.role === "admin";
  if (!visible) throw new Error("Report not found");
  return row as Row;
}

/** The structured part of PayPrime's response (data.data.cibilData). */
function cibilDataOf(response: unknown): unknown {
  const r = response as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const inner = r?.data?.data ?? r?.data ?? r;
  return inner?.cibilData ?? inner;
}

/** For "Show all fields". */
export const getCibilReportData = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, reportId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const row = await loadVisibleReport(data.accessToken, data.reportId, "response");
    return { response: (row.response as Json | null) ?? null };
  });

/** The report as a file to save on the user's computer: the saved copy of CIBIL's own page
 *  when there is one (captured now if it wasn't at pull time), otherwise a report built from the
 *  structured data. */
export const downloadCibilReport = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, reportId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const row = await loadVisibleReport(
      data.accessToken,
      data.reportId,
      "id, created_at, score, html_url, txn_id, request, response, report_html, agents(name)",
    );
    const summary = toSummary(row);
    let html = (row.report_html as string | null) ?? null;
    if (!html && row.html_url) {
      html = await captureReportHtml(String(row.html_url));
      if (html)
        await db().from("cibil_reports").update({ report_html: html }).eq("id", data.reportId);
    }
    if (!html) {
      html = buildReportHtml({
        subject: summary.subject,
        score: summary.score,
        createdAt: summary.createdAt,
        txnId: summary.txnId,
        htmlUrl: summary.htmlUrl,
        fields: flatten(cibilDataOf(row.response)),
      });
    }
    return { fileName: reportFileName(summary.subject, summary.createdAt), html };
  });
