// Contracts server actions — superadmin side (upload documents, publish/withdraw changes, see who
// accepted) and company-admin side (read own company's contracts, accept changes). Tables are
// server-only (migrations/20261009_contracts.sql), so everything goes through the service role
// after verifySuperadminCaller / verifyCaller. Pure rules live in contracts.ts.

import { companyDetailsFromRow, fullAddress } from "./company-details";
import { agreementEmail, companyAppLink, mailtoLink } from "./billing-delivery";
import { DEFAULT_MASTER_AGREEMENT_BODY, MASTER_AGREEMENT_TITLE } from "./master-agreement";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z, tokenSchema, idSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifyCaller, verifySuperadminCaller } from "./supabase-admin.server";
import { logSuperadminActivity } from "./superadmin-actions.server";
import { isDayKey } from "./superadmin-range";
import { emailConfigured, sendEmails } from "./email.server";
import { loadSettings } from "./profilex-actions.server";
import { PROFILEX_SERVICES, priceLine } from "./profilex/catalogue";
import { todayIstKey } from "./date-filter";
import {
  DEFAULT_TEMPLATE_BODY,
  DEFAULT_TEMPLATE_TITLE,
  fillTemplate,
  templateValueMap,
} from "./contract-template";
import { loadPriceList } from "./price-list.server";
import {
  CONTRACTS_VISIBLE_TO_COMPANIES,
  type DocumentStatus,
  changeAppliesTo,
  changeEmail,
  isPendingFor,
  type ContractAcceptance,
  type ContractChange,
  type ContractDocument,
} from "./contracts";
import { appError } from "./app-error";

export const CONTRACTS_BUCKET = "contracts";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const DOWNLOAD_LINK_SECONDS = 300;

const db = () => getSupabaseAdmin();
/** The contract_* tables aren't in the generated Database types until they are regenerated after
 *  migrations/20261009_contracts.sql — read and write them through an untyped client meanwhile. */
const contractsDb = () => getSupabaseAdmin() as unknown as SupabaseClient;
const daySchema = z.string().refine(isDayKey, "Expected a date (YYYY-MM-DD)");

// ── Row mapping ─────────────────────────────────────────────────────────────

interface DocumentRow {
  id: string;
  client_id: string | null;
  title: string;
  version_label: string | null;
  effective_date: string;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  notes: string | null;
  created_at: string;
}
interface ChangeRow {
  id: string;
  title: string;
  body: string;
  effective_date: string;
  client_ids: string[] | null;
  requires_acceptance: boolean;
  document_id: string | null;
  created_at: string;
  withdrawn_at: string | null;
  status: "draft" | "published";
}
interface AcceptanceRow {
  change_id: string;
  client_id: string;
  accepted_name: string;
  accepted_email: string;
  accepted_at: string;
}

// `body` is left out on purpose: generated documents can be long, and lists only need to know one
// exists (file_path IS NULL ⇒ generated). getContractDocumentBody reads it when opened.
const DOC_COLUMNS =
  "id, client_id, title, version_label, effective_date, file_path, file_name, file_size, notes, created_at";
const CHANGE_COLUMNS =
  "id, title, body, effective_date, client_ids, requires_acceptance, document_id, created_at, withdrawn_at, status";

const toDocument = (r: DocumentRow, companyName: string | null): ContractDocument => ({
  id: r.id,
  clientId: r.client_id,
  companyName,
  title: r.title,
  versionLabel: r.version_label,
  effectiveDate: r.effective_date,
  fileName: r.file_name,
  fileSize: r.file_size === null ? null : Number(r.file_size),
  generated: r.file_path === null,
  notes: r.notes,
  createdAt: r.created_at,
});
const toChange = (r: ChangeRow): ContractChange => ({
  id: r.id,
  title: r.title,
  body: r.body,
  effectiveDate: r.effective_date,
  clientIds: r.client_ids,
  requiresAcceptance: r.requires_acceptance,
  documentId: r.document_id,
  createdAt: r.created_at,
  withdrawnAt: r.withdrawn_at,
  status: r.status ?? "published",
});
const toAcceptance = (r: AcceptanceRow): ContractAcceptance => ({
  clientId: r.client_id,
  acceptedName: r.accepted_name,
  acceptedEmail: r.accepted_email,
  acceptedAt: r.accepted_at,
});

interface StatusRow {
  document_id: string;
  client_id: string;
  sent_at: string | null;
  sent_to: string | null;
  sent_via: "resend" | "mail_app" | null;
  viewed_at: string | null;
  viewed_by_agent?: string | null;
  signed_at: string | null;
  signed_name: string | null;
  signed_email: string | null;
}
const STATUS_COLUMNS =
  "document_id, client_id, sent_at, sent_to, sent_via, viewed_at, viewed_by_agent, signed_at, signed_name, signed_email";
const toStatus = (
  r: StatusRow,
  viewer?: { name: string; email: string } | undefined,
): DocumentStatus => ({
  documentId: r.document_id,
  clientId: r.client_id,
  sentAt: r.sent_at,
  sentTo: r.sent_to,
  sentVia: r.sent_via,
  viewedAt: r.viewed_at,
  viewedByName: viewer?.name ?? null,
  viewedByEmail: viewer?.email ?? null,
  signedAt: r.signed_at,
  signedName: r.signed_name,
  signedEmail: r.signed_email,
});

/** Every status row, or one company's. A database without the table (code ahead of
 *  migrations/20261012_billing_delivery.sql) reads as "nothing sent/viewed/signed yet". */
async function loadStatuses(clientId?: string): Promise<DocumentStatus[]> {
  let q = contractsDb().from("contract_document_status").select(STATUS_COLUMNS);
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q;
  if (error) return [];
  const rows = (data ?? []) as StatusRow[];
  const viewerIds = [
    ...new Set(rows.map((r) => r.viewed_by_agent).filter((x): x is string => !!x)),
  ];
  const viewers = new Map<string, { name: string; email: string }>();
  if (viewerIds.length) {
    const { data: agents } = await db()
      .from("agents")
      .select("id, name, email")
      .in("id", viewerIds);
    for (const a of agents ?? []) viewers.set(a.id, { name: a.name, email: a.email });
  }
  return rows.map((r) =>
    toStatus(r, r.viewed_by_agent ? viewers.get(r.viewed_by_agent) : undefined),
  );
}

