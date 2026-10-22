// Data purging certificates (migrations/20261020_data_purge_certificates.sql; rules and wording in
// data-purge.ts). A company admin/manager requests one for a portfolio; a superadmin fills in the
// letter and issues it; the company opens and prints it. Everything runs on the service role after
// verifyCaller / verifySuperadminCaller — the table has no policies.

import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z, tokenSchema, idSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { loadBillingProfile } from "./invoice-actions.server";
import { companyDetailsFromRow, fullAddress } from "./company-details";
import { fetchAllRows } from "./fetch-all-rows";
import { todayIstKey } from "./date-filter";
import { istDayKey } from "./monthly-trend";
import {
  buildAllocation,
  defaultToLines,
  purgePeriodLabel,
  type PurgeCertificate,
  type PurgeLetterFields,
} from "./data-purge";
import { appError } from "./app-error";

/** data_purge_requests isn't in the generated Database types until they're regenerated. */
const raw = () => getSupabaseAdmin() as unknown as SupabaseClient;

type Row = Record<string, unknown>;

export type PurgeStatus = "pending" | "issued" | "declined";

export interface PurgeRequestSummary {
  id: string;
  status: PurgeStatus;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

const MISSING_TABLE =
  "Data purging certificates aren't set up yet — run migrations/20261020_data_purge_certificates.sql";

function tableError(code: string, message: string, error: { message: string }): Error {
  return /data_purge_requests/.test(error.message)
    ? new Error(MISSING_TABLE)
    : appError(code, message, error);
}

function toSummary(r: Row): PurgeRequestSummary {
  return {
    id: String(r.id),
    status: r.status as PurgeStatus,
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
    decidedAt: (r.decided_at as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
  };
}

// ── Company side ─────────────────────────────────────────────────────────────

async function requireCompanyCaller(accessToken: string) {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  if (caller.role !== "manager" && caller.role !== "admin") {
    throw new Error("Only managers or admins can request a data purging certificate");
  }
  return caller;
}

/** The portfolio must be one the caller can see — read AS the caller, so RLS decides. */
async function requireVisiblePortfolio(accessToken: string, portfolioId: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw appError("SX-4501", "This is not available right now. Contact SamvadX support.", {
      missing: "SUPABASE_URL/SUPABASE_ANON_KEY (caller-scoped read)",
    });
  }
  const asCaller = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data, error } = await asCaller
    .from("portfolios")
    .select("id")
    .eq("id", portfolioId)
    .maybeSingle();
  if (error) throw appError("SX-4502", "Could not check the portfolio.", error);
  if (!data) throw new Error("Portfolio not found");
}

export interface PurgeCertificateStatus {
  /** Latest request for this portfolio, if any; status "issued" = a certificate to open. */
  request: PurgeRequestSummary | null;
}

async function latestForPortfolio(
  clientId: string,
  portfolioId: string,
): Promise<{ row: Row | null; status: PurgeCertificateStatus }> {
  const { data, error } = await raw()
    .from("data_purge_requests")
    .select("*")
    .eq("client_id", clientId)
    .eq("portfolio_id", portfolioId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw appError("SX-4503", "Could not load the certificate request.", error);
  const r = data as Row | null;
  return {
    row: r,
    status: { request: r ? toSummary(r) : null },
  };
}

export const getPurgeCertificateStatus = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, portfolioId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<PurgeCertificateStatus> => {
    const caller = await requireCompanyCaller(data.accessToken);
    await requireVisiblePortfolio(data.accessToken, data.portfolioId);
    return (await latestForPortfolio(caller.clientId, data.portfolioId)).status;
  });

/** The issued certificate. Each opening is counted, so SamvadX can see it was received. */
export const openPurgeCertificate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, portfolioId: idSchema }).parse(d),
  )
  .handler(async ({ data }): Promise<PurgeCertificate> => {
    const caller = await requireCompanyCaller(data.accessToken);
    await requireVisiblePortfolio(data.accessToken, data.portfolioId);
    const { row } = await latestForPortfolio(caller.clientId, data.portfolioId);
    const certificate =
      row?.status === "issued" ? ((row.certificate as PurgeCertificate | null) ?? null) : null;
    if (!row || !certificate) throw new Error("No certificate has been issued for this portfolio");
    {
      const { error } = await raw()
        .from("data_purge_requests")
        .update({
          view_count: Number(row.view_count ?? 0) + 1,
          last_viewed_at: new Date().toISOString(),
        })
        .eq("id", row.id as string);
      if (error) console.error("[openPurgeCertificate] view count failed:", error);
    }
    return certificate;
  });

export const requestPurgeCertificate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        portfolioId: idSchema,
        note: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<PurgeCertificateStatus> => {
    const caller = await requireCompanyCaller(data.accessToken);
    await requireVisiblePortfolio(data.accessToken, data.portfolioId);
    const current = await latestForPortfolio(caller.clientId, data.portfolioId);
    if (current.status.request?.status === "pending") return current.status;
    const { error } = await raw()
      .from("data_purge_requests")
      .insert({
        client_id: caller.clientId,
        portfolio_id: data.portfolioId,
        requested_by: caller.agentId,
        note: data.note || null,
      });
    // 23505: another request for this portfolio landed first (one pending per portfolio).
    if (error && !/duplicate key|23505/.test(error.message)) {
      throw appError("SX-4504", "Could not send the request.", error);
    }
    return (await latestForPortfolio(caller.clientId, data.portfolioId)).status;
  });