/** First time a company admin opens a document: record it (never overwrites an earlier view). */
async function markDocumentViewed(
  documentId: string,
  clientId: string,
  agentId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const { data: existing } = await contractsDb()
    .from("contract_document_status")
    .select("viewed_at")
    .eq("document_id", documentId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (existing) {
    if (!(existing as { viewed_at: string | null }).viewed_at) {
      await contractsDb()
        .from("contract_document_status")
        .update({ viewed_at: now, viewed_by_agent: agentId })
        .eq("document_id", documentId)
        .eq("client_id", clientId)
        .is("viewed_at", null);
    }
    return;
  }
  // 23505 = another admin opened it at the same moment; the first view is already recorded.
  await contractsDb()
    .from("contract_document_status")
    .insert({
      document_id: documentId,
      client_id: clientId,
      viewed_at: now,
      viewed_by_agent: agentId,
    });
}

async function requireSuperadmin(accessToken: string) {
  const caller = await verifySuperadminCaller(accessToken);
  if (!caller) throw new Error("Not authenticated as superadmin");
  return caller;
}

/** Company admins only (verifyCaller already requires the emailed sign-in code for admins). */
async function requireCompanyAdmin(accessToken: string) {
  // Superadmin-only for now — see CONTRACTS_VISIBLE_TO_COMPANIES.
  if (!CONTRACTS_VISIBLE_TO_COMPANIES) throw new Error("Contracts aren't available yet");
  const caller = await verifyCaller(accessToken);
  if (!caller || caller.role !== "admin") throw new Error("Only company admins can do this");
  return caller;
}

async function ensureBucket(): Promise<void> {
  const storage = db().storage;
  const { data } = await storage.getBucket(CONTRACTS_BUCKET);
  if (data) return;
  const { error } = await storage.createBucket(CONTRACTS_BUCKET, {
    public: false,
    allowedMimeTypes: Object.values(FILE_TYPES),
    fileSizeLimit: "20MB",
  });
  // A concurrent upload may have just created it — only a genuine failure matters.
  if (error && !/already exists/i.test(error.message)) {
    throw appError("SX-4301", "Could not create the contracts storage bucket.", error);
  }
}

/** Active admins of these companies — who gets notified about a change. */
async function adminsOf(clientIds: string[] | null) {
  let q = db().from("agents").select("id, client_id, name, email, is_active").eq("role", "admin");
  if (clientIds) q = q.in("client_id", clientIds);
  const { data, error } = await q;
  if (error) throw appError("SX-4302", "Could not load company admins.", error);
  return (
    (data ?? []) as {
      id: string;
      client_id: string | null;
      name: string;
      email: string;
      is_active: boolean | null;
    }[]
  ).filter((a) => a.client_id && a.is_active !== false);
}

// ── Superadmin ──────────────────────────────────────────────────────────────

export interface SuperadminContractChange extends ContractChange {
  /** One row per company the change applies to (approved companies only). */
  companies: {
    clientId: string;
    companyName: string;
    acceptance: ContractAcceptance | null;
    adminEmails: string[];
    /** When an admin of this company first saw the notice (Billing & Agreements), or null. */
    viewedAt: string | null;
  }[];
}

export interface SuperadminContractsView {
  /** CONTRACTS_VISIBLE_TO_COMPANIES — the page explains what that means. */
  companiesCanSee: boolean;
  /** Whether Resend is configured (RESEND_API_KEY + EMAIL_FROM on the server). */
  emailConfigured: boolean;
  companies: { id: string; name: string; adminEmails: string[]; billingEmail: string | null }[];
  documents: ContractDocument[];
  /** Sent / viewed / signed, per document and company. */
  statuses: DocumentStatus[];
  /** Published changes only. */
  changes: SuperadminContractChange[];
  /** Unpublished drafts (e.g. made when a company's prices changed) — never shown to companies. */
  drafts: (ContractChange & { companyNames: string[] })[];
  templates: ContractTemplate[];
}

export interface ContractTemplate {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

export const getSuperadminContracts = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<SuperadminContractsView> => {
    await requireSuperadmin(data.accessToken);
    const admin = db();
    const [statuses, billingRes, viewsRes] = await Promise.all([
      loadStatuses(),
      admin.from("client_billing").select("client_id, email"),
      contractsDb().from("contract_change_views").select("change_id, client_id, viewed_at"),
    ]);
    const viewedAt = new Map(
      ((viewsRes.error ? [] : viewsRes.data) ?? []).map(
        (v: { change_id: string; client_id: string; viewed_at: string }) => [
          `${v.change_id}|${v.client_id}`,
          v.viewed_at,
        ],
      ),
    );
    const billingEmail = new Map(
      ((billingRes.data ?? []) as { client_id: string; email: string | null }[]).map((b) => [
        b.client_id,
        b.email,
      ]),
    );
    const [clientsRes, docsRes, changesRes, accRes, admins, templatesRes] = await Promise.all([
      admin.from("clients").select("id, company_name, status").order("company_name"),
      contractsDb()
        .from("contract_documents")
        .select(DOC_COLUMNS)
        .order("effective_date", { ascending: false })
        .order("created_at", { ascending: false }),
      contractsDb()
        .from("contract_changes")
        .select(CHANGE_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(500),
      contractsDb()
        .from("contract_acceptances")
        .select("change_id, client_id, accepted_name, accepted_email, accepted_at"),
      adminsOf(null),
      contractsDb()
        .from("contract_templates")
        .select("id, title, body, updated_at")
        .order("updated_at", { ascending: false }),
    ]);
    for (const r of [clientsRes, docsRes, changesRes, accRes]) {
      if (r.error) throw appError("SX-4303", "Could not load contracts.", r.error);
    }
    const clients = (clientsRes.data ?? []) as {
      id: string;
      company_name: string;
      status: string;
    }[];
    const live = clients.filter((c) => c.status === "approved");
    const nameById = new Map(clients.map((c) => [c.id, c.company_name]));
    const emailsByClient = new Map<string, string[]>();
    for (const a of admins) {
      const list = emailsByClient.get(a.client_id!) ?? [];
      list.push(a.email);
      emailsByClient.set(a.client_id!, list);
    }
    const accByKey = new Map(
      ((accRes.data ?? []) as AcceptanceRow[]).map((r) => [
        `${r.change_id}|${r.client_id}`,
        toAcceptance(r),
      ]),
    );

    return {
      companiesCanSee: CONTRACTS_VISIBLE_TO_COMPANIES,
      emailConfigured: emailConfigured(),
      companies: live.map((c) => ({
        id: c.id,
        name: c.company_name,
        adminEmails: emailsByClient.get(c.id) ?? [],
        billingEmail: billingEmail.get(c.id) ?? null,
      })),
      statuses,
      documents: ((docsRes.data ?? []) as DocumentRow[]).map((r) =>
        toDocument(r, r.client_id ? (nameById.get(r.client_id) ?? null) : null),
      ),
      drafts: ((changesRes.data ?? []) as ChangeRow[])
        .map(toChange)
        .filter((c) => c.status === "draft")
        .map((c) => ({
          ...c,
          companyNames: c.clientIds ? c.clientIds.map((id) => nameById.get(id) ?? "Unknown") : [],
        })),
      // Code deployed ahead of the templates migration: no templates, not an error.
      templates: templatesRes.error
        ? []
        : (
            (templatesRes.data ?? []) as {
              id: string;
              title: string;
              body: string;
              updated_at: string;
            }[]
          ).map((t) => ({ id: t.id, title: t.title, body: t.body, updatedAt: t.updated_at })),
      changes: ((changesRes.data ?? []) as ChangeRow[])
        .filter((r) => (r.status ?? "published") === "published")
        .map((r) => {
          const change = toChange(r);
          return {
            ...change,
            companies: live
              .filter((c) => changeAppliesTo(change, c.id))
              .map((c) => ({
                clientId: c.id,
                companyName: c.company_name,
                acceptance: accByKey.get(`${change.id}|${c.id}`) ?? null,
                adminEmails: emailsByClient.get(c.id) ?? [],
                viewedAt: (viewedAt.get(`${change.id}|${c.id}`) as string | undefined) ?? null,
              })),
          };
        }),
    };
  });

/** Step 1 of an upload: a one-time signed URL the browser uploads the file to directly, so the
 *  file never passes through this server. Step 2 is saveContractDocument. */
export const createContractUpload = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema.nullable(),
        fileName: z.string().trim().min(1).max(200),
        fileSize: z.number().int().positive(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const ext = data.fileName.split(".").pop()?.toLowerCase() ?? "";
    if (!FILE_TYPES[ext]) throw new Error("Upload a PDF or Word (.docx) file");
    if (data.fileSize > MAX_FILE_BYTES) throw new Error("The file is larger than 20 MB");
    await ensureBucket();
    const path = `${data.clientId ?? "platform"}/${randomUUID()}.${ext}`;
    const { data: signed, error } = await db()
      .storage.from(CONTRACTS_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !signed) throw appError("SX-4304", "Could not start the upload.", error);
    return { bucket: CONTRACTS_BUCKET, path, token: signed.token, contentType: FILE_TYPES[ext] };
  });

export const saveContractDocument = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema.nullable(),
        title: z.string().trim().min(1).max(200),
        versionLabel: z.string().trim().max(40).optional(),
        effectiveDate: daySchema,
        path: z.string().max(300),
        fileName: z.string().trim().min(1).max(200),
        fileSize: z.number().int().positive(),
        notes: z.string().trim().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    // The path must be one createContractUpload could have issued for this company.
    const folder = data.clientId ?? "platform";
    const [prefix, objectName] = data.path.split("/");
    if (prefix !== folder || !objectName || data.path.split("/").length !== 2) {
      throw new Error("That upload doesn't belong to this contract");
    }
    const { data: listed, error: listErr } = await db()
      .storage.from(CONTRACTS_BUCKET)
      .list(folder, { search: objectName, limit: 1 });
    if (listErr || !listed?.some((o) => o.name === objectName)) {
      throw new Error("The file didn't finish uploading — try again");
    }
    const { data: row, error } = await contractsDb()
      .from("contract_documents")
      .insert({
        client_id: data.clientId,
        title: data.title,
        version_label: data.versionLabel || null,
        effective_date: data.effectiveDate,
        file_path: data.path,
        file_name: data.fileName,
        file_size: data.fileSize,
        notes: data.notes || null,
        created_by: caller.superadminId,
      })
      .select("id")
      .single();
    if (error || !row) throw appError("SX-4305", "Could not save the contract.", error);

    let companyName: string | null = null;
    if (data.clientId) {
      const { data: c } = await db()
        .from("clients")
        .select("company_name")
        .eq("id", data.clientId)
        .maybeSingle();
      companyName = (c as { company_name: string } | null)?.company_name ?? null;
    }
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_uploaded",
      clientId: data.clientId,
      summary: data.clientId
        ? `Uploaded "${data.title}" for ${companyName ?? "a company"}`
        : `Uploaded SamvadX platform terms "${data.title}"`,
      detail: { documentId: (row as { id: string }).id, effectiveDate: data.effectiveDate },
    });
    return { id: (row as { id: string }).id };
  });

/** Tells every active admin of the companies a change applies to — in the app (the bell) and
 *  by email when Resend is set up. Nobody is told while contracts are superadmin-only. A failed
 *  notification or email never undoes the publish. */
async function notifyChange(change: {
  title: string;
  body: string;
  effectiveDate: string;
  requiresAcceptance: boolean;
  clientIds: string[] | null;
}) {
  const admins = CONTRACTS_VISIBLE_TO_COMPANIES ? await adminsOf(change.clientIds) : [];
  let emailed: number | null = null;
  if (admins.length) {
    const message = change.requiresAcceptance
      ? `Contract update: "${change.title}" (effective ${change.effectiveDate}). Please review and accept it under Contracts.`
      : `Contract update: "${change.title}" (effective ${change.effectiveDate}). See Contracts for details.`;
    const { error: nErr } = await db()
      .from("notifications")
      .insert(
        admins.map((a) => ({
          client_id: a.client_id,
          to_agent_id: a.id,
          from_name: "SamvadX",
          message,
        })),
      );
    if (nErr) console.error("[contracts] notifications failed:", nErr);
    const { subject, text } = changeEmail(change);
    emailed = await sendEmails(admins.map((a) => ({ to: a.email, subject, text })));
  }
  return { admins, emailed };
}

export const publishContractChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(5000),
        effectiveDate: daySchema,
        /** null = every company. */
        clientIds: z.array(idSchema).min(1).max(500).nullable(),
        requiresAcceptance: z.boolean(),
        documentId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const clientIds = data.clientIds ? [...new Set(data.clientIds)] : null;

    const { data: row, error } = await contractsDb()
      .from("contract_changes")
      .insert({
        title: data.title,
        body: data.body,
        effective_date: data.effectiveDate,
        client_ids: clientIds,
        requires_acceptance: data.requiresAcceptance,
        document_id: data.documentId ?? null,
        created_by: caller.superadminId,
        status: "published",
        published_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !row) throw appError("SX-4306", "Could not publish the change.", error);

    const { admins, emailed } = await notifyChange({
      title: data.title,
      body: data.body,
      effectiveDate: data.effectiveDate,
      requiresAcceptance: data.requiresAcceptance,
      clientIds,
    });

    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_change_published",
      clientId: clientIds?.length === 1 ? clientIds[0] : null,
      summary: `Published contract change "${data.title}" to ${clientIds ? `${clientIds.length} compan${clientIds.length === 1 ? "y" : "ies"}` : "every company"}`,
      detail: {
        changeId: (row as { id: string }).id,
        requiresAcceptance: data.requiresAcceptance,
        notifiedAdmins: admins.length,
        emailedAdmins: emailed ?? 0,
      },
    });
    return {
      id: (row as { id: string }).id,
      /** False while contracts are superadmin-only: nobody was notified or emailed. */
      companiesCanSee: CONTRACTS_VISIBLE_TO_COMPANIES,
      notifiedAdmins: admins.length,
      /** Emails Resend accepted; null when email isn't set up (use the mailto fallback). */
      emailedAdmins: emailed,
      adminEmails: admins.map((a) => a.email),
    };
  });