// ── Superadmin side ──────────────────────────────────────────────────────────

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Not authenticated as superadmin");
  return caller;
}

export interface PurgeRequestRow extends PurgeRequestSummary {
  clientId: string;
  companyName: string;
  portfolioId: string;
  portfolioName: string;
  lenderName: string;
  requestedByName: string;
  requestedByEmail: string;
  requestedByRole: string;
  decidedByName: string;
  viewCount: number;
  lastViewedAt: string | null;
  certificate: PurgeCertificate | null;
}

export const listPurgeRequests = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, status: z.enum(["pending", "all"]).optional() }).parse(d),
  )
  .handler(async ({ data }): Promise<{ rows: PurgeRequestRow[] }> => {
    await requireSuperadmin(data.accessToken);
    const admin = raw();
    let q = admin
      .from("data_purge_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(300);
    if (data.status !== "all") q = q.eq("status", "pending");
    const { data: reqs, error } = await q;
    if (error) throw tableError("SX-4505", "Could not load the requests.", error);
    const list = (reqs ?? []) as Row[];
    if (!list.length) return { rows: [] };

    const uniq = (key: string) => [
      ...new Set(list.map((r) => r[key]).filter((x): x is string => typeof x === "string")),
    ];
    const [clients, portfolios, agents, supers] = await Promise.all([
      admin.from("clients").select("id, company_name").in("id", uniq("client_id")),
      admin.from("portfolios").select("id, name, lender_name").in("id", uniq("portfolio_id")),
      admin.from("agents").select("id, name, email, role").in("id", uniq("requested_by")),
      admin.from("superadmins").select("id, name").in("id", uniq("decided_by")),
    ]);
    const byId = (rows: Row[] | null) => new Map((rows ?? []).map((r) => [String(r.id), r]));
    const cMap = byId(clients.data as Row[] | null);
    const pMap = byId(portfolios.data as Row[] | null);
    const aMap = byId(agents.data as Row[] | null);
    const sMap = byId(supers.data as Row[] | null);
    const s = (v: unknown) => (typeof v === "string" ? v : "");

    return {
      rows: list.map((r) => {
        const a = aMap.get(s(r.requested_by));
        const p = pMap.get(s(r.portfolio_id));
        return {
          ...toSummary(r),
          clientId: s(r.client_id),
          companyName: s(cMap.get(s(r.client_id))?.company_name) || "Unknown company",
          portfolioId: s(r.portfolio_id),
          portfolioName: s(p?.name) || "Deleted portfolio",
          lenderName: s(p?.lender_name),
          requestedByName: s(a?.name) || "Unknown",
          requestedByEmail: s(a?.email),
          requestedByRole: s(a?.role),
          decidedByName: s(sMap.get(s(r.decided_by))?.name),
          viewCount: Number(r.view_count ?? 0),
          lastViewedAt: (r.last_viewed_at as string | null) ?? null,
          certificate: (r.certificate as PurgeCertificate | null) ?? null,
        };
      }),
    };
  });

/** The certificate as it would be issued for this request: SamvadX's and the company's details,
 *  the allocation from the portfolio's accounts, and the letter fields (defaults, or the
 *  superadmin's edits). Shared by the preview and by issuing, so they can't disagree. */
async function buildCertificate(
  requestRow: Row,
  letter?: PurgeLetterFields,
): Promise<PurgeCertificate> {
  const admin = raw();
  const clientId = String(requestRow.client_id);
  const portfolioId = String(requestRow.portfolio_id);

  const [supplier, billing, client, portfolio] = await Promise.all([
    loadBillingProfile(),
    admin.from("client_billing").select("*").eq("client_id", clientId).maybeSingle(),
    admin.from("clients").select("company_name").eq("id", clientId).maybeSingle(),
    admin
      .from("portfolios")
      .select("id, name, lender_name, created_at")
      .eq("id", portfolioId)
      .maybeSingle(),
  ]);
  if (portfolio.error) throw appError("SX-4506", "Could not load the portfolio.", portfolio.error);
  if (!portfolio.data) throw new Error("That portfolio no longer exists");
  if (!supplier.legalName) {
    throw new Error("Fill in SamvadX's own details first (Invoices → SamvadX details)");
  }

  const details = billing.data ? companyDetailsFromRow(billing.data as Row) : null;
  const companyName =
    details?.legalName || String((client.data as Row | null)?.company_name ?? "") || "the company";
  const companyAddress = details ? fullAddress(details) : "";
  const p = portfolio.data as Row;

  // Every account the portfolio was allocated with — removed/archived rows included, since the
  // certificate describes what was received, not what is left.
  const { data: debtors, error } = await fetchAllRows<{
    dpd: number | null;
    outstanding_balance: number | string | null;
  }>((from, to) =>
    admin
      .from("debtors")
      .select("dpd, outstanding_balance")
      .eq("portfolio_id", portfolioId)
      .order("id")
      .range(from, to),
  );
  if (error) throw appError("SX-4507", "Could not count the portfolio's accounts.", error);

  return {
    letter: letter ?? {
      letterDate: todayIstKey(),
      period: purgePeriodLabel(istDayKey(String(p.created_at)) || todayIstKey()),
      toLines: defaultToLines({
        legalName: companyName,
        address: companyAddress,
        signatoryDesignation: details?.signatoryDesignation,
      }),
      lenderName: String(p.lender_name ?? ""),
    },
    portfolioName: String(p.name ?? ""),
    company: { legalName: companyName, address: companyAddress },
    supplier: {
      legalName: supplier.legalName,
      address: supplier.address,
      signatoryName: supplier.signatoryName,
      signatoryDesignation: supplier.signatoryDesignation,
    },
    allocation: buildAllocation(
      debtors.map((d) => ({
        dpd: d.dpd == null ? null : Number(d.dpd),
        outstanding: d.outstanding_balance == null ? null : Number(d.outstanding_balance),
      })),
    ),
  };
}

async function loadRequest(id: string): Promise<Row> {
  const { data, error } = await raw()
    .from("data_purge_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw tableError("SX-4508", "Could not load the request.", error);
  if (!data) throw new Error("Request not found");
  return data as Row;
}

const letterSchema = z.object({
  letterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period: z.string().trim().min(1).max(40),
  toLines: z.array(z.string().trim().max(300)).max(8),
  lenderName: z.string().trim().max(200),
});

/** The filled-in certificate for a pending request, for the superadmin to check and edit. */
export const previewPurgeCertificate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({ accessToken: tokenSchema, requestId: idSchema, letter: letterSchema.optional() })
      .parse(d),
  )
  .handler(async ({ data }): Promise<PurgeCertificate> => {
    await requireSuperadmin(data.accessToken);
    const row = await loadRequest(data.requestId);
    return buildCertificate(row, data.letter && cleanLetter(data.letter));
  });

function cleanLetter(l: z.infer<typeof letterSchema>): PurgeLetterFields {
  return { ...l, toLines: l.toLines.filter(Boolean) };
}

export const issuePurgeCertificate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, requestId: idSchema, letter: letterSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const row = await loadRequest(data.requestId);
    if (row.status !== "pending") throw new Error("This request was already decided");
    const certificate = await buildCertificate(row, cleanLetter(data.letter));

    // Only a pending request can be issued — a double-click or two superadmins is a no-op.
    const { data: updated, error } = await raw()
      .from("data_purge_requests")
      .update({
        status: "issued",
        decided_by: caller.superadminId,
        decided_at: new Date().toISOString(),
        certificate,
      })
      .eq("id", data.requestId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw tableError("SX-4509", "Could not issue the certificate.", error);
    if (!updated) throw new Error("This request was already decided");

    await notifyRequester(
      row,
      `The data purging certificate for ${certificate.portfolioName} is ready — open the portfolio and click "Data purging certificate".`,
    );
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "data_purge_certificate_issued",
      clientId: String(row.client_id),
      summary: `Issued the data purging certificate for ${certificate.portfolioName} (${certificate.company.legalName}, ${certificate.letter.period})`,
      detail: {
        requestId: data.requestId,
        portfolioId: String(row.portfolio_id),
        accounts: certificate.allocation.totalAccounts,
      },
    });
    return { ok: true };
  });