export const withdrawContractChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, changeId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { data: row, error } = await contractsDb()
      .from("contract_changes")
      .update({ withdrawn_at: new Date().toISOString(), withdrawn_by: caller.superadminId })
      .eq("id", data.changeId)
      .eq("status", "published")
      .is("withdrawn_at", null)
      .select("title")
      .maybeSingle();
    if (error) throw appError("SX-4307", "Could not withdraw the change.", error);
    if (!row) throw new Error("That change was already withdrawn");
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_change_withdrawn",
      summary: `Withdrew contract change "${(row as { title: string }).title}"`,
      detail: { changeId: data.changeId },
    });
    return { ok: true };
  });

// ── Company admin ───────────────────────────────────────────────────────────

export interface AdminContractChange extends ContractChange {
  acceptance: ContractAcceptance | null;
  pending: boolean;
}

export interface AdminContractsView {
  companyName: string;
  platformDocuments: ContractDocument[];
  companyDocuments: ContractDocument[];
  changes: AdminContractChange[];
  pendingCount: number;
  /** This company's sent / viewed / signed record per document. */
  statuses: DocumentStatus[];
}

async function loadAdminView(clientId: string): Promise<AdminContractsView> {
  const admin = db();
  const [clientRes, docsRes, changesRes, accRes] = await Promise.all([
    admin.from("clients").select("company_name").eq("id", clientId).maybeSingle(),
    contractsDb()
      .from("contract_documents")
      .select(DOC_COLUMNS)
      .or(`client_id.is.null,client_id.eq.${clientId}`)
      .order("effective_date", { ascending: false })
      .order("created_at", { ascending: false }),
    contractsDb()
      .from("contract_changes")
      .select(CHANGE_COLUMNS)
      .eq("status", "published")
      .or(`client_ids.is.null,client_ids.cs.{${clientId}}`)
      .order("created_at", { ascending: false })
      .limit(500),
    contractsDb()
      .from("contract_acceptances")
      .select("change_id, client_id, accepted_name, accepted_email, accepted_at")
      .eq("client_id", clientId),
  ]);
  for (const r of [docsRes, changesRes, accRes]) {
    if (r.error) throw appError("SX-4308", "Could not load contracts.", r.error);
  }
  const companyName =
    (clientRes.data as { company_name: string } | null)?.company_name ?? "Your company";
  const docs = ((docsRes.data ?? []) as DocumentRow[]).map((r) =>
    toDocument(r, r.client_id ? companyName : null),
  );
  const accByChange = new Map(
    ((accRes.data ?? []) as AcceptanceRow[]).map((r) => [r.change_id, toAcceptance(r)]),
  );
  const changes = ((changesRes.data ?? []) as ChangeRow[])
    .map(toChange)
    // Belt and braces over the SQL filter: never show another company's change.
    .filter((c) => changeAppliesTo(c, clientId))
    .map((c) => {
      const acceptance = accByChange.get(c.id) ?? null;
      return { ...c, acceptance, pending: isPendingFor(c, clientId, acceptance ?? undefined) };
    });
  // The company's admin is looking at every notice listed here: record the first time for each,
  // so the superadmin can tell "seen" from "never opened". Best-effort.
  const shown = changes.filter((c) => !c.withdrawnAt).map((c) => c.id);
  if (shown.length) {
    await contractsDb()
      .from("contract_change_views")
      .upsert(
        shown.map((id) => ({ change_id: id, client_id: clientId })),
        { onConflict: "change_id,client_id", ignoreDuplicates: true },
      );
  }
  return {
    companyName,
    platformDocuments: docs.filter((d) => d.clientId === null),
    companyDocuments: docs.filter((d) => d.clientId === clientId),
    changes,
    pendingCount: changes.filter((c) => c.pending).length,
    statuses: await loadStatuses(clientId),
  };
}

export const getMyContracts = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }): Promise<AdminContractsView> => {
    const caller = await requireCompanyAdmin(data.accessToken);
    return loadAdminView(caller.clientId);
  });

/** Just the number of changes waiting for acceptance — the admin-wide banner. */
export const getMyPendingContractCount = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCompanyAdmin(data.accessToken);
    const view = await loadAdminView(caller.clientId);
    return { pending: view.pendingCount };
  });

export const acceptContractChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        changeId: idSchema,
        /** The admin types their name as their acceptance. */
        fullName: z.string().trim().min(2).max(200),
        confirm: z.literal(true),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCompanyAdmin(data.accessToken);
    const admin = db();
    const [{ data: changeRow, error }, { data: me }] = await Promise.all([
      contractsDb()
        .from("contract_changes")
        .select(CHANGE_COLUMNS)
        .eq("id", data.changeId)
        .maybeSingle(),
      admin.from("agents").select("email").eq("id", caller.agentId!).maybeSingle(),
    ]);
    if (error || !changeRow) throw new Error("That contract change wasn't found");
    const change = toChange(changeRow as ChangeRow);
    if (!changeAppliesTo(change, caller.clientId)) {
      throw new Error("That contract change wasn't found");
    }
    if (change.status !== "published") throw new Error("That contract change wasn't found");
    if (change.withdrawnAt) throw new Error("That change was withdrawn — nothing to accept");
    if (!change.requiresAcceptance) throw new Error("That change doesn't need acceptance");

    const { error: insErr } = await contractsDb()
      .from("contract_acceptances")
      .insert({
        change_id: change.id,
        client_id: caller.clientId,
        agent_id: caller.agentId,
        accepted_name: data.fullName,
        accepted_email: (me as { email: string } | null)?.email ?? "",
      });
    if (insErr) {
      // 23505 = unique violation: another admin of the same company accepted first.
      if ((insErr as { code?: string }).code === "23505") {
        throw new Error("Someone at your company has already accepted this change");
      }
      throw appError("SX-4309", "Could not record your acceptance.", insErr);
    }
    return { ok: true };
  });

// ── Both sides ──────────────────────────────────────────────────────────────

/** A short-lived download link. Superadmins may open any document; a company admin only the
 *  platform terms and their own company's documents. */
export const getContractFileUrl = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, documentId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const admin = db();
    // Who is asking comes first — nothing is looked up for an unknown caller.
    const superadmin = await verifySuperadminCaller(data.accessToken);
    const companyAdmin = superadmin ? null : await requireCompanyAdmin(data.accessToken);
    const companyClientId = companyAdmin?.clientId ?? null;

    const { data: row, error } = await contractsDb()
      .from("contract_documents")
      .select("client_id, file_path, file_name")
      .eq("id", data.documentId)
      .maybeSingle();
    if (error || !row) throw new Error("That document wasn't found");
    const doc = row as { client_id: string | null; file_path: string | null; file_name: string };
    if (!doc.file_path) throw new Error("This document was generated — open it to view or print");
    // A company admin may open the platform terms and their own company's documents only.
    if (companyClientId && doc.client_id !== null && doc.client_id !== companyClientId) {
      throw new Error("That document wasn't found");
    }
    if (companyClientId) {
      await markDocumentViewed(data.documentId, companyClientId, companyAdmin?.agentId ?? null);
    }
    const { data: signed, error: sErr } = await admin.storage
      .from(CONTRACTS_BUCKET)
      .createSignedUrl(doc.file_path, DOWNLOAD_LINK_SECONDS, { download: doc.file_name });
    if (sErr || !signed) throw appError("SX-4310", "Could not open the file.", sErr);
    return { url: signed.signedUrl };
  });

// ── Drafts (made automatically when a company's prices change) ──────────────

/**
 * Records a price change as a DRAFT contract change for one company — reviewed and published
 * (or discarded) on Superadmin → Contracts; never shown to the company while a draft. Called by
 * savePriceList and the Insights price save. Returns the draft id, or null if it couldn't be
 * written (the price change itself must still succeed).
 */
export async function createPriceChangeDraft(
  superadminId: string,
  clientId: string,
  changes: string[],
): Promise<string | null> {
  const { data: c } = await db()
    .from("clients")
    .select("company_name")
    .eq("id", clientId)
    .maybeSingle();
  const company = (c as { company_name: string } | null)?.company_name ?? "this company";
  const { data, error } = await contractsDb()
    .from("contract_changes")
    .insert({
      title: `Price update for ${company}`,
      body: [
        "The following prices change:",
        "",
        ...changes.map((ch) => `- ${ch}`),
        "",
        "All other terms stay the same.",
      ].join("\n"),
      effective_date: todayIstKey(),
      client_ids: [clientId],
      requires_acceptance: true,
      status: "draft",
      created_by: superadminId,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[contracts] could not draft a price-change contract update:", error.message);
    return null;
  }
  return (data as { id: string }).id;
}

export const updateDraftChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        changeId: idSchema,
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(5000),
        effectiveDate: daySchema,
        requiresAcceptance: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const { data: row, error } = await contractsDb()
      .from("contract_changes")
      .update({
        title: data.title,
        body: data.body,
        effective_date: data.effectiveDate,
        requires_acceptance: data.requiresAcceptance,
      })
      .eq("id", data.changeId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (error) throw appError("SX-4311", "Could not save the draft.", error);
    if (!row) throw new Error("That draft was already published or discarded");
    return { ok: true };
  });