export const declinePurgeRequest = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        requestId: idSchema,
        note: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const row = await loadRequest(data.requestId);
    const { data: updated, error } = await raw()
      .from("data_purge_requests")
      .update({
        status: "declined",
        decided_by: caller.superadminId,
        decided_at: new Date().toISOString(),
        decision_note: data.note || null,
      })
      .eq("id", data.requestId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) throw tableError("SX-4510", "Could not decline the request.", error);
    if (!updated) throw new Error("This request was already decided");

    const { data: p } = await raw()
      .from("portfolios")
      .select("name")
      .eq("id", String(row.portfolio_id))
      .maybeSingle();
    const pName = String((p as Row | null)?.name ?? "a portfolio");
    await notifyRequester(
      row,
      `Your data purging certificate request for ${pName} was declined${data.note ? `: ${data.note}` : "."}`,
    );
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "data_purge_request_declined",
      clientId: String(row.client_id),
      summary: `Declined the data purging certificate request for ${pName}`,
      detail: { requestId: data.requestId, note: data.note ?? null },
    });
    return { ok: true };
  });

async function notifyRequester(row: Row, message: string) {
  if (!row.requested_by) return;
  const { error } = await raw().from("notifications").insert({
    client_id: row.client_id,
    to_agent_id: row.requested_by,
    from_name: "SamvadX",
    message,
  });
  if (error) console.error("[data-purge] notification failed:", error);
}