export const publishDraftChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, changeId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { data: row, error } = await contractsDb()
      .from("contract_changes")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", data.changeId)
      .eq("status", "draft")
      .select(CHANGE_COLUMNS)
      .maybeSingle();
    if (error) throw appError("SX-4312", "Could not publish the draft.", error);
    if (!row) throw new Error("That draft was already published or discarded");
    const change = toChange(row as ChangeRow);
    const { admins, emailed } = await notifyChange(change);
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_change_published",
      clientId: change.clientIds?.length === 1 ? change.clientIds[0] : null,
      summary: `Published contract change "${change.title}"`,
      detail: { changeId: change.id, notifiedAdmins: admins.length, emailedAdmins: emailed ?? 0 },
    });
    return {
      companiesCanSee: CONTRACTS_VISIBLE_TO_COMPANIES,
      notifiedAdmins: admins.length,
      emailedAdmins: emailed,
      adminEmails: admins.map((a) => a.email),
    };
  });

export const discardDraftChange = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, changeId: idSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    // Deleting is fine for a draft: no company ever saw it.
    const { data: row, error } = await contractsDb()
      .from("contract_changes")
      .delete()
      .eq("id", data.changeId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (error) throw appError("SX-4313", "Could not discard the draft.", error);
    if (!row) throw new Error("That draft was already published or discarded");
    return { ok: true };
  });

// ── Templates and generated documents ───────────────────────────────────────

const fmtLongDate = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** Everything a template can mention about one company, read fresh from the database. */
/** Everything a template can mention about one company and SamvadX's own company.
 *  `effectiveDate` null = the master agreement before signing (it takes effect on signing);
 *  `signing` fills who signed and when (frozen into the signed copy). */
async function templateValuesFor(
  clientId: string,
  effectiveDate: string | null,
  signing?: { by: string; date: string },
) {
  const admin = db();
  const [clientRes, billingRes, profileRes, prices, insights] = await Promise.all([
    admin
      .from("clients")
      .select("company_name, max_agents, max_managers")
      .eq("id", clientId)
      .maybeSingle(),
    admin.from("client_billing").select("*").eq("client_id", clientId).maybeSingle(),
    admin.from("billing_profile").select("*").eq("id", "main").maybeSingle(),
    loadPriceList(clientId),
    loadSettings(clientId),
  ]);
  const client = clientRes.data as {
    company_name: string;
    max_agents: number | null;
    max_managers: number | null;
  } | null;
  if (!client) throw new Error("That company wasn't found");
  const billing = billingRes.data as {
    legal_name: string;
    gstin: string | null;
    address: string;
  } | null;
  const details = companyDetailsFromRow(billingRes.data as Record<string, unknown> | null);
  const profile = profileRes.data as {
    legal_name: string;
    payment_terms_days: number | null;
    address: string | null;
    cin?: string | null;
    pan?: string | null;
    gstin?: string | null;
    short_name?: string | null;
    signatory_name?: string | null;
    signatory_designation?: string | null;
  } | null;
  const enabled = new Set(insights.enabled_services);
  return templateValueMap({
    companyName: client.company_name,
    companyLegalName: billing?.legal_name ?? "",
    companyGstin: billing?.gstin ?? null,
    companyAddress: billing?.address ? fullAddress(details) : "",
    companyPan: details.pan,
    companyCin: details.cin,
    companyEmail: details.email,
    companyPhone: details.phone,
    companySignatoryName: details.signatoryName,
    companySignatoryDesignation: details.signatoryDesignation,
    supplierLegalName: profile?.legal_name ?? "",
    supplierShortName: profile?.short_name ?? "",
    supplierCin: profile?.cin ?? "",
    supplierPan: profile?.pan ?? "",
    supplierGstin: profile?.gstin ?? null,
    supplierAddress: profile?.address ?? "",
    supplierSignatoryName: profile?.signatory_name ?? "",
    supplierSignatoryDesignation: profile?.signatory_designation ?? "",
    signedBy: signing?.by,
    signedDate: signing ? fmtLongDate(signing.date) : undefined,
    effectiveDate: signing
      ? fmtLongDate(signing.date)
      : effectiveDate
        ? fmtLongDate(effectiveDate)
        : "the date of signing below",
    today: fmtLongDate(todayIstKey()),
    prices,
    paymentTermsDays: prices.paymentTermsDays ?? profile?.payment_terms_days ?? 15,
    agentSeatLimit: client.max_agents,
    managerSeatLimit: client.max_managers,
    insightsPrices: PROFILEX_SERVICES.filter((s) => enabled.has(s.id)).map((s) => [
      s.label,
      priceLine(s, insights.rate_card),
    ]),
  });
}

export const saveContractTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        /** Omit to create a new template. */
        templateId: idSchema.optional(),
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(50000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const now = new Date().toISOString();
    const q = data.templateId
      ? contractsDb()
          .from("contract_templates")
          .update({ title: data.title, body: data.body, updated_at: now })
          .eq("id", data.templateId)
      : contractsDb()
          .from("contract_templates")
          .insert({ title: data.title, body: data.body, created_by: caller.superadminId });
    const { data: row, error } = await q.select("id").single();
    if (error || !row) throw appError("SX-4314", "Could not save the template.", error);
    return { id: (row as { id: string }).id };
  });

/** The starter template, for the "New template" button. */
export const getDefaultContractTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    return { title: DEFAULT_TEMPLATE_TITLE, body: DEFAULT_TEMPLATE_BODY };
  });

/** Fills a template (saved or still being edited) for one company, without saving anything. */
export const previewContractTemplate = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        body: z.string().max(50000),
        effectiveDate: daySchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    return fillTemplate(data.body, await templateValuesFor(data.clientId, data.effectiveDate));
  });

/** Generates a company's document from a template and its current prices, and saves it as a
 *  new version. The text is frozen: later price changes never rewrite it. */
export const generateCompanyContract = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        clientId: idSchema,
        templateId: idSchema,
        title: z.string().trim().min(1).max(200),
        versionLabel: z.string().trim().max(40).optional(),
        effectiveDate: daySchema,
        notes: z.string().trim().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const { data: tpl, error: tErr } = await contractsDb()
      .from("contract_templates")
      .select("body")
      .eq("id", data.templateId)
      .maybeSingle();
    if (tErr || !tpl) throw new Error("That template wasn't found");
    const filled = fillTemplate(
      (tpl as { body: string }).body,
      await templateValuesFor(data.clientId, data.effectiveDate),
    );
    if (filled.unknown.length) {
      throw new Error(
        `The template has blanks SamvadX doesn't know: ${filled.unknown.map((u) => `{{${u}}}`).join(", ")}`,
      );
    }
    const { data: row, error } = await contractsDb()
      .from("contract_documents")
      .insert({
        client_id: data.clientId,
        title: data.title,
        version_label: data.versionLabel || null,
        effective_date: data.effectiveDate,
        body: filled.text,
        template_id: data.templateId,
        notes: data.notes || null,
        created_by: caller.superadminId,
      })
      .select("id")
      .single();
    if (error || !row) throw appError("SX-4315", "Could not save the document.", error);
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_generated",
      clientId: data.clientId,
      summary: `Generated "${data.title}" from a template`,
      detail: { documentId: (row as { id: string }).id },
    });
    return { id: (row as { id: string }).id };
  });

/** The text of a generated document. Same access rule as file downloads. */
export const getContractDocumentBody = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        documentId: idSchema,
        /** Superadmin: show the master agreement as this company sees it. */
        asClientId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const superadmin = await verifySuperadminCaller(data.accessToken);
    const companyAdmin = superadmin ? null : await requireCompanyAdmin(data.accessToken);
    const companyClientId = companyAdmin?.clientId ?? null;
    const { data: row, error } = await contractsDb()
      .from("contract_documents")
      .select("client_id, title, version_label, body")
      .eq("id", data.documentId)
      .maybeSingle();
    const doc = row as {
      client_id: string | null;
      title: string;
      version_label: string | null;
      body: string | null;
    } | null;
    if (error || !doc || !doc.body) throw new Error("That document wasn't found");
    if (companyClientId && doc.client_id !== null && doc.client_id !== companyClientId) {
      throw new Error("That document wasn't found");
    }
    if (companyClientId) {
      await markDocumentViewed(data.documentId, companyClientId, companyAdmin?.agentId ?? null);
    }
    const forClient = companyClientId ?? data.asClientId ?? null;
    return {
      title: doc.title,
      versionLabel: doc.version_label,
      body: forClient ? await bodyForCompany(data.documentId, doc.body, forClient) : doc.body,
    };
  });

/** A document's text as one company sees it: the copy they signed if they have, otherwise the
 *  {{placeholders}} filled with both parties' details as they are now. */
async function bodyForCompany(documentId: string, body: string, clientId: string): Promise<string> {
  if (!body.includes("{{")) return body;
  const { data: st } = await contractsDb()
    .from("contract_document_status")
    .select("signed_body")
    .eq("document_id", documentId)
    .eq("client_id", clientId)
    .maybeSingle();
  const signed = (st as { signed_body: string | null } | null)?.signed_body;
  if (signed) return signed;
  return fillTemplate(body, await templateValuesFor(clientId, null)).text;
}

// ── The master agreement: one text for every company ────────────────────────

/** The master agreement as it stands: the latest published version (a platform document with
 *  text), or the starting text from "Samvadx Aggrement.docx" if none is published yet. */
export const getMasterAgreement = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    await requireSuperadmin(data.accessToken);
    const [{ data: rows }, { data: profile }] = await Promise.all([
      contractsDb()
        .from("contract_documents")
        .select("id, title, version_label, effective_date, body, created_at")
        .is("client_id", null)
        .not("body", "is", null)
        .order("created_at", { ascending: false })
        .limit(1),
      db().from("billing_profile").select("*").eq("id", "main").maybeSingle(),
    ]);
    const latest = (
      (rows ?? []) as {
        id: string;
        title: string;
        version_label: string | null;
        effective_date: string;
        body: string;
        created_at: string;
      }[]
    )[0];
    // What the agreement needs from SamvadX's own details, still missing.
    const p = (profile ?? {}) as Record<string, string | null>;
    const supplierMissing = [
      ["legal_name", "Legal name"],
      ["short_name", "Short name"],
      ["cin", "CIN"],
      ["address", "Registered address"],
      ["signatory_name", "Authorised signatory"],
      ["signatory_designation", "Signatory designation"],
    ]
      .filter(([k]) => !String(p[k] ?? "").trim())
      .map(([, label]) => label);
    return {
      published: latest
        ? {
            id: latest.id,
            title: latest.title,
            versionLabel: latest.version_label,
            effectiveDate: latest.effective_date,
            createdAt: latest.created_at,
          }
        : null,
      title: latest?.title ?? MASTER_AGREEMENT_TITLE,
      body: latest?.body ?? DEFAULT_MASTER_AGREEMENT_BODY,
      supplierMissing,
    };
  });

/** Publishes the master agreement (a new version). Every company sees it filled with its own
 *  details and must sign the new version; earlier signatures stay on the earlier version. */
export const publishMasterAgreement = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        title: z.string().trim().min(1).max(200),
        versionLabel: z.string().trim().max(40).optional(),
        effectiveDate: daySchema,
        body: z.string().trim().min(50).max(100_000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    // Every {{blank}} must be one SamvadX knows, or companies would sign a literal "{{typo}}".
    const probe = fillTemplate(
      data.body,
      templateValueMap({
        companyName: "",
        companyLegalName: "",
        companyGstin: null,
        companyAddress: "",
        supplierLegalName: "",
        effectiveDate: "",
        today: "",
        prices: { setupLines: [], monthlyLines: [], perSeatFee: 0, paymentTermsDays: null },
        paymentTermsDays: 0,
        agentSeatLimit: null,
        managerSeatLimit: null,
        insightsPrices: [],
      }),
    );
    if (probe.unknown.length) {
      throw new Error(
        `Unknown blanks: ${probe.unknown.map((u) => `{{${u}}}`).join(", ")} — fix or remove them`,
      );
    }
    const { data: row, error } = await contractsDb()
      .from("contract_documents")
      .insert({
        client_id: null,
        title: data.title,
        version_label: data.versionLabel || null,
        effective_date: data.effectiveDate,
        body: data.body,
        created_by: caller.superadminId,
      })
      .select("id")
      .single();
    if (error || !row) throw appError("SX-4316", "Could not publish the agreement.", error);
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "master_agreement_published",
      clientId: null,
      summary: `Published "${data.title}"${data.versionLabel ? ` (${data.versionLabel})` : ""} for every company`,
      detail: { documentId: (row as { id: string }).id },
    });
    return { id: (row as { id: string }).id };
  });

// ── Send, view, sign a document ─────────────────────────────────────────────

/**
 * Emails a company its agreement (or the platform terms) with a link to read and sign it in
 * SamvadX. Through Resend when set up; otherwise returns a mailto: that opens the superadmin's
 * own mail app with the email written. Recorded as sent either way (with how).
 */
export const sendContractDocument = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        documentId: idSchema,
        clientId: idSchema,
        to: z.string().trim().email().max(254),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireSuperadmin(data.accessToken);
    const [{ data: docRow }, { data: client }] = await Promise.all([
      contractsDb()
        .from("contract_documents")
        .select("client_id, title, effective_date")
        .eq("id", data.documentId)
        .maybeSingle(),
      db().from("clients").select("company_name, subdomain").eq("id", data.clientId).maybeSingle(),
    ]);
    const doc = docRow as {
      client_id: string | null;
      title: string;
      effective_date: string;
    } | null;
    if (!doc || (doc.client_id !== null && doc.client_id !== data.clientId)) {
      throw new Error("That document isn't for this company");
    }
    if (!client) throw new Error("That company wasn't found");
    const link = companyAppLink(client.subdomain, "/admin/billing", {
      tab: "agreements",
      doc: data.documentId,
    });
    const email = agreementEmail(
      { title: doc.title, effectiveDate: doc.effective_date },
      client.company_name,
      link,
    );
    let via: "resend" | "mail_app" = "mail_app";
    let mailto: string | null = null;
    if (emailConfigured()) {
      const sent = await sendEmails([{ to: data.to, ...email }]);
      if (!sent) throw new Error("The email service didn't accept it — try again in a minute");
      via = "resend";
    } else {
      mailto = mailtoLink(data.to, email);
    }
    const { error } = await contractsDb().from("contract_document_status").upsert(
      {
        document_id: data.documentId,
        client_id: data.clientId,
        sent_at: new Date().toISOString(),
        sent_to: data.to,
        sent_via: via,
      },
      { onConflict: "document_id,client_id" },
    );
    if (error) throw appError("SX-4317", "Could not record the send.", error);
    await logSuperadminActivity({
      superadminId: caller.superadminId,
      action: "contract_sent",
      clientId: data.clientId,
      summary: `${via === "resend" ? "Emailed" : "Opened an email for"} "${doc.title}" to ${data.to}`,
      detail: { documentId: data.documentId, to: data.to, via },
    });
    return { via, mailto };
  });

/** A company admin signs a document for their company: ticks "I agree" and types their name.
 *  Recorded once per company and document, like a change acceptance. */
export const signContractDocument = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        documentId: idSchema,
        fullName: z.string().trim().min(2).max(200),
        confirm: z.literal(true),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCompanyAdmin(data.accessToken);
    const [{ data: docRow }, { data: me }] = await Promise.all([
      contractsDb()
        .from("contract_documents")
        .select("client_id, body")
        .eq("id", data.documentId)
        .maybeSingle(),
      db().from("agents").select("email").eq("id", caller.agentId!).maybeSingle(),
    ]);
    const doc = docRow as { client_id: string | null; body: string | null } | null;
    if (!doc || (doc.client_id !== null && doc.client_id !== caller.clientId)) {
      throw new Error("That document wasn't found");
    }
    const { data: existing } = await contractsDb()
      .from("contract_document_status")
      .select("signed_at, signed_name, viewed_at")
      .eq("document_id", data.documentId)
      .eq("client_id", caller.clientId)
      .maybeSingle();
    const prior = existing as {
      signed_at: string | null;
      signed_name: string | null;
      viewed_at: string | null;
    } | null;
    if (prior?.signed_at) throw new Error(`Already signed by ${prior.signed_name}`);
    const now = new Date().toISOString();
    // Freeze exactly what they signed: both parties' details as they are today, plus their name
    // and the date — a later rename of either company never changes a signed agreement.
    const signedBody = doc.body?.includes("{{")
      ? fillTemplate(
          doc.body,
          await templateValuesFor(caller.clientId, null, {
            by: data.fullName,
            date: todayIstKey(),
          }),
        ).text
      : null;
    const { error } = await contractsDb()
      .from("contract_document_status")
      .upsert(
        {
          document_id: data.documentId,
          client_id: caller.clientId,
          signed_body: signedBody,
          // Keep the first time it was opened; signing without opening counts as viewing.
          viewed_at: prior?.viewed_at ?? now,
          // Signing without an earlier recorded view: the signer is also the first viewer.
          ...(prior?.viewed_at ? {} : { viewed_by_agent: caller.agentId }),
          signed_at: now,
          signed_name: data.fullName,
          signed_email: (me as { email: string } | null)?.email ?? "",
          signed_agent_id: caller.agentId,
        },
        { onConflict: "document_id,client_id", ignoreDuplicates: false },
      );
    if (error) throw appError("SX-4318", "Could not record your signature.", error);
    return { ok: true };
  });
